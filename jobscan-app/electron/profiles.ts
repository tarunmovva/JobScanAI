import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import store from './state-store'
import { isPipelineActive, setState, ratingEngineCancel } from './pipeline'
import type { ProfileInfo } from '../src/types'

// ── Local profiles (personas) ────────────────────────────────────────────────
//
// Same person, different personas: each profile bundles a resume + application
// strategy + its own pipeline state. The ACTIVE profile's values live in the
// existing flat store keys — every read site (pipeline, prompts, IPC)
// stays untouched. Switching = save flat keys into the outgoing
// profile's snapshot, then write the incoming snapshot over the flat keys.
//
// Profiles are FULLY isolated spaces (per user choice): resume, answers,
// pipeline state, applied-job history and OTP email all belong to a profile.
// Consequence (explicitly accepted): one profile can re-apply to a job
// another profile already submitted to — there is no cross-profile dedupe.
// Still shared (machine facts): jobs DB + lastFetchAt/lastFetchDurationSec,
// jobscanExePath/pythonDir/jobAutomatorHome, ratingAgents/payloadAgents,
// appState, profiles meta.

const PROFILE_KEYS = [
  // Resume
  'resumeText', 'resumePath',
  // Application profile / answers
  'profileTargetLocations', 'profileVisaSituation', 'profileCitizenship', 'profileSponsorshipNeed',
  'profileClearance', 'profileSalaryExpectation', 'profileSearchInstructions',
  'profileGenerateCoverLetter',
  'profileEeoGender', 'profileEeoRace', 'profileEeoVeteran', 'profileEeoDisability',
  // Strategy knobs
  'codexModel',
  // Pipeline state + skip-if-clean hashes (swap together with their inputs)
  'queryList', 'queryGenResults', 'queryGenInputHash', 'queryListInputsHash',
  'candidates',
  'ratedJobs', 'ratingInputHash', 'ratingFingerprint',
  'selectedJobIds', 'extractResults', 'extractInputHash',
  'payloadInputHash', 'doneSummary',
  // Applied-job history — per profile (no cross-profile dedupe, by choice)
  'appliedJobIds', 'appliedJobsLog',
  // The board is per-run and per-persona, like the history it comes from.
  'boardCards',
  // Loop mode's settings, exclusions, attempts and rounds belong to the
  // persona whose resume they apply. (The CAPTCHA breaker, loopBreaker, is
  // machine-wide and stays out.)
  'loopSettings', 'loopState',
  // OTP email — the imap_config.json file swaps via sidecars (see below)
  'imapConfigured',
] as const

type Snapshot = Record<string, unknown>

/**
 * The job pools: most of a profile's bytes (~3.3 MB each on a real config),
 * and rebuildable -- a search and a rating. Snapshots live in config.json,
 * which every store write rewrites, so the pools are not in them: each
 * profile's pools are kept beside config.json in `profilePools` (see
 * store-sidecars.ts), saved when the profile is switched away from and
 * restored when it is switched to.
 */
const POOL_KEYS: ReadonlySet<string> = new Set(['candidates', 'ratedJobs'])
type Pools = Record<string, unknown>

/**
 * The profile the flat pools belong to. The pools live in their own files,
 * so a switch cannot write them in the same write as the rest: it clears
 * this first, writes the pools, then names the new owner. A boot that finds
 * it naming anyone but the active profile -- a switch cut off between its
 * writes -- puts the active profile's own pools back: never another
 * profile's, which would apply this resume to jobs rated for another's.
 */
const POOLS_OWNER = 'poolsOwner'

function getProfilesList(): ProfileInfo[] {
  return ((store.get('profilesList') as ProfileInfo[] | undefined) ?? []).slice()
}

function getSnapshots(): Record<string, Snapshot> {
  return { ...((store.get('profileSnapshots') as Record<string, Snapshot> | undefined) ?? {}) }
}

function getPools(): Record<string, Pools> {
  return { ...((store.get('profilePools') as Record<string, Pools> | undefined) ?? {}) }
}

function captureFlatKeys(): Snapshot {
  const snap: Snapshot = {}
  for (const key of PROFILE_KEYS) {
    if (POOL_KEYS.has(key)) continue
    const v = store.get(key as never)
    if (v !== undefined) snap[key] = v
  }
  return snap
}

// ── OTP email (IMAP) sidecars ────────────────────────────────────────────────
//
// The Go filler reads ONE canonical file: {jobAutomatorHome}/secrets/
// imap_config.json. Per-profile OTP uses the same materialization pattern as
// the flat store keys: the canonical file always holds the ACTIVE profile's
// creds; each profile's copy lives in a sidecar swapped on switch.

