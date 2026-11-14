import Store from 'electron-store'
import { attachReadCache } from './store-cache'
import { attachSidecars } from './store-sidecars'
import fs from 'fs'
import os from 'os'
import { isDeepStrictEqual } from 'util'
import { DEFAULT_LOOP_SETTINGS, emptyLoopState } from './loop-policy'
import { defaultPaths, findRepoRoot, formerDefaults, planPathFixes, type AppPaths } from './app-paths'
import type { LoopSettings, LoopState, BreakerState } from '../src/types'

// This checkout's jobscan binary, automator and home (see app-paths.ts).
const PATHS = defaultPaths({ platform: process.platform, startDir: __dirname, exists: fs.existsSync, homedir: os.homedir() })

interface StoreSchema {
  resumeText?: string
  resumePath?: string
  ratingAgents: number
  payloadAgents: number
  aiEngine?: string             // 'codex' (default) | 'claude' — which engine answers the AI calls (ai-engine.ts)
  claudeModel?: string          // '' = Claude Code's default; e.g. 'sonnet', 'opus', 'haiku'
  claudePath?: string           // optional: the Claude Code binary, when it is not found on its own
  harnessEnabled?: boolean      // "Let Claude Code drive JobScan" (harness.ts), off by default
  codexModel: string            // '' = Auto — codex default / first-listed model
  codexAutoUpdate: boolean      // keep the Codex CLI current (default true)
  codexManagedVersion: string   // last version health-checked into userData
  codexUpdateCheckedAt: string  // ISO — throttles the registry check to once a day
  codexRejectedVersions?: string[]  // Codex versions found not to speak this app's protocol: never used again
  jobscanExePath: string
  pythonDir: string
  jobAutomatorHome: string
  imapConfigured: boolean
  appState: string
  // Bulk keys: kept beside config.json, not in it (see store-sidecars.ts).
  candidates?: unknown[]
  ratedJobs?: unknown[]
  selectedJobIds: string[]
  queryList: unknown[]
  // User profile
  profileTargetLocations: string
  profileVisaSituation: string        // free text — "I am on OPT", "US citizen", etc.
  profileCitizenship: string          // free text — the country/countries the candidate
                                      // holds citizenship of. Separate from work
                                      // authorization: authorized != citizen.
  profileSponsorshipNeed: string      // 'no-sponsorship' | 'future-sponsorship' | 'need-sponsorship'
  profileClearance: string            // 'yes' | 'no-eligible' | 'no-ineligible'
  profileEeoGender: string
  profileEeoRace: string
  profileEeoVeteran: string
  profileEeoDisability: string
  profileSalaryExpectation: string
  profileGenerateCoverLetter: boolean
  profileSearchInstructions: string
  lastFetchAt: string
  doneSummary: unknown[]
  appliedJobIds: string[]
  // Rehydration snapshots (back-nav re-shows last results without re-running)
  queryGenResults: unknown[]
  extractResults: unknown[]
  // Input-hash gates (skip re-run when inputs unchanged)
  queryGenInputHash: string
  ratingInputHash: string
  extractInputHash: string
  payloadInputHash: string
  // Loop mode: what the stored ratings were made under (resume, profile block,
  // model, prompt revision), and what the saved searches were generated from.
  // '' = unknown (saved before loop mode existed).
  ratingFingerprint: string
  queryListInputsHash: string
  // Loop mode. Never named automation*: REMOVED_KEYS in main.ts deletes those
  // at every boot. Settings and state are per profile; the CAPTCHA breaker is
  // machine-wide, because CAPTCHAs follow the browser and network.
  loopSettings: LoopSettings
  loopState: LoopState
  loopBreaker: BreakerState
  // Applied-jobs log (richer than appliedJobIds — for AppliedJobsPanel)
  appliedJobsLog: unknown[]
  // Per-job board cards, projected from pipeline events. Persisted so
  // closing the app mid-run does not lose the board.
  boardCards: Record<string, unknown>
  lastFetchDurationSec: number            // duration of last successful rebuild — "usually takes ~Xm" hint
  // Local profiles (personas): the ACTIVE profile's values live in the flat
  // keys above; snapshots hold the others. See electron/profiles.ts.
  profilesList: Array<{ id: string; name: string; createdAt: string }>
  activeProfileId: string
  // Each profile's own values, applied history included. Kept in config.json:
  // nothing can rebuild them.
  profileSnapshots: Record<string, Record<string, unknown>>
  // Bulk key: the other profiles' job pools (candidates, ratedJobs), by
  // profile id -- kept beside config.json, like the active pools.
  profilePools?: Record<string, Record<string, unknown>>
  // The path defaults this app filled in itself, so a moved checkout is
  // followed while a path you chose is never touched (see app-paths.ts).
  autoPaths?: Partial<AppPaths>
  // The profile the flat pools belong to; '' while a switch writes them.
  // Absent (an older build): the active profile's. See profiles.ts.
  poolsOwner?: string
}