function imapLivePath(): string {
  return path.join((store.get('jobAutomatorHome') as string) ?? '', 'secrets', 'imap_config.json')
}

function imapSidecarPath(id: string): string {
  return path.join((store.get('jobAutomatorHome') as string) ?? '', 'secrets', 'profiles', `${id}.imap.json`)
}

// Capture the live IMAP file into the active profile's sidecar (or clear a
// stale sidecar when the live file was removed).
function syncActiveImap(): void {
  const activeId = (store.get('activeProfileId') as string) ?? ''
  if (!activeId) return
  try {
    const live = imapLivePath()
    const sidecar = imapSidecarPath(activeId)
    if (fs.existsSync(live)) {
      fs.mkdirSync(path.dirname(sidecar), { recursive: true })
      fs.copyFileSync(live, sidecar)
    } else {
      fs.rmSync(sidecar, { force: true })
    }
  } catch (e) {
    console.error('[profiles] imap sync failed:', String(e).slice(0, 120))
  }
}

// Materialize the incoming profile's sidecar as the live file (or remove the
// live file when the profile has no OTP configured).
function applyImap(id: string): void {
  try {
    const live = imapLivePath()
    const sidecar = imapSidecarPath(id)
    if (fs.existsSync(sidecar)) {
      fs.mkdirSync(path.dirname(live), { recursive: true })
      fs.copyFileSync(sidecar, live)
    } else {
      fs.rmSync(live, { force: true })
    }
  } catch (e) {
    console.error('[profiles] imap apply failed:', String(e).slice(0, 120))
  }
}

// Copy the current flat-key values into the active profile's snapshot.
// Flat keys are authoritative for the active profile; this runs at boot
// (crash-heal), before every switch/create, and at quit.
export function syncActiveSnapshot(): void {
  const activeId = (store.get('activeProfileId') as string) ?? ''
  if (!activeId) return
  const snapshots = getSnapshots()
  snapshots[activeId] = captureFlatKeys()
  store.set('profileSnapshots', snapshots as never)
  syncActiveImap()
}

// A profile's pools over the flat pools. A snapshot holds pools of its own
// only when an older build wrote it, and then it was written after anything
// this build kept for that profile. None at all: empty pools.
function applyPools(snap: Snapshot, pools: Pools | undefined): void {
  for (const key of POOL_KEYS) {
    const v = snap[key] !== undefined ? snap[key] : pools?.[key]
    if (v === undefined) store.delete(key as never)
    else store.set(key as never, v as never)
  }
}

// Make profile `id` the active one: its snapshot's values over the flat
// keys. Missing keys (snapshot from an older schema) are removed so
// electron-store falls back to defaults — never leaves the previous
// profile's values behind. Everything in config.json -- every value, the
// active id, the pools' owner -- goes in ONE write: a crash can no longer
// leave the flat keys half one profile's, half another's. The pools follow.
function applySnapshot(id: string, snap: Snapshot, pools: Pools | undefined): void {
  const next: Record<string, unknown> = { ...(store.store as unknown as Record<string, unknown>) }
  for (const key of PROFILE_KEYS) {
    if (POOL_KEYS.has(key)) continue
    const v = snap[key]
    if (v === undefined) delete next[key]
    else next[key] = v
  }
  next.activeProfileId = id
  next[POOLS_OWNER] = ''
  ;(store as unknown as { store: Record<string, unknown> }).store = next
  applyPools(snap, pools)
  store.set(POOLS_OWNER as never, id as never)
}

// Boot: the flat pools must be the active profile's own (see POOLS_OWNER).
function healPools(activeId: string): void {
  const owner = store.get(POOLS_OWNER as never) as unknown as string | undefined
  if (owner === activeId) return
  if (owner !== undefined) {
    console.warn(`[profiles] the job pools did not belong to the active profile (a switch was cut off); restoring its own`)
    let own: Pools | undefined
    try {
      own = getPools()[activeId]
    } catch (e) {
      // Empty pools cost a search and a rating; another profile's cost far more.
      console.error('[profiles] could not read the saved job pools; starting the pools empty:', String(e).slice(0, 160))
    }
    applyPools(getSnapshots()[activeId] ?? {}, own)
  }
  store.set(POOLS_OWNER as never, activeId as never)
}

// Boot: first launch migrates current data into a "Default" profile; every
// launch re-syncs the active snapshot and heals a dangling activeProfileId.
export function ensureProfiles(): void {
  let list = getProfilesList()
  if (list.length === 0) {
    const id = randomUUID()
    list = [{ id, name: 'Default', createdAt: new Date().toISOString() }]
    store.set('profilesList', list as never)
    store.set('activeProfileId', id as never)
  }
  const activeId = (store.get('activeProfileId') as string) ?? ''
  if (!list.some(p => p.id === activeId)) {
    store.set('activeProfileId', list[0].id as never)
  }
  healPools((store.get('activeProfileId') as string) ?? '')
  syncActiveSnapshot()
}

export function listProfiles(): { profiles: ProfileInfo[]; activeId: string } {
  return {
    profiles: getProfilesList(),
    activeId: (store.get('activeProfileId') as string) ?? '',
  }
}

// New profile starts as a completely BLANK space — applySnapshot falls back
// to store defaults for every missing key, and no IMAP sidecar means no OTP
// email until the user configures one. Does NOT auto-switch.
export function createProfile(name: string): { ok: boolean; error?: string; id?: string } {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: 'Profile name is required.' }
  syncActiveSnapshot()
  const id = randomUUID()
  const list = getProfilesList()
  list.push({ id, name: trimmed, createdAt: new Date().toISOString() })
  const snapshots = getSnapshots()
  snapshots[id] = {}
  store.set('profilesList', list as never)
  store.set('profileSnapshots', snapshots as never)
  return { ok: true, id }
}

export async function switchProfile(id: string): Promise<{ ok: boolean; error?: string }> {
  const list = getProfilesList()
  const target = list.find(p => p.id === id)
  if (!target) return { ok: false, error: 'Profile not found.' }
  if (id === ((store.get('activeProfileId') as string) ?? '')) return { ok: true }
  if (isPipelineActive()) {
    return { ok: false, error: 'Finish or cancel the current run before switching profiles.' }
  }
  // Every profile gets a snapshot when it is created. One without is lost
  // data: started blank, it would have no applied history and could apply
  // again to every job it already applied to.
  if (!Object.prototype.hasOwnProperty.call(getSnapshots(), id)) {
    console.error(`[profiles] "${target.name}" (${id}) has no snapshot; not switching`)
    return { ok: false, error: `"${target.name}": its saved data is missing, so it was not switched to — it could apply again to jobs it already applied to.` }
  }

  // Background pre-rating of the outgoing profile's jobs must not outlive
  // the switch (it would persist ratings over the incoming profile's pool).
  ratingEngineCancel()

  syncActiveSnapshot()
  // The outgoing profile's pools, kept for when it comes back. A pools file
  // that cannot be read stops the switch here, before anything changed.
  const outgoing = (store.get('activeProfileId') as string) ?? ''
  let pools: Record<string, Pools>
  try {
    pools = getPools()
    if (outgoing) {
      const own: Pools = {}
      for (const key of POOL_KEYS) own[key] = store.get(key as never)
      pools[outgoing] = own
    }
  } catch (e) {
    console.error('[profiles] could not read the job pools:', String(e).slice(0, 160))
    return { ok: false, error: 'Could not read the saved job pools. Try again in a moment.' }
  }
  if (outgoing) store.set('profilePools', pools as never)
  applySnapshot(id, getSnapshots()[id] ?? {}, pools[id])
  applyImap(id)
  setState('resume')
  return { ok: true }
}

export function renameProfile(id: string, name: string): { ok: boolean; error?: string } {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: 'Profile name is required.' }
  const list = getProfilesList()
  const entry = list.find(p => p.id === id)
  if (!entry) return { ok: false, error: 'Profile not found.' }
  entry.name = trimmed
  store.set('profilesList', list as never)
  return { ok: true }
}

export function deleteProfile(id: string): { ok: boolean; error?: string } {
  const list = getProfilesList()
  if (!list.some(p => p.id === id)) return { ok: false, error: 'Profile not found.' }
  if (id === ((store.get('activeProfileId') as string) ?? '')) {
    return { ok: false, error: 'Switch to another profile first.' }
  }
  if (list.length <= 1) return { ok: false, error: 'At least one profile is required.' }
  store.set('profilesList', list.filter(p => p.id !== id) as never)
  const snapshots = getSnapshots()
  delete snapshots[id]
  store.set('profileSnapshots', snapshots as never)
  try {
    const pools = getPools()
    if (id in pools) { delete pools[id]; store.set('profilePools', pools as never) }
  } catch (e) {
    // Left behind, the deleted profile's pools are only unused bytes.
    console.error("[profiles] could not drop the deleted profile's job pools:", String(e).slice(0, 160))
  }
  try { fs.rmSync(imapSidecarPath(id), { force: true }) } catch { /* best effort */ }
  return { ok: true }
}