/**
 * The bulk keys and their defaults. NOT in the store's `defaults` below: conf
 * writes defaults into config.json at every start, and these must never be
 * written there.
 */
const BULK_KEYS = { candidates: [], ratedJobs: [], profilePools: {} }

const store = new Store<StoreSchema>({
  defaults: {
    ratingAgents: 5,
    payloadAgents: 6,
    codexModel: '',
    codexAutoUpdate: true,
    codexManagedVersion: '',
    codexUpdateCheckedAt: '',
    jobscanExePath: PATHS.jobscanExePath,
    pythonDir: PATHS.pythonDir,
    jobAutomatorHome: PATHS.jobAutomatorHome,
    imapConfigured: false,
    appState: 'auth',
    selectedJobIds: [],
    queryList: [],
    profileTargetLocations: '',
    profileVisaSituation: '',
    profileCitizenship: '',
    profileSponsorshipNeed: '',
    profileClearance: '',
    profileEeoGender: '',
    profileEeoRace: '',
    profileEeoVeteran: '',
    profileEeoDisability: '',
    profileSalaryExpectation: '',
    profileGenerateCoverLetter: false,
    profileSearchInstructions: '',
    lastFetchAt: '',
    doneSummary: [],
    appliedJobIds: [],
    queryGenResults: [],
    extractResults: [],
    queryGenInputHash: '',
    ratingInputHash: '',
    extractInputHash: '',
    payloadInputHash: '',
    ratingFingerprint: '',
    queryListInputsHash: '',
    loopSettings: DEFAULT_LOOP_SETTINGS,
    loopState: emptyLoopState(),
    loopBreaker: {},
    appliedJobsLog: [],
    boardCards: {},
    lastFetchDurationSec: 0,
    profilesList: [],
    activeProfileId: '',
    profileSnapshots: {},
  },
})
// One parse per change on disk, not one per access. See store-cache.ts.
attachReadCache(store)
// The job pools live beside config.json, so a write no longer rewrites them.
// See store-sidecars.ts. The other profiles' pools are read only on a profile
// switch: kept on disk, not parsed in memory, so the main process's heap --
// and every full garbage collection over it -- stays small. The profile
// snapshots were side data in an earlier build; they come back into
// config.json.
attachSidecars(store as never, {
  keys: BULK_KEYS, uncached: ['profilePools'], retired: { profileSnapshots: {} },
})

// An old built-in default (a fixed F:\ checkout path) or a moved checkout is
// replaced with this checkout's paths; a path set in Settings never is. Only
// when running from a checkout: a packaged app's fallback paths are not wired.
if (findRepoRoot(process.platform, __dirname, fs.existsSync)) {
  const auto = ((store.get('autoPaths') as Partial<AppPaths> | undefined) ?? {})
  const plan = planPathFixes({
    stored: { jobscanExePath: store.get('jobscanExePath'), pythonDir: store.get('pythonDir'), jobAutomatorHome: store.get('jobAutomatorHome') },
    auto, defaults: PATHS, former: formerDefaults(process.platform, os.homedir()), exists: fs.existsSync,
  })
  if (Object.keys(plan.set).length > 0) {
    store.set(plan.set as never)
    console.log('[paths] pointed at this checkout:', JSON.stringify(plan.set))
  }
  if (!isDeepStrictEqual(plan.auto, auto)) store.set('autoPaths', plan.auto as never)
}

/**
 * A stored value WITHOUT a copy, for code that only counts or scans it.
 * store.get copies every value it hands out; for the 3.3 MB pools that copy
 * is garbage the main process must collect, and collecting it froze the
 * window. Never change what this returns.
 */
export function peek<T = unknown>(key: string): T | undefined {
  return (store as unknown as { peek(k: string): unknown }).peek(key) as T | undefined
}

export default store
