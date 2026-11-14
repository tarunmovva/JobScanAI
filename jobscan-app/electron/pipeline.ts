import { BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import http from 'http'
import path from 'path'
import fsPromises from 'fs/promises'
import { createHash } from 'crypto'
import store, { peek } from './state-store'
import {
  runCli, cliSearch, cliSearchStrict, cliQueueJobs, cliExtract, cliClaim, cliDbExec,
  cliSubmit, getDbPath, cliDbQuery, automatorPython,
} from './cli-runner'
import {
  runCodexThread, parseJsonResponse, clearCodexClient,
  QUERY_GEN_SYSTEM, QUERY_GEN_DONE_ACK, QUERY_GEN_PROMPT_REV,
  RATING_SYSTEM, RATING_PROMPT_REV, RATING_DESCRIPTION_CHARS, payloadSystem, PAYLOAD_PROMPT_REV,
} from './codex-client'
import { buildAndWritePayload } from './payload-builder'
import {
  wasInterrupted, abandonSql, landingState, RUN_STATE_KEYS,
} from './interrupted-run'
import { jobContextSql, jobContextFromRows } from './job-context-sql'
import { appliedKeys, isApplied, jobKey } from './applied-jobs'
import { applyBoardEvent, seedCards, emptyBoard, waitingCards, cardsNotStarted, type Board, type JobRef } from './board-state'
import { shouldAgentExit, AGENT_POLL_MS } from './agent-loop'
import { summarizeFieldsForPrompt } from './field-summary'
import { needsYouReason } from './needs-you'
import { tokenizeQueryFlags } from './query-flags'
import { recordHeader } from './record-header'
import { killTree, collectChild, treeSpawnOptions, stopGently } from './proc'
import { resetSelectedSql, markSkippedSql, abandonOthersSql } from './queue-sql'
import { closeTabsFor } from './chrome-tabs'
import { getRunHooks, type HookJob, type HookResult, type HookView } from './run-mode'
import {
  carryForward, fingerprintMatches, ratingHealth, FILLER_TIMEOUT_MS, MIXED_FINGERPRINT,
} from './loop-policy'
import { mergeIntoPool, uniqueByKey, researchPool } from './pool'
import { failureShown, loopReport, submittedStatus } from './agent-result'
import { PLATFORM_ABBR, unextracted } from './selection'
import type { Job, RatedJob, ClaimedJob, AppState, FetchSnapshot } from '../src/types'

let _win: BrowserWindow | null = null

export function setPipelineWindow(w: BrowserWindow): void {
  _win = w
}

// ── Cancellation infrastructure ──────────────────────────────────────────────
//
// Pipelines run async, often spawn long-lived children (codex.exe, jobscan.exe).
// Back-navigation must abort cleanly. CancelToken carries the canceled flag plus
// a set of registered child processes so cancel can kill them all at once.

export interface CancelToken {
  canceled: boolean
  children: Set<ChildProcess>
  reason: string
}

let _activeToken: CancelToken | null = null

export function isPipelineActive(): boolean {
  return _activeToken !== null
}


export async function cancelActivePipeline(reason = 'user-back-nav'): Promise<void> {
  // Background pre-rating is not under the token — cancel it explicitly on
  // every pipeline-cancel path (back-nav, reset, logout, fetch-cancel).
  ratingEngineCancel()
  const t = _activeToken
  if (!t) return
  t.canceled = true
  t.reason = reason
  for (const c of t.children) { killTree(c) }
  push('pipeline:canceled', { reason })
  // Await codex shutdown so the next runCodexThread cannot race a still-alive
  // codex.exe holding the SQLite WAL — otherwise we hit SQLITE_BUSY and the
  // "Codex RPC timeout: initialize" bug returns under fast back→forward.
  try { await clearCodexClient() } catch { /* best effort */ }
}

async function withToken<T>(fn: (t: CancelToken) => Promise<T>): Promise<T | void> {
  if (_activeToken) {
    console.warn('[pipeline] start ignored — pipeline already active')
    return
  }
  const t: CancelToken = { canceled: false, children: new Set(), reason: '' }
  _activeToken = t
  try {
    return await fn(t)
  } catch (e) {
    if ((e as Error).message === '__canceled__') return  // swallow cancellation silently
    throw e
  } finally {
    _activeToken = null
    push('pipeline:idle', {})
  }
}

function checkpoint(t: CancelToken): void {
  if (t.canceled) throw new Error('__canceled__')
}

// ── Chrome CDP helper ─────────────────────────────────────────────────────────

function isChromeRunning(): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get('http://127.0.0.1:9222/json/version', res => {
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => { req.destroy(); resolve(false) })
  })
}

async function ensureChrome(): Promise<void> {
  if (await isChromeRunning()) return

  const profileDir = store.get('jobAutomatorHome') as string
  const chromeArgs = [
    '--remote-debugging-port=9222',
    `--user-data-dir=${path.join(profileDir, 'chrome-cdp-profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]

  const chromePaths = [
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA']
      ? path.join(process.env['LOCALAPPDATA']!, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : '',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env['HOME']
      ? path.join(process.env['HOME']!, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')
      : '',
    // Custom override — also read by browser_cdp.py
    process.env['JOB_AUTOMATOR_CHROME_PATH'] || '',
  ].filter(Boolean)

  for (const chromePath of chromePaths) {
    try {
      if (!require('fs').existsSync(chromePath)) continue
      const child = spawn(chromePath, chromeArgs, { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      // Wait for Chrome to start accepting connections
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1000))
        if (await isChromeRunning()) {
          console.log('[chrome] started at', chromePath)
          process.env['JOB_AUTOMATOR_CHROME_PATH'] = chromePath
          return
        }
      }
    } catch { /* try next path */ }
  }

  console.warn('[chrome] could not start Chrome automatically — form filling may fail')
}

// Channels the board projects from. Kept narrow so an unrelated event cannot
// churn the board or its persisted copy.
// extract:clear is deliberately NOT here. It fires inside runExtract, which
// now runs AFTER the board has been seeded at selection time -- routing it
// would empty To do a moment after filling it. seedBoard already starts from
// an empty board, so nothing else needs to clear it.
const BOARD_CHANNELS = new Set(['extract:start', 'extract:job', 'payload:progress'])

/** Fold one event into the persisted board. */
function projectToBoard(channel: string, data: unknown): void {
  if (!BOARD_CHANNELS.has(channel)) return
  try {
    const before = (store.get('boardCards') as Board | undefined) ?? emptyBoard()
    const after = applyBoardEvent(before, { type: channel, ...(data as object) })
    if (after !== before) store.set('boardCards', after as never)
  } catch (e) {
    // The board is a view. A projection bug must never take down a run that
    // is submitting real applications.
    console.error('[board] projection failed:', String(e).slice(0, 200))
  }
}

function push(channel: string, data: unknown): void {
  projectToBoard(channel, data)
  send(channel, data)
}

/** To the window only, without touching the board. */
export function send(channel: string, data: unknown): void {
  // Guard against the window being destroyed mid-shutdown — child process
  // close handlers fire AFTER before-quit closes the BrowserWindow, so naive
  // `_win?.webContents.send(...)` throws "Object has been destroyed" in main.
  if (!_win) return
  try {
    if (_win.isDestroyed()) return
    const wc = _win.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send(channel, data)
  } catch { /* window gone — swallow */ }
}

/**
 * Loop mode paused `platform` mid-round: its cards that no agent has started
 * on are skipped with `reason`. The jobs never reach an agent once their DB
 * rows are swept, so nothing else would ever move these cards. One board
 * write for all of them.
 */
export function markPlatformSkippedOnBoard(platform: string, reason: string): number {
  try {
    const before = (store.get('boardCards') as Board | undefined) ?? emptyBoard()
    const events = waitingCards(before, platform).map(c => ({
      platform: c.platform, jobId: c.jobId, company: c.company, title: c.title, applyUrl: c.applyUrl,
      state: 'failed', skipped: true, message: reason,
    }))
    if (events.length === 0) return 0
    let after = before
    for (const ev of events) after = applyBoardEvent(after, { type: 'payload:progress', ...ev })
    if (after !== before) store.set('boardCards', after as never)
    for (const ev of events) send('payload:progress', ev)
    return events.length
  } catch (e) {
    console.error('[board] skipping a paused platform failed:', String(e).slice(0, 200))
    return 0
  }
}

export function setState(state: AppState): void {
  store.set('appState', state)
  push('state:change', { state })
}

// ── Hash gating + downstream invalidation ─────────────────────────────────────
//
// Each pipeline stage caches a hash of its inputs. On re-entry (back→forward),
// if inputs unchanged AND output non-empty → skip the runner and just re-emit
// the existing results so the screen rehydrates. If inputs changed → wipe the
// stage output + downstream stages' outputs so re-run is clean.

function sha1(...parts: string[]): string {
  return createHash('sha1').update(parts.join('|')).digest('hex')
}

function getProfileForHash(): string {
  return JSON.stringify({
    targetLocations:    store.get('profileTargetLocations'),
    visaSituation:      store.get('profileVisaSituation'),
    sponsorshipNeed:    store.get('profileSponsorshipNeed'),
    clearance:          store.get('profileClearance'),
    salaryExpectation:  store.get('profileSalaryExpectation'),
    searchInstructions: store.get('profileSearchInstructions'),
    // In the hash so flipping the toggle invalidates cached payloads. The
    // prompt text for an OFF run is byte-identical to the previous revision,
    // so this is what re-runs rather than a PAYLOAD_PROMPT_REV bump, which
    // would force a needless re-run on every user who leaves it off.
    generateCoverLetter: store.get('profileGenerateCoverLetter'),
    eeoGender:          store.get('profileEeoGender'),
    eeoRace:            store.get('profileEeoRace'),
    eeoVeteran:         store.get('profileEeoVeteran'),
    eeoDisability:      store.get('profileEeoDisability'),
  })
}

// Codex-driven stages include the configured model in their input hash, so a
// model switch invalidates their cached output and the next run genuinely
// re-runs on the new model instead of replaying old-model results.
// (search/extract are CLI-only — no model in their hashes.)
function codexModelForHash(): string {
  return String(store.get('codexModel') ?? '')
}

export function queryGenHash(): string {
  return sha1(
    (store.get('resumeText') as string) ?? '',
    (store.get('profileTargetLocations') as string) ?? '',
    (store.get('profileSearchInstructions') as string) ?? '',
    codexModelForHash(),
    QUERY_GEN_PROMPT_REV,  // new prompt revision invalidates cached query lists
    (store.get('lastFetchAt') as string) ?? '',  // DB rebuild → fresh search (cascades downstream)
  )
}
/**
 * What the saved searches are generated from. Unlike queryGenHash this leaves
 * out lastFetchAt: the searches depend on the candidate, not on the day's
 * postings, so loop mode does not regenerate them on every rebuild.
 */
export function queryInputsHash(): string {
  return sha1(
    (store.get('resumeText') as string) ?? '',
    (store.get('profileTargetLocations') as string) ?? '',
    (store.get('profileSearchInstructions') as string) ?? '',
    codexModelForHash(),
    QUERY_GEN_PROMPT_REV,
  )
}

/**
 * What a rating depends on, apart from the job itself: the resume, the
 * profile block the rater is shown, the model and the prompt revision. A job
 * rated under the same fingerprint keeps its score from round to round.
 */
export function ratingFingerprint(resumeText: string, profileBlock: string, model: string): string {
  return sha1(resumeText, profileBlock, model, RATING_PROMPT_REV)
}

function currentRatingFingerprint(): string {
  return ratingFingerprint((store.get('resumeText') as string) ?? '', raterProfileBlock(), codexModelForHash())
}

export function ratingHash():  string {
  // Candidate IDENTITY only (sorted): descriptions are frozen into the pool
  // at search time, and any pool replacement wipes this cache via
  // invalidation first — so identities are the correct (and cheap) key.
  // Concurrency knobs (ratingAgents) deliberately excluded: they change
  // speed, not output.
  const ids = (peek<Job[]>('candidates') ?? []).map(j => `${j.platform}:${j.job_id}`).sort()
  return sha1(
    JSON.stringify(ids),
    (store.get('resumeText') as string) ?? '',
    codexModelForHash(),
    RATING_PROMPT_REV,
  )
}
export function extractHash(): string {
  // Sorted selection (click order must not bust the cache) + DB generation
  // (cached form extractions shouldn't outlive a rebuild — forms change).
  const ids = [...(((store.get('selectedJobIds') as unknown as string[]) ?? []))].sort()
  return sha1(JSON.stringify(ids), (store.get('lastFetchAt') as string) ?? '')
}
export function payloadHash(): string {
  return sha1(
    JSON.stringify(store.get('selectedJobIds')),
    (store.get('resumeText') as string) ?? '',
    getProfileForHash(),
    codexModelForHash(),
    PAYLOAD_PROMPT_REV,
  )
}

// Wipe stage output + hash, recursively for all stages after `stage`.
// Used when an earlier stage's inputs change so downstream cache is invalidated.
// Cache stages, not screens. Extraction and filling produce separate cached
// outputs that invalidate independently, so they stay distinct here even
// though the user sees one board.
type CacheStage = 'query_gen' | 'rating' | 'extract' | 'payload'
const STAGE_ORDER: CacheStage[] = ['query_gen', 'rating', 'extract', 'payload']

function invalidateStage(stage: CacheStage): void {
  if (stage === 'query_gen')   { store.set('queryList', [] as never);       store.set('queryGenResults', [] as never); store.set('queryGenInputHash', ''); store.set('candidates', [] as never) }
  if (stage === 'rating')      { store.set('ratedJobs', [] as never);                                                  store.set('ratingInputHash', '') }
  if (stage === 'extract')     { store.set('extractResults', [] as never);                                             store.set('extractInputHash', '') }
  if (stage === 'payload')     { store.set('doneSummary', [] as never);                                                store.set('payloadInputHash', '') }
}

export function invalidateDownstream(after: AppState): void {
  const idx = STAGE_ORDER.indexOf(after as CacheStage)
  if (idx === -1) return
  for (let i = idx + 1; i < STAGE_ORDER.length; i++) invalidateStage(STAGE_ORDER[i])
}

function invalidateFrom(stage: CacheStage): void {
  const idx = STAGE_ORDER.indexOf(stage)
  if (idx === -1) return
  for (let i = idx; i < STAGE_ORDER.length; i++) invalidateStage(STAGE_ORDER[i])
}

// ─── Phase 3: Find Jobs (query generation + immediate search, one step) ──────

interface QueryEntry { name: string; flags: string; description: string; count: number | null }
interface QuerySnapshotEntry { index: number; query: QueryEntry; found?: number; totalAfter?: number }
interface GenState {
  entries: QuerySnapshotEntry[]   // per-card rehydrate snapshot
  queries: QueryEntry[]           // validated query list
  candidates: Job[]               // deduped pool across all queries
  seen: Set<string>               // platform:job_id dedupe keys
  error?: string                  // the Codex error that ended generation early, if one did
}

// Generate queries one at a time and RUN each one the moment it validates —
// the search is local SQLite, so results pool up while the model writes the
// next query. Used by the initial run (min 5 / max 10) and by user-targeted
// "find more" asks (min 1 / max 3, with a USER REQUEST context block).
/**
 * How many unique jobs one run is allowed to pool.
 *
 * This is a budget, not a goal. Every pooled job is read and scored by the
 * rating model, so the pool size IS the rating bill. Past this point another
 * query buys marginal candidates at full token price, and the run is choosing
 * ~50 jobs to apply to out of whatever it has.
 *
 * A user-targeted "find more" ask is exempt: they asked for something specific
 * and a full pool must not silently swallow the request.
 */
// selectedJobIds encode the platform as a two-letter abbreviation in their
// first segment. Defined once: three separate copies of this map is how the
// second segment came to be misread as the platform.
// Set once extraction can produce no further work -- on success, on failure
// and on cancel alike. Agents poll while it is false, so leaving it unset
// after a thrown extraction would hang every agent with no error surfaced.
let extractionComplete = false

const POOL_TARGET = 500

/** Waits before retrying an extract command that exited with an error. */
const EXTRACT_RETRY_MS = [2_000, 6_000]

/**
 * A query matching fewer than this is not worth a pool slot: it costs a full
 * generation turn and contributes a rounding error to a 500-job budget.
 *
 * Observed with a "only lever" search instruction, which restricts the corpus to
 * 17% of the database: the model kept ANDing toward the ~200 match target and
 * produced six queries in a row matching 2, 4, 6, 7, 9 and 16 jobs -- a 217-job
 * pool against a 500 budget, on a run whose instruction said "search broadly".
 *
 * Worth exactly ONE retry. If the corpus genuinely cannot do better -- a narrow
 * platform, a small market -- a thin slice beats no slice, so the second answer
 * is accepted whatever it matches.
 */
const MIN_QUERY_MATCHES = 40
// How many slots may be abandoned before the run stops. A model failing this
// many in a row is failing systematically, and each abandoned slot has
// already cost four codex calls.
const MAX_ABANDONED_SLOTS = 3

async function generateAndSearch(
  t: CancelToken,
  gen: GenState,
  opts: { min: number; max: number; userAsk?: string }
): Promise<void> {
  const resumeText          = (store.get('resumeText') as string | undefined) ?? ''
  const locations           = (store.get('profileTargetLocations') as string | undefined) ?? ''
  const searchInstructions  = (store.get('profileSearchInstructions') as string | undefined) ?? ''

  let added = 0
  let retryCtx = ''
  let retries = 0
  let narrowRetried = false
  // The slot being generated. Tracked separately from gen.entries.length so a
  // slot the model cannot get right can be abandoned and the run carry on --
  // exhausting the retries used to `break` the whole loop, ending generation
  // silently and short of opts.min because of one stubborn query.
  let slot = 0
  let abandoned = 0

  // Give up on a slot without giving up on the run. Bounded, because a model
  // failing every slot is failing systematically and should stop, not burn
  // four codex calls per slot forever.
  const abandonSlot = (index: number, why: string): boolean => {
    retries = 0
    retryCtx = ''
    narrowRetried = false
    slot++
    abandoned++
    push('queryGen:error', { index, error: `Gave up after 4 attempts: ${why}` })
    console.warn(`[query-gen] abandoned slot ${index}: ${why}`)
    return abandoned >= MAX_ABANDONED_SLOTS
  }

  while (added < opts.max) {
    if (!opts.userAsk && gen.candidates.length >= POOL_TARGET) break
    checkpoint(t)
    const idx = slot
    push('queryGen:generating', { index: idx })

    // Report what each query actually CONTRIBUTED, not just what it matched.
    // cliSearch caps every query at the top 100 by relevance, so a query
    // reporting 5,000 matches still adds at most 100 — and adds ZERO if those
    // 100 were already pooled by an earlier slice. Showing only the raw count
    // let the model believe a huge overlapping query was doing work.
    // Numbered from the entries themselves rather than cross-referenced by
    // index. The old form looked contributions up with the position in
    // gen.queries against a map keyed by entry.index, which agreed only while
    // slots could never be skipped. They can now, and a mismatch would silently
    // drop the "added N NEW jobs" line the model uses to judge its own work.
    const prevCtx = gen.entries.length > 0
      ? `PREVIOUSLY GENERATED (${gen.entries.length} so far):\n${gen.entries.map((e, i) => {
          const newJobs = e.found
          const contribution = newJobs === undefined
            ? ''
            : ` → added ${newJobs} NEW job${newJobs === 1 ? '' : 's'} to the pool`
          return `${i + 1}. ${e.query.name}: ${e.query.flags} — ~${e.query.count ?? '?'} matches${contribution} — ${e.query.description}`
        }).join('\n')}`
      : 'No queries generated yet.'

    const matchSum = gen.queries.reduce((s, q) => s + (q.count ?? 0), 0)
    const remaining = Math.max(0, POOL_TARGET - gen.candidates.length)
    const poolHint = gen.queries.length > 0
      ? ` Combined matches so far ≈ ${matchSum} (pre-dedupe); ${gen.candidates.length} unique jobs pooled`
        + (opts.userAsk ? '.' : ` of the ${POOL_TARGET} budget — about ${remaining} slots left.`)
        + ' Only the top 100 by relevance enter the pool per query, so pool size grows from DISTINCT slices, not from bigger match counts.'
      : ''
    const stopHint = added >= opts.min
      ? `You have generated ${added} ${opts.userAsk ? 'queries for this request' : 'queries'} (minimum ${opts.min} reached).${poolHint} Respond QUERIES_DONE to stop, or generate one more query (max ${opts.max}${opts.userAsk ? ' for this request' : ''}).`
      : `Generate query #${idx + 1}. You need at least ${opts.min} before stopping.${poolHint}`

    const userMsg = [
      `RESUME:\n${resumeText}`,
      `TARGET LOCATIONS: ${locations || 'not specified'}`,
      searchInstructions ? `SEARCH INSTRUCTIONS (follow precisely):\n${searchInstructions}` : '',
      opts.userAsk ? `USER REQUEST (targeted — generate 1-${opts.max} queries ONLY for this, distinct from every previous query):\n${opts.userAsk}` : '',
      prevCtx,
      retryCtx ? `VALIDATION ERROR ON LAST RESPONSE: ${retryCtx}\nPlease regenerate that same query correctly.` : '',
      stopHint,
    ].filter(Boolean).join('\n\n')

    let streaming = ''
    let raw = ''
    try {
      raw = await runCodexThread(QUERY_GEN_SYSTEM, userMsg, (tok) => {
        streaming += tok
        push('queryGen:streaming', { index: idx, text: streaming })
      })
    } catch (e) {
      if (t.canceled) throw new Error('__canceled__')
      gen.error = String(e)
      push('queryGen:error', { index: idx, error: String(e) })
      break
    }
    checkpoint(t)

    // Done signal
    if (raw.trim() === QUERY_GEN_DONE_ACK || raw.includes(QUERY_GEN_DONE_ACK)) {
      break
    }

    // Parse
    const parsed = parseJsonResponse<{ name: string; flags: string; description?: string }>(raw)
    if (!parsed?.name || !parsed?.flags) {
      retryCtx = `Not valid JSON {name,flags,description}. Got: ${raw.slice(0, 80)}`
      push('queryGen:invalid', { index: idx, error: 'Bad format — retrying', retrying: true })
      if (++retries > 3) { if (abandonSlot(idx, 'invalid JSON')) break }
      continue
    }

    // Validate flags against jobscan CLI (also returns the live match count)
    const { error: flagErr, count } = await validateQueryFlags(parsed.flags, t)
    if (flagErr) {
      retryCtx = flagErr
      push('queryGen:invalid', { index: idx, error: flagErr, retrying: true })
      if (++retries > 3) { if (abandonSlot(idx, 'flags rejected by the CLI')) break }
      continue
    }

    // Syntactically valid but matches nothing — a wasted slot; ask for a broader take
    if (count === 0) {
      retryCtx = 'Query parsed but matched 0 jobs. Broaden it: fewer AND constraints, more OR synonyms, wider market, or drop --since.'
      push('queryGen:invalid', { index: idx, error: 'Matched 0 jobs — broadening', retrying: true })
      if (++retries > 3) { if (abandonSlot(idx, 'every attempt matched 0 jobs')) break }
      continue
    }

    // Too narrow to earn its slot. One chance to widen, then take what we get.
    if (count !== null && count < MIN_QUERY_MATCHES && !narrowRetried) {
      narrowRetried = true
      retryCtx = `That query matched only ${count} jobs — too narrow to be worth one of the ${opts.max} slots. `
        + 'Widen it: drop an AND clause, remove a seniority exclusion, drop --since, or widen the market. '
        + 'Aim for roughly 100-300 matches.'
      push('queryGen:invalid', { index: idx, error: `Only ${count} matches — widening`, retrying: true })
      continue
    }

    // Valid — announce the card, then run the query immediately
    retries = 0
    narrowRetried = false
    retryCtx = ''
    const entry: QueryEntry = { name: parsed.name, flags: parsed.flags, description: parsed.description ?? '', count }
    gen.queries.push(entry)
    push('queryGen:valid', { index: idx, query: entry })

    const results = await cliSearch(entry.flags, t) as Job[]
    checkpoint(t)
    // Read once per query, not per job: the set is rebuilt from two store
    // reads and the merge runs over every result of every query.
    const spent = appliedKeys()
    // Applied jobs are filtered BEFORE the pool, not after, for two reasons:
    // the rating agent never pays tokens to score a job that cannot be
    // applied to, and POOL_TARGET keeps its meaning -- the loop below
    // continues until 500 UNAPPLIED jobs are pooled or the query budget runs out.
    const { added: newJobs, skippedApplied } = mergeIntoPool(
      gen.seen, gen.candidates, results, (p, id) => isApplied(spent, p, id))
    const found = newJobs.length
    if (skippedApplied > 0) {
      console.log(`[queryGen] query ${idx}: skipped ${skippedApplied} already-applied job(s)`)
    }
    gen.entries.push({ index: idx, query: entry, found, totalAfter: gen.candidates.length })
    slot++
    push('queryGen:searched', { index: idx, found, total: gen.candidates.length })
    // Background pre-rating: score this query's jobs while the next query generates
    ratingEngineEnqueue(newJobs)
    added++
  }
}

function persistGenState(gen: GenState): void {
  store.set('queryList', gen.queries as unknown as never)
  store.set('queryGenResults', gen.entries as unknown as never)  // for back-nav rehydrate
  store.set('candidates', gen.candidates as unknown as never)
}

export async function runQueryGen(): Promise<void> {
  await withToken(async t => {
    setState('query_gen')

    // Skip-if-clean: cached queries + pool with matching input hash → replay and exit
    const cachedHash = (store.get('queryGenInputHash') as string) ?? ''
    const cachedList = (store.get('queryList') as unknown as QueryEntry[]) ?? []
    if (cachedHash && cachedHash === queryGenHash() && cachedList.length > 0) {
      // The cache just proved the list current: record what it came from, so
      // loop mode does not regenerate it.
      stampQueryListInputs()
      const snapshot = (store.get('queryGenResults') as unknown as QuerySnapshotEntry[]) ?? []
      const candidates = (store.get('candidates') as unknown as Job[]) ?? []
      for (const c of snapshot) {
        push('queryGen:valid', c)
        push('queryGen:searched', { index: c.index, found: c.found ?? 0, total: c.totalAfter ?? 0 })
      }
      push('queryGen:done', { queries: cachedList, total: candidates.length })
      return
    }

    invalidateFrom('query_gen')

    // Pre-rating starts alongside generation — jobs are scored in the
    // background as each query lands, so Evaluate Matches feels instant.
    ratingEngineStart([])

    const gen: GenState = { entries: [], queries: [], candidates: [], seen: new Set() }
    await generateAndSearch(t, gen, { min: 5, max: 10 })

    persistGenState(gen)
    store.set('queryGenInputHash', queryGenHash())
    stampQueryListInputs()
    ratingEngineCloseIntake()  // after persist — settle hashes over final candidates
    push('queryGen:done', { queries: gen.queries, total: gen.candidates.length })
    // State stays 'query_gen' — user clicks "Evaluate Matches" to start rating
  })
}

// Targeted "find more" ask from the Find Jobs screen: generates 1-3 extra
// queries for the user's request, runs them, and grows the existing pool.
export async function runUserQueryGen(ask: string): Promise<void> {
  await withToken(async t => {
    // Re-open the background rater (or start one seeded with the persisted
    // ratings) so the ask's new jobs get scored as they land too.
    ratingEngineOpenIntake()

    const gen: GenState = {
      entries: ((store.get('queryGenResults') as unknown as QuerySnapshotEntry[]) ?? []).slice(),
      queries: ((store.get('queryList') as unknown as QueryEntry[]) ?? []).slice(),
      candidates: ((store.get('candidates') as unknown as Job[]) ?? []).slice(),
      seen: new Set<string>(),
    }
    for (const j of gen.candidates) gen.seen.add(`${j.platform}:${j.job_id}`)
    const before = gen.queries.length

    await generateAndSearch(t, gen, { min: 1, max: 3, userAsk: ask })

    if (gen.queries.length > before) {
      persistGenState(gen)
      // queryListInputsHash is left as it was: a few added searches do not
      // make the rest of the list current.
      // The pool changed — downstream stage caches (rating, extract, payload)
      // are stale now. queryGenInputHash is untouched: it gates only the
      // initial auto-generation; user-added queries ride along in the snapshot.
      // The in-memory engine keeps its ratings and re-persists the full set
      // (old + new) when it settles.
      invalidateDownstream('query_gen')
    }
    ratingEngineCloseIntake()
    push('queryGen:done', { queries: gen.queries, total: gen.candidates.length })
  })
}

/** Record what the saved searches were generated from (loop mode's staleness check). */
function stampQueryListInputs(): void {
  const h = queryInputsHash()
  if (store.get('queryListInputsHash') !== h) store.set('queryListInputsHash', h)
}

// ─── Loop mode: searches ─────────────────────────────────────────────────────
//
// Loop rounds do not go through runQueryGen. It regenerates the searches with
// the model after every rebuild (queryGenHash includes lastFetchAt), wipes
// the ratings, and pools what the model wrote. A round instead re-runs the
// saved searches as written (researchSavedQueries) and asks the model for new
// ones only when what they were generated from has changed
// (regenerateSavedQueries). Markets come from the target location, through
// the query agent and the rater, exactly as in a manual run.

/** The minimum a generated list must reach to replace the saved one after an error. */
const MIN_GENERATED_QUERIES = 5

/**
 * Loop mode: write new saved searches with the model, because what they were
 * generated from has changed.
 *
 * Only the list is kept. No rating engine runs, so nothing is rated here, and
 * the pool and the ratings stay as they are: the search stage that follows
 * rebuilds the pool from the saved searches, and the ratings carry over
 * wherever their fingerprint still holds. A generation cut
 * short by a Codex error keeps the old list, so the next round tries again.
 */
export async function regenerateSavedQueries(): Promise<{ ok: boolean; newJobs: number; error?: string }> {
  if (_activeToken) return { ok: false, newJobs: 0, error: 'Another step is still running' }
  const r = await withToken(async t => {
    // The screen rehydrates from this snapshot when it mounts; the old
    // list's cards must not sit among the new ones.
    store.set('queryGenResults', [] as never)
    setState('query_gen')
    const gen: GenState = { entries: [], queries: [], candidates: [], seen: new Set() }
    await generateAndSearch(t, gen, { min: MIN_GENERATED_QUERIES, max: 10 })
    checkpoint(t)
    const complete = gen.queries.length > 0 && (!gen.error || gen.queries.length >= MIN_GENERATED_QUERIES)
    if (!complete) {
      return {
        ok: false, newJobs: 0,
        error: gen.error ? `Search generation failed: ${gen.error.slice(0, 300)}` : 'Search generation produced no searches',
      }
    }
    store.set('queryList', gen.queries as unknown as never)
    stampQueryListInputs()
    push('queryGen:done', { queries: gen.queries, total: gen.candidates.length })
    return { ok: true, newJobs: 0 }
  })
  return r ?? { ok: false, newJobs: 0, error: 'Search generation was cancelled' }
}

/**
 * Loop mode's search stage: re-run the saved searches against the fresh
 * database, without the model.
 *
 * Every saved search runs as saved and, from the second round on, newest
 * first since the previous round (researchPool). Strict: a CLI failure, or searches that all return
 * nothing, fail the stage.
 *
 * The new pool replaces `candidates`; the ratings are left alone -- the
 * rating stage carries them over by fingerprint.
 */
export async function researchSavedQueries(opts: { sinceDate: string | null }): Promise<{
  ok: boolean; newJobs: number; error?: string
}> {
  const none = (error: string): { ok: false; newJobs: number; error: string } =>
    ({ ok: false, newJobs: 0, error })
  if (_activeToken) return none('Another step is still running')
  const r = await withToken(async t => {
    // The screen rehydrates from this snapshot when it mounts; an empty one
    // keeps the last run's cards from showing as this round's.
    store.set('queryGenResults', [] as never)
    setState('query_gen')

    const saved = (store.get('queryList') as unknown as QueryEntry[]) ?? []
    const previousPool = (store.get('candidates') as unknown as Job[]) ?? []

    // What predates loop mode carries no loop hashes. Adopt it now, while the
    // pool it was rated over is still in place: the manual rating cache is
    // keyed on that pool's ids, and the new pool would never match it.
    if (saved.length > 0 && !store.get('queryListInputsHash')) stampQueryListInputs()
    const ratingCache = (store.get('ratingInputHash') as string) ?? ''
    const rated = peek<RatedJob[]>('ratedJobs') ?? []
    if (!store.get('ratingFingerprint') && rated.length > 0 && ratingCache && ratingCache === ratingHash()) {
      store.set('ratingFingerprint', currentRatingFingerprint())
      console.log(`[loop] adopted the ${rated.length} current rating(s): they carry over while the resume, profile and model stay the same`)
    }

    const run = saved.map((q, index) => ({ ...q, index }))
    console.log(`[loop] searching: ${run.length} saved search(es) as saved`
      + (opts.sinceDate ? `, plus new postings since ${opts.sinceDate}` : ''))
    const spent = appliedKeys()
    const out = await researchPool<Job>({
      run, sinceDate: opts.sinceDate, previousPool,
      isApplied: (p, id) => isApplied(spent, p, id),
      search: async tokens => {
        checkpoint(t)
        return await cliSearchStrict(tokens, t) as Job[]
      },
      events: {
        started: (index, query) => push('queryGen:valid', { index, query }),
        searched: (index, found, total) => push('queryGen:searched', { index, found, total }),
        failed: (index, error, detail) => {
          console.warn(`[loop] ${error}: ${detail.slice(0, 300)}`)
          push('queryGen:error', { index, error })
        },
      },
    })
    // A cancelled search shows up as a failed one; report the cancel instead.
    checkpoint(t)
    if (!out.ok) {
      push('queryGen:done', { queries: run, total: out.pool.length })
      return { ok: false, newJobs: 0, error: out.error }
    }

    store.set('candidates', out.pool as unknown as never)
    store.set('queryGenResults', out.entries as unknown as never)
    // The manual Find Jobs screen shows this round's pool instead of regenerating.
    store.set('queryGenInputHash', queryGenHash())
    push('queryGen:done', { queries: run, total: out.pool.length })
    return { ok: true, newJobs: out.newJobs }
  })
  return r ?? none('Search was cancelled')
}

// Validate a query's flags against the real CLI and capture its live match
// count ("--count" prints "N jobs across M companies" and ignores --limit).
async function validateQueryFlags(
  flags: string,
  t?: CancelToken
): Promise<{ error: string | null; count: number | null }> {
  const tokens = tokenizeQueryFlags(flags)
  try {
    const { stdout, stderr, exitCode } = await runCli(['search', ...tokens, '--count'], undefined, t)
    if (exitCode !== 0 && stderr.trim()) return { error: stderr.trim().slice(0, 120), count: null }
    const countMatch = stdout.match(/(\d+) jobs across/)
    return { error: null, count: countMatch ? parseInt(countMatch[1], 10) : null }
  } catch (e) { return { error: String(e), count: null } }
}

// ─── Phase 5: Rating (background-capable engine) ─────────────────────────────
//
// Rating runs in a DETACHED engine so it can start the moment Find Jobs pools
// its first candidates — while the generation turn is still writing the next
// query — instead of idling until the user clicks "Evaluate Matches". It is
// detached (not under the pipeline cancel token) so a "find more" ask can take
// the token while rating continues; every cancel path calls
// ratingEngineCancel() explicitly instead.

const RATING_BATCH_SIZE = 20

/**
 * What the rater is told about the candidate, beyond the resume.
 *
 * Everything here is something the user typed into their profile and that bears
 * on whether a posting FITS them. The EEO answers are deliberately excluded:
 * gender, race, veteran and disability status say nothing about job fit, and
 * they have no business in a relevance-scoring prompt.
 */
function raterProfileBlock(): string {
  const sponsorshipText: Record<string, string> = {
    'no-sponsorship':     'Does not need sponsorship — fully work authorized',
    'future-sponsorship': 'May need sponsorship in future (e.g. OPT → H1B transition)',
    'need-sponsorship':   'Requires employer sponsorship now',
  }
  const get = (key: string): string => ((store.get(key) as string | undefined) ?? '').trim()
  const sponsorship = get('profileSponsorshipNeed')
  const lines: string[] = []
  const add = (label: string, value: string): void => { if (value) lines.push(`- ${label}: ${value}`) }
  add('Target locations', get('profileTargetLocations'))
  add('Work authorization', get('profileVisaSituation'))
  add('Visa sponsorship', sponsorship ? (sponsorshipText[sponsorship] ?? sponsorship) : '')
  add('Expected salary', get('profileSalaryExpectation'))
  add('Security clearance', get('profileClearance'))
  add("Search instructions (the candidate's own words)", get('profileSearchInstructions'))
  return lines.length > 0
    ? `CANDIDATE PROFILE:\n${lines.join('\n')}\n\n`
    : ''
}

interface RatingEngine {
  active: boolean
  canceled: boolean
  intakeOpen: boolean          // a generation run may still enqueue jobs
  queue: Job[]                 // enqueued, not yet in a batch
  seenKeys: Set<string>        // platform:job_id ever enqueued or pre-rated
  rated: RatedJob[]
  inFlight: number
  processedJobs: number        // jobs whose batch finished (rated OR dropped) — progress numerator
  failedJobs: number           // jobs whose batch threw — loop mode's rating health
  lastError: string            // the last batch error, e.g. a Codex usage limit
  resumeText: string           // captured at start
  profileBlock: string         // captured at start
  // What every rating this engine holds was made under, written as
  // ratingFingerprint when it settles. MIXED_FINGERPRINT when seeded with
  // ratings made under another one, so a settle never vouches for scores it
  // did not make -- and '' stays reserved for "saved before loop mode".
  fingerprint: string
  agents: number               // ratingAgents captured at start
  settledResolvers: Array<() => void>
}

let _ratingEngine: RatingEngine | null = null

export function isRatingEngineActive(): boolean {
  return _ratingEngine?.active === true
}

export function getRatingEngineSnapshot(): RatedJob[] {
  return _ratingEngine?.active ? [..._ratingEngine.rated] : []
}

// Job-based progress: processed / ever-enqueued. Truthful at every instant —
// the total only moves when the pool genuinely grows (a new query landing).
export function getRatingEngineProgress(): { done: number; total: number } | null {
  const e = _ratingEngine
  if (!e || !e.active) return null
  return { done: e.processedJobs, total: e.seenKeys.size }
}

/**
 * `seedFingerprint` is what the seed ratings were made under. The engine
 * vouches for them on settle only when that is the current fingerprint.
 */
function ratingEngineStart(seedRated: RatedJob[], seedFingerprint = ''): void {
  if (_ratingEngine?.active) ratingEngineCancel()  // never let a stale engine settle over a new run
  const resumeText = (store.get('resumeText') as string | undefined) ?? ''
  const profileBlock = raterProfileBlock()
  const current = ratingFingerprint(resumeText, profileBlock, codexModelForHash())
  const e: RatingEngine = {
    active: true,
    canceled: false,
    intakeOpen: true,
    queue: [],
    seenKeys: new Set(seedRated.map(j => `${j.platform}:${j.job_id}`)),
    rated: [...seedRated],
    inFlight: 0,
    processedJobs: seedRated.length,
    failedJobs: 0,
    lastError: '',
    resumeText,
    profileBlock,
    fingerprint: seedRated.length === 0 || seedFingerprint === current ? current : MIXED_FINGERPRINT,
    agents: Math.max(1, (store.get('ratingAgents') as number | undefined) ?? 5),
    settledResolvers: [],
  }
  _ratingEngine = e
}

function ratingEngineEnqueue(jobs: Job[]): void {
  const e = _ratingEngine
  if (!e || !e.active || e.canceled) return
  for (const j of jobs) {
    const key = `${j.platform}:${j.job_id}`
    if (!e.seenKeys.has(key)) { e.seenKeys.add(key); e.queue.push(j) }
  }
  ratingEnginePump(e)
}

// Re-open intake for an appended generation run ("find more" while the engine
// is still working), or start fresh seeded with already-persisted ratings.
function ratingEngineOpenIntake(): void {
  if (_ratingEngine?.active) {
    _ratingEngine.intakeOpen = true
  } else {
    ratingEngineStart(
      (store.get('ratedJobs') as unknown as RatedJob[]) ?? [],
      (store.get('ratingFingerprint') as string) ?? '',
    )
  }
}

function ratingEngineCloseIntake(): void {
  const e = _ratingEngine
  if (!e || !e.active) return
  e.intakeOpen = false
  ratingEnginePump(e)
  ratingEngineMaybeSettle(e)
}

export function ratingEngineCancel(): void {
  const e = _ratingEngine
  if (!e || !e.active) return
  e.canceled = true
  e.queue.length = 0
  e.active = false
  // In-flight codex turns die via clearCodexClient in cancelActivePipeline;
  // their rejections are swallowed per-batch. Nothing is persisted.
  for (const r of e.settledResolvers.splice(0)) r()
}

function ratingEngineSettled(): Promise<void> {
  const e = _ratingEngine
  if (!e || !e.active) return Promise.resolve()
  return new Promise(resolve => e.settledResolvers.push(resolve))
}

function ratingEnginePump(e: RatingEngine): void {
  // Full batches only while intake is open (queries land ~100 jobs at a time,
  // so batches stay full); the final partial batch runs after intake closes.
  while (
    !e.canceled &&
    e.inFlight < e.agents &&
    (e.queue.length >= RATING_BATCH_SIZE || (!e.intakeOpen && e.queue.length > 0))
  ) {
    const batch = e.queue.splice(0, RATING_BATCH_SIZE)
    e.inFlight++
    void ratingEngineBatch(e, batch).finally(() => {
      e.inFlight--
      ratingEnginePump(e)
      ratingEngineMaybeSettle(e)
    })
  }
}

async function ratingEngineBatch(e: RatingEngine, batch: Job[]): Promise<void> {
  try {
    // location/workplace_type/employment_type/salary were being dropped here, so
    // the rating prompt asked for a location and compensation judgement the model
    // had no way to make -- it scored an Austin candidate against a San Diego job
    // with no idea they differed.
    const jobSummaries = batch.map(j => ({
      job_id: j.job_id,
      platform: j.platform,
      title: j.title,
      company: j.company,
      ...(j.location ? { location: j.location } : {}),
      ...(j.workplace_type ? { workplace_type: j.workplace_type } : {}),
      ...(j.employment_type ? { employment_type: j.employment_type } : {}),
      ...(j.salary ? { salary: j.salary } : {}),
      description: (j.description ?? '').slice(0, RATING_DESCRIPTION_CHARS),
    }))
    const userMsg = `${e.profileBlock}RESUME:\n${e.resumeText}\n\nJOBS:\n${JSON.stringify(jobSummaries, null, 2)}`
    const raw = await runCodexThread(RATING_SYSTEM, userMsg)
    if (e.canceled) return
    const ratings = parseJsonResponse<Array<{ job_id: string; platform: string; rating: number; reason: string }>>(raw) ?? []

    for (const r of ratings) {
      const job = batch.find(j => j.job_id === r.job_id && j.platform === r.platform)
      if (job) e.rated.push({ ...job, rating: r.rating, reason: r.reason })
    }
  } catch (err) {
    // One failed batch drops its jobs but never aborts the run — the pool is
    // large and per-job scores are independent. Counted, though: loop mode
    // fails the stage when most of the pool went unrated.
    if (!e.canceled) {
      e.failedJobs += batch.length
      e.lastError = String(err)
      console.error('[rating-engine] batch failed:', String(err).slice(0, 160))
    }
  }
  if (e.canceled) return
  // Job-based progress (done/total = jobs processed / jobs ever enqueued) —
  // counted for failed batches too, so the bar always reaches 100%.
  e.processedJobs += batch.length
  push('rating:progress', {
    done: e.processedJobs,
    total: e.seenKeys.size,
    partialResults: [...e.rated],
  })
}

function ratingEngineMaybeSettle(e: RatingEngine): void {
  if (!e.active || e.canceled || e.intakeOpen || e.queue.length > 0 || e.inFlight > 0) return
  e.active = false
  const sorted = e.rated.sort((a, b) => b.rating - a.rating)
  store.set('ratedJobs', sorted as unknown as never)
  store.set('ratingInputHash', ratingHash())
  store.set('ratingFingerprint', e.fingerprint)
  push('rating:done', { jobs: sorted })
  for (const r of e.settledResolvers.splice(0)) r()
}

export async function runRating(): Promise<void> {
  await withToken(async t => {
    setState('rating')

    // Skip-if-clean: cached ratings with matching input hash → re-emit
    const cachedHash = (store.get('ratingInputHash') as string) ?? ''
    const cachedRated = (store.get('ratedJobs') as unknown as RatedJob[]) ?? []
    if (!isRatingEngineActive() && cachedHash && cachedHash === ratingHash() && cachedRated.length > 0) {
      push('rating:done', { jobs: cachedRated })
      return
    }

    // No background run to attach to (stale data / fresh session) — start one
    // over the full pool.
    if (!isRatingEngineActive()) {
      invalidateFrom('rating')
      ratingEngineStart([])
      ratingEngineEnqueue((store.get('candidates') as unknown as Job[]) ?? [])
    }
    // Idempotent when the generation run already closed intake; heals an
    // engine orphaned with intake open by a failed generation run.
    ratingEngineCloseIntake()

    // Attach: hold the token while the engine streams, so back-nav →
    // cancelActivePipeline → ratingEngineCancel works exactly as before.
    await ratingEngineSettled()
    checkpoint(t)
    // Stay on 'rating' screen — selection happens inline on same screen
  })
}

export interface RateNewJobsResult {
  health: 'ok' | 'failed' | 'codex_limit'
  enqueued: number
  newlyRated: number
  failedJobs: number
  lastError: string
}

/**
 * Loop mode's rating stage: rate only what the stored ratings do not cover.
 *
 * A job already rated under the current fingerprint keeps its score; every
 * other job in the pool is rated. The ratings afterwards are exactly the
 * pool's -- jobs that left the pool leave the ratings too -- so a round can
 * only ever select from what this round's searches found.
 *
 * The result says whether rating worked (ratingHealth): most of the pool
 * unrated fails the stage, and a Codex usage limit makes it a limit round.
 */
export async function rateNewJobs(): Promise<RateNewJobsResult> {
  const none = (lastError: string): RateNewJobsResult =>
    ({ health: 'failed', enqueued: 0, newlyRated: 0, failedJobs: 0, lastError })
  if (_activeToken) return none('Another step is still running')
  const r = await withToken(async t => {
    setState('rating')
    const current = currentRatingFingerprint()
    const stored = (store.get('ratingFingerprint') as string) ?? ''
    const cache = (store.get('ratingInputHash') as string) ?? ''
    const same = fingerprintMatches(stored, current, !!cache && cache === ratingHash())
    const pool = uniqueByKey((store.get('candidates') as unknown as Job[]) ?? [])
    const rated = (store.get('ratedJobs') as unknown as RatedJob[]) ?? []
    const { seed: carried, toRate } = carryForward(rated, pool, same)
    const seed = uniqueByKey(carried)
    console.log(`[loop] rating: pool ${pool.length}, ${seed.length} rating(s) carried over, ${toRate.length} to rate`
      + ` (fingerprint ${same ? (stored ? 'unchanged' : 'adopted from the current ratings') : 'changed'})`)

    ratingEngineStart(seed, current)
    const e = _ratingEngine
    if (!e) return none('Rating did not start')
    ratingEngineEnqueue(toRate)
    ratingEngineCloseIntake()
    await ratingEngineSettled()
    checkpoint(t)
    if (e.canceled) return none('Rating was cancelled')

    const seedKeys = new Set(seed.map(j => jobKey(j.platform, j.job_id)))
    const newlyRated = new Set(
      e.rated.map(j => jobKey(j.platform, j.job_id)).filter(k => !seedKeys.has(k))).size
    const counts = { enqueued: toRate.length, newlyRated, failedJobs: e.failedJobs, lastError: e.lastError }
    return { health: ratingHealth(counts), ...counts }
  })
  return r ?? none('Rating was cancelled')
}

// ─── Phase 7: Extract ─────────────────────────────────────────────────────────

export async function runExtract(sharedToken?: CancelToken): Promise<void> {
  // Accepts a token so runBoard can run extraction and the agents under ONE
  // token. withToken is a mutex -- a second concurrent call returns silently
  // without running, which would leave extraction working and nobody
  // applying, and the run would still report success.
  const body = async (t: CancelToken): Promise<void> => {
    setState('board')

    // Skip-if-clean: cached extract results with matching selection hash → re-emit
    const cachedHash = (store.get('extractInputHash') as string) ?? ''
    const cachedResults = (store.get('extractResults') as unknown as Array<{
      platform: string; company: string; jobId: string
      title: string; applyUrl: string; status: 'extracted' | 'failed'; error?: string
    }>) ?? []
    if (cachedHash && cachedHash === extractHash() && cachedResults.length > 0) {
      push('extract:clear', {})
      const done = cachedResults.filter(r => r.status === 'extracted').length
      const failed = cachedResults.filter(r => r.status === 'failed').length
      const total = (store.get('selectedJobIds') as unknown as string[]).length
      for (const r of cachedResults) push('extract:job', r)
      push('extract:progress', { done, total, failed })
      push('extract:done', { done, failed })
      return
    }

    invalidateFrom('extract')

    const selectedIds = (store.get('selectedJobIds') as unknown as string[]) ?? []
    const homeDir = store.get('jobAutomatorHome') as string
    const platformMap: Record<string, string> = { gh: 'greenhouse', lv: 'lever', ab: 'ashby' }
    // Set when the jobs could not be queued: then none was tried at all.
    let queueFailure = ''

    if (selectedIds.length > 0) {
      // Full reset: wipe DB state + delete old files so every re-run starts fresh.
      // This handles re-selection of jobs that were previously extracted, filled, or submitted.
      // One asynchronous statement for the whole selection: this used to be a
      // synchronous python spawn per job, and the window stalled for all of them.
      const jobIds = selectedIds.map(id => id.split(':').slice(2).join(':')).filter(Boolean)
      if (!(await cliDbExec(resetSelectedSql(jobIds), t))) {
        console.warn('[extract] DB reset failed for', jobIds.length, 'selected job(s)')
      }
      for (const compositeId of selectedIds) {
        checkpoint(t)
        const parts = compositeId.split(':')
        const platform = platformMap[parts[0]] ?? 'greenhouse'
        const jobId = parts.slice(2).join(':')  // handle UUIDs with colons in them
        if (!jobId) continue

        // Delete old application dir so extractors write fresh files
        const appDir = path.join(homeDir, 'applications', platform, jobId)
        try { await fsPromises.rm(appDir, { recursive: true, force: true }) } catch { /* dir may not exist */ }
      }
      const queued = await cliQueueJobs(selectedIds, t)
      if (queued.exitCode !== 0) {
        queueFailure = `queueing failed (exit ${queued.exitCode}: ${queued.stderr.trim().split('\n')[0].slice(0, 120) || 'no output'})`
        console.warn(`[extract] ${queueFailure}`)
      }
    }

    // Signal renderer to clear stale jobs from previous extraction run
    push('extract:clear', {})


    let done = 0
    let failed = 0
    const total = selectedIds.length
    // platform:job_id of every job extraction answered for, extracted or failed.
    const answered = new Set<string>()
    const snapshot: Array<{ platform: string; company: string; jobId: string; title: string; applyUrl: string; status: 'extracted' | 'failed'; error?: string; setupFailed?: true }> = []

    const onLine = (line: string): void => {
      const trimmed = line.trim()
      // CLI outputs JSON lines: {"platform":"ashby","company":"acme","job_id":"...","title":"...","apply_url":"...","status":"extracted"}
      try {
        const j = JSON.parse(trimmed) as {
          platform: string; company: string; job_id: string
          title: string; apply_url: string; status: string; error?: string
        }
        if (j.job_id && (j.status === 'extracted' || j.status === 'failed')) answered.add(`${j.platform}:${j.job_id}`)
        if (j.status === 'extracted') {
          done++
          const entry = { platform: j.platform, company: j.company, jobId: j.job_id, title: j.title, applyUrl: j.apply_url, status: 'extracted' as const }
          snapshot.push(entry)
          push('extract:job', entry)
        } else if (j.status === 'failed') {
          failed++
          const entry = { platform: j.platform, company: j.company, jobId: j.job_id, title: j.title, applyUrl: j.apply_url, status: 'failed' as const, error: j.error || 'extraction failed' }
          snapshot.push(entry)
          push('extract:job', entry)
        }
      } catch { /* non-JSON line (summary, blank) — ignore */ }
      push('extract:progress', { done, total, failed })
    }

    const platforms = [...new Set(
      selectedIds.map(id => platformMap[id.split(':')[0]] ?? 'greenhouse')
    )]
    if (platforms.length === 0) platforms.push('greenhouse') // fallback

    for (const platform of platforms) {
      checkpoint(t)
      push('extract:start', { platform })
      let r = await cliExtract(platform, onLine, t)
      // A failed extract command used to pass in silence: no job of the
      // platform was read, no agent could claim one, and the run reported
      // success. Found live -- one picked job queued, never read, never
      // reported. A brief retry covers a database busy for a moment.
      for (const waitMs of EXTRACT_RETRY_MS) {
        if (r.exitCode === 0 || t.canceled) break
        console.warn(`[extract] ${platform}: exit ${r.exitCode}, retrying in ${waitMs / 1000}s:`, r.stderr.trim().slice(0, 200))
        await new Promise(res => setTimeout(res, waitMs))
        checkpoint(t)
        r = await cliExtract(platform, onLine, t)
      }
      checkpoint(t)
      // Every selected job of this platform gets an answer: one extraction
      // did not give is a failure, on the board and in the results.
      const seen = new Set([...answered].filter(k => k.startsWith(`${platform}:`)).map(k => k.slice(platform.length + 1)))
      // A command that failed (the extractor, or the queue before it) tried
      // no form at all: that is the setup, not the job, and the loop does not
      // charge the job for it.
      const setupFailed = r.exitCode !== 0 || queueFailure !== ''
      const why = r.exitCode !== 0
        ? `the form could not be read (extract exited ${r.exitCode}: ${r.stderr.trim().split('\n')[0].slice(0, 120) || 'no output'})`
        : queueFailure
          ? `the form was never read (${queueFailure})`
          : 'the form was never read (not queued for extraction)'
      for (const miss of unextracted(selectedIds, platform, seen)) {
        failed++
        const card = ((store.get('boardCards') as Board | undefined) ?? {})[`${miss.platform}:${miss.jobId}`]
        const entry = {
          platform: miss.platform, company: card?.company ?? '', jobId: miss.jobId, title: card?.title ?? '', applyUrl: card?.applyUrl ?? '',
          status: 'failed' as const, error: why, ...(setupFailed ? { setupFailed: true as const } : {}),
        }
        snapshot.push(entry)
        push('extract:job', entry)
        console.warn(`[extract] ${miss.platform}/${miss.jobId}: ${why}`)
      }
      push('extract:progress', { done, total, failed })
    }
    checkpoint(t)

    store.set('extractResults', snapshot as unknown as never)
    store.set('extractInputHash', extractHash())
    push('extract:done', { done, failed })
  }
  if (sharedToken) { await body(sharedToken); return }
  await withToken(body)
}

// ─── Phase 8: Payload Generation ──────────────────────────────────────────────

// Fetch job title/company/description from jobs.db for the Codex prompt,
// through the jobscan CLI like every other database call.
const EMPTY_JOB_CONTEXT = { title: '', company: '', description: '' }

/** A job-context query that has not answered in this long is given up on (the prompt goes without it). */
const JOB_CONTEXT_TIMEOUT_MS = 30_000

async function getJobContext(jobId: string, platform: string): Promise<{ title: string; company: string; description: string }> {
  try {
    // Asynchronous: this once ran as spawnSync per job, on the main process,
    // and the window could not draw a frame until the answer came.
    const rows = await cliDbQuery(jobContextSql(jobId, platform), undefined, JOB_CONTEXT_TIMEOUT_MS)
    if (rows === null) {
      // This returned empties for every job for the life of the feature,
      // because the SQL named a column the schema does not have. Nothing
      // crashed and nothing logged — the only symptom was an empty JOB
      // DESCRIPTION section in the prompt. Never let it go quiet again.
      console.error('[getJobContext] query failed (see [db query] above)')
      return { ...EMPTY_JOB_CONTEXT }
    }
    // No row when the job has dropped out of the DB.
    return { ...EMPTY_JOB_CONTEXT, ...jobContextFromRows(rows) }
  } catch (e) {
    console.error('[getJobContext]', e)
    return { ...EMPTY_JOB_CONTEXT }
  }
}

async function resetStaleFilling(): Promise<void> {
  // Through the CLI, asynchronously -- not a synchronous python spawn on the main process.
  if (!(await cliDbExec(`UPDATE applications SET status='failed', error='stale filling reset' WHERE status='filling' AND updated_at < datetime('now', '-10 minutes')`))) {
    console.warn('[pipeline] stale filling reset failed (non-critical)')
  }
}

/**
 * Extraction and the application agents, running together.
 *
 * These used to be two sequential stages, so a job that finished extracting
 * waited for EVERY other job to extract before anyone applied to it. The DB
 * claim queue was already the handoff point between them; all that was missing
 * was starting the agents early and letting them wait on an empty queue.
 *
 * extractionComplete is set in a finally so a thrown or cancelled extraction
 * still releases the pool. Without that a failed extraction hangs every agent
 * and the run stops with nothing on screen to explain it.
 */
/**
 * Clear the claim queue of anything that is not part of this run.
 *
 * MUST complete before any agent claims. ClaimJobs takes any row with
 * status='extracted' regardless of which run put it there, so a job left
 * extracted by an earlier run is claimable the moment an agent starts.
 *
 * That used to be safe by accident: this ran in runPayloadGen's preamble,
 * which happened strictly before the agents. Once extraction and the agents
 * became concurrent it turned into a race, and a JOB_AUTOMATOR_SUBMIT=0 run
 * caught it applying to two companies that were not in the selection.
 */
/** The interrupted run's cleanup at startup, while it runs (discardInterruptedRun). */
let startupAbandon: Promise<void> | null = null

async function prepareQueue(): Promise<void> {
  if (startupAbandon) await startupAbandon
  const selectedIds = (store.get('selectedJobIds') as unknown as string[]) ?? []
  const currentJobIds = selectedIds
    .map(id => id.split(':').slice(2).join(':'))
    .filter(Boolean)
  // Awaited: it must finish before any agent claims. Queued rows included --
  // the extractor would read them and an agent fill them, unpicked.
  if (!(await cliDbExec(abandonOthersSql(currentJobIds)))) {
    console.warn('[pipeline] could not abandon rows left by another run: any still queued may be read in this one (loop rounds still fill only what they picked)')
  }
  // Jobs stuck in filling from a crashed run would otherwise hold the cap.
  await resetStaleFilling()
}

/**
 * Put every selected job on the board, in To do.
 *
 * Called when the selection is confirmed, not when extraction starts, so the
 * board is already populated the moment it opens. Seeding inside runExtract
 * meant To do filled and drained within the same instant and was never
 * actually seen.
 */
/**
 * Discard a run that was interrupted by the app closing.
 *
 * Called once at startup, before the window exists. Applications already
 * submitted are untouched -- they are recorded the moment each submit is
 * detected, and a submitted application cannot be taken back. Everything still
 * in flight stops: the board, the selection, the skip-if-clean caches, and the
 * jobs.db rows whose filler process died with the app.
 *
 * Without this the next run inherited the last one's board and queue.
 */
export function discardInterruptedRun(): { discarded: boolean; cards: number } {
  const appState = String(store.get('appState') ?? '')
  const cards = Object.keys((store.get('boardCards') as Record<string, unknown>) ?? {}).length
  if (!wasInterrupted(appState, cards)) return { discarded: false, cards: 0 }

  // Through the CLI, asynchronously. Non-fatal: the store is cleared
  // regardless. prepareQueue waits for it, so it can never land on the next
  // run's rows.
  startupAbandon = cliDbExec(abandonSql()).then(ok => {
    if (!ok) console.warn('[startup] could not abandon in-flight rows (see [db exec] above)')
  })

  for (const key of RUN_STATE_KEYS) {
    store.set(key, (key.endsWith('Hash') ? '' : (key === 'boardCards' ? {} : [])) as never)
  }
  const land = landingState(appState)
  if (land) setState(land as AppState)

  console.log(`[startup] discarded an interrupted run (${cards} board cards); `
    + 'submitted applications kept')
  return { discarded: true, cards }
}

export function seedBoard(): number {
  const selectedIds = (store.get('selectedJobIds') as unknown as string[]) ?? []
  // Read only, for titles: peek, not a copy of the whole pool.
  const rated = ((peek('ratedJobs') as Array<{
    job_id?: string; platform?: string; company?: string; title?: string; apply_url?: string
  }> | undefined) ?? [])
  const ratedBy = new Map(rated.map(j => [`${j.platform}:${j.job_id}`, j]))
  const seeds: JobRef[] = selectedIds.map(id => {
    const parts = id.split(':')
    const platform = PLATFORM_ABBR[parts[0]] ?? 'greenhouse'
    const jobId = parts.slice(2).join(':')
    const meta = ratedBy.get(`${platform}:${jobId}`)
    return {
      platform, jobId,
      company: meta?.company ?? parts[1] ?? '',
      title: meta?.title ?? '',
      applyUrl: meta?.apply_url ?? '',
    }
  }).filter(j => j.jobId)
  store.set('boardCards', seedCards(emptyBoard(), seeds) as never)
  push('board:seeded', { count: seeds.length })
  return seeds.length
}

export async function runBoard(): Promise<void> {
  await withToken(async t => {
    // Before anything can claim: the queue must contain only this run's jobs.
    await prepareQueue()
    checkpoint(t)
    extractionComplete = false
    const extraction = runExtract(t)
      .finally(() => { extractionComplete = true })

    // allSettled, not all: if extraction rejects, the agents must still be
    // allowed to finish the jobs it queued before it failed.
    const [extractResult] = await Promise.allSettled([extraction, runPayloadGenInner(t)])
    // The run is over. A card no agent started would sit in To do as if work
    // were still coming; say it was not started.
    if (!t.canceled) {
      for (const c of cardsNotStarted((store.get('boardCards') as Board | undefined) ?? {})) {
        push('payload:progress', {
          platform: c.platform, jobId: c.jobId, company: c.company, title: c.title, applyUrl: c.applyUrl,
          state: 'failed', message: 'Not started — no agent reached this job',
        })
      }
    }
    if (extractResult.status === 'rejected') throw extractResult.reason
  })
}

export async function runPayloadGen(): Promise<void> {
  await withToken(async t => {
    await runPayloadGenInner(t)
  })
}

/** Go's active-fill slots (cmd/apply.go, "5 jobs already filling"). */
const LOOP_MAX_AGENTS = 5

async function runPayloadGenInner(t: CancelToken): Promise<void> {
  // Already on the board; extraction set it.
  setState('board')

  // Skip-if-clean: if all selected jobs are already in appliedJobIds, jump to done.
  // payload_gen hash includes selectedJobIds + resume + profile + agentCount.
  // If hash matches AND every selectedJobId has been applied → results already final.
  const cachedHash = (store.get('payloadInputHash') as string) ?? ''
  const sel = (store.get('selectedJobIds') as unknown as string[]) ?? []
  // selectedJobIds are `index:platform:job_id`; appliedJobIds now holds
  // `platform:job_id` for new entries and bare ids for historic ones, so
  // membership goes through isApplied rather than a raw Set lookup.
  const spent = appliedKeys()
  // selectedJobIds are `<abbr>:<company-slug>:<job_id>` -- the SECOND segment
  // is the company, not the platform. Reading it as the platform produced
  // keys like 'acme:9f8e7d6c...' that could never match an applied record.
  const selectedPairs = sel
    .map(id => {
      const parts = id.split(':')
      return { platform: PLATFORM_ABBR[parts[0]] ?? 'greenhouse', jobId: parts.slice(2).join(':') }
    })
    .filter(p => p.jobId)
  const allAlreadyApplied = selectedPairs.length > 0
    && selectedPairs.every(p => isApplied(spent, p.platform, p.jobId))
  if (cachedHash && cachedHash === payloadHash() && allAlreadyApplied) {
    setState('done')
    return
  }

  const resumeText = (store.get('resumeText') as string | undefined) ?? ''
  // Loop mode's per-job hooks; null in a normal run, which then runs exactly
  // as it always has. Read once: a run is either the loop's or not.
  const hooks = getRunHooks()
  const configuredAgents = Math.max(1, (store.get('payloadAgents') as number | undefined) ?? 6)
  // Go fills at most LOOP_MAX_AGENTS jobs at once and makes the next submit
  // wait, without limit, for a slot (cmd/apply.go). A loop run's fill deadline
  // would count that wait, and a job that never started would be cut off as
  // if it had -- so a loop run never has more agents than slots.
  const agentCount = hooks ? Math.min(configuredAgents, LOOP_MAX_AGENTS) : configuredAgents

  // Read user profile for visa/EEO answers + Codex prompt enrichment
  const profile = {
    visaSituation:      (store.get('profileVisaSituation') as string | undefined) ?? '',
    citizenship:        (store.get('profileCitizenship') as string | undefined) ?? '',
    sponsorshipNeed:    (store.get('profileSponsorshipNeed') as string | undefined) ?? '',
    clearance:          (store.get('profileClearance') as string | undefined) ?? '',
    salaryExpectation:  (store.get('profileSalaryExpectation') as string | undefined) ?? '',
    eeoGender:          (store.get('profileEeoGender') as string | undefined) ?? '',
    eeoRace:            (store.get('profileEeoRace') as string | undefined) ?? '',
    eeoVeteran:         (store.get('profileEeoVeteran') as string | undefined) ?? '',
    eeoDisability:      (store.get('profileEeoDisability') as string | undefined) ?? '',
  }

  // Build human-readable CANDIDATE PROFILE block for Codex
  const sponsorshipText: Record<string, string> = {
    'no-sponsorship':     'Does not need sponsorship — fully work authorized',
    'future-sponsorship': 'May need sponsorship in future (e.g. OPT → H1B transition)',
    'need-sponsorship':   'Requires employer sponsorship now',
  }
  const clearanceText: Record<string, string> = {
    'yes':          'Holds active security clearance',
    'no-eligible':  'No current clearance, but eligible to apply',
    'no-ineligible':'No clearance and not seeking clearance roles',
  }
  const profileLines: string[] = []
  if (profile.visaSituation)    profileLines.push(`- Work authorization: ${profile.visaSituation}`)
  // Stated separately from work authorization on purpose: being authorized to
  // work says nothing about citizenship, and forms ask the two as different
  // questions — often for legal/export-control compliance.
  if (profile.citizenship)      profileLines.push(`- Citizenship: ${profile.citizenship}`)
  if (profile.sponsorshipNeed)  profileLines.push(`- Visa sponsorship: ${sponsorshipText[profile.sponsorshipNeed] ?? profile.sponsorshipNeed}`)
  if (profile.clearance)        profileLines.push(`- Security clearance: ${clearanceText[profile.clearance] ?? profile.clearance}`)
  if (profile.salaryExpectation) profileLines.push(`- Expected salary: ${profile.salaryExpectation}`)
  if (profile.eeoGender)        profileLines.push(`- EEO gender: ${profile.eeoGender}`)
  if (profile.eeoRace)          profileLines.push(`- EEO race/ethnicity: ${profile.eeoRace}`)
  if (profile.eeoVeteran)       profileLines.push(`- EEO veteran: ${profile.eeoVeteran}`)
  if (profile.eeoDisability)    profileLines.push(`- EEO disability: ${profile.eeoDisability}`)
  const candidateProfileBlock = profileLines.length > 0
    ? `CANDIDATE PROFILE:\n${profileLines.join('\n')}\n`
    : ''

  await prepareQueue()

  // Ensure Chrome is running before we start any form filling
  push('payload:progress', { agentId: 'system', company: 'Starting Chrome...', state: 'working', jobId: '' })
  await ensureChrome()

  const homeDir = store.get('jobAutomatorHome') as string

  // Read the filler's fill_result.json for a failure summary. The mtime guard
  // rejects stale files from a previous run (fillers may exit without writing
  // one, e.g. a crash). tab_left_open tells us the browser tab was kept open
  // for manual completion.
  interface FillResultSummary { status: string; reason: string; tabLeftOpen: boolean }
  async function readFillResult(platform: string, jobId: string, sinceMs: number): Promise<FillResultSummary | null> {
    try {
      const resultPath = path.join(homeDir, 'applications', platform, jobId, 'fill_result.json')
      const stat = await fsPromises.stat(resultPath)
      if (stat.mtimeMs < sinceMs) return null
      const raw = JSON.parse(await fsPromises.readFile(resultPath, 'utf-8'))
      const sub = raw.submission ?? {}
      return {
        status: String(sub.status ?? raw.status ?? 'failed'),
        reason: String(sub.reason ?? ''),
        tabLeftOpen: raw.tab_left_open === true,
      }
    } catch { return null }
  }

  interface RunResult { company: string; jobId: string; platform: string; title: string; applyUrl: string; status: 'submitted' | 'failed'; message: string; via: 'auto' | 'manual'; ts: string; detailsPath?: string; needsYou?: string }

  const runResults: RunResult[] = []

  // Append ONE result to the persistent log immediately.
  //
  // This used to happen once, after every agent had finished. A run that was
  // interrupted -- app closed, crash, cancel -- therefore recorded nothing at
  // all, however many applications it had already submitted, and the history
  // could only be repaired afterwards with scripts/sync_applied_jobs.py.
  //
  // A submitted application is not undoable, so its record must be durable the
  // moment it exists.
  const recordApplied = (entry: RunResult): void => {
    try {
      const log = ((store.get('appliedJobsLog') as RunResult[] | undefined) ?? [])
      const key = `${entry.platform}:${entry.jobId}:${entry.status}:${entry.ts}`
      if (log.some(r => `${r.platform}:${r.jobId}:${r.status}:${r.ts}` === key)) return
      store.set('appliedJobsLog', [entry, ...log] as unknown as never)
    } catch (err) {
      console.error('[applied-log] could not persist result:', err)
    }
  }

  // Per-application Q&A record (.md) — written for submitted AND failed
  // attempts from the FINAL payload (LLM answers + resume-path/profile
  // injections). Lives in a permanent folder: the per-job working dir gets
  // wiped on re-selection, but history entries reference records forever.
  async function writeApplicationRecord(opts: {
    job: ClaimedJob
    fields: Array<{ id: string; type: string; required: boolean; label?: string }>
    answers: Record<string, string | string[]>
    status: 'submitted' | 'failed'
    message: string
    ts: string
  }): Promise<string | null> {
    try {
      const { job, fields, answers, status, message, ts } = opts
      const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_')
      const dir = path.join(homeDir, 'application-records')
      await fsPromises.mkdir(dir, { recursive: true })
      const filePath = path.join(dir, `${sanitize(job.platform)}-${sanitize(job.job_id)}-${Date.now()}.md`)

      const profilesList = (store.get('profilesList') as Array<{ id: string; name: string }> | undefined) ?? []
      const activeId = (store.get('activeProfileId') as string) ?? ''
      const profileName = profilesList.find(p => p.id === activeId)?.name ?? 'Default'

      // The files that actually went to the employer. answers[] holds the
      // PRE-fill payload, where every file field is '' by design (payload rule
      // 13 tells the agent to leave them blank) -- and the cover letter is
      // materialised later still, by the filler. Reading the payload alone is
      // why records said 'Cover Letter — (no file)' for applications that
      // uploaded one. Resolve them from disk instead.
      const appDir = path.join(homeDir, 'applications', job.platform, job.job_id)
      const uploadedFor = async (field: { id: string; label?: string }): Promise<string> => {
        const label = `${field.label ?? ''} ${field.id}`.toLowerCase()
        if (/cover.?letter/.test(label)) {
          for (const name of ['cover_letter.pdf', 'cover_letter.txt']) {
            const candidate = path.join(appDir, name)
            try { await fsPromises.access(candidate); return candidate } catch { /* next */ }
          }
          return ''
        }
        if (/resume|cv/.test(label)) return (store.get('resumePath') as string) ?? ''
        return ''
      }

      let fillResult: unknown = null
      try {
        fillResult = JSON.parse(await fsPromises.readFile(path.join(appDir, 'fill_result.json'), 'utf-8'))
      } catch { /* no result written */ }
      const header = recordHeader(status, fillResult)

      const lines: string[] = []
      lines.push(`# ${job.job_title || job.job_id} — ${job.company_slug}`)
      lines.push('')
      lines.push(`${header.whenLabel}: ${new Date(ts).toLocaleString()}`)
      lines.push(`Profile: ${profileName}`)
      lines.push(`Status: ${status} — ${message}`)
      lines.push(`Platform: ${job.platform}`)
      if (job.apply_url) lines.push(`Application: ${job.apply_url}`)
      lines.push('')
      lines.push(`## ${header.answersHeading}`)
      lines.push('')
      for (const f of fields) {
        const label = (f.label || f.id).trim()
        const raw = answers[f.id]
        let answer: string
        if (f.type === 'file') {
          // Prefer what the payload named; fall back to what is on disk.
          const fromPayload = typeof raw === 'string' ? raw : ''
          const p = fromPayload || await uploadedFor(f)
          // Keep the PATH, not just the basename: the history record links to
          // it, and a bare filename cannot be opened.
          // Parentheses are encoded because the record's link syntax is
          // [label](target) and download filenames routinely contain them
          // -- "resume (4).pdf" would otherwise truncate at the first ')'.
          const href = p.replace(/\(/g, '%28').replace(/\)/g, '%29')
          answer = p ? `uploaded: [${path.basename(p)}](${href})` : '(no file)'
        } else if (raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
          answer = '_(left blank)_'
        } else {
          answer = Array.isArray(raw) ? raw.join(', ') : String(raw)
        }
        if (answer.length > 200) {
          lines.push(`**${label}**${f.required ? ' *' : ''}`)
          for (const l of answer.split('\n')) lines.push(`> ${l}`)
        } else {
          lines.push(`**${label}**${f.required ? ' *' : ''} — ${answer}`)
        }
        lines.push('')
      }

      // Field-level issues from the filler, when available
      try {
        const resultPath = path.join(homeDir, 'applications', job.platform, job.job_id, 'fill_result.json')
        const rawResult = JSON.parse(await fsPromises.readFile(resultPath, 'utf-8'))
        const errors = (rawResult.errors ?? []) as Array<{ id?: string; label?: string; error?: string }>
        const unfilled = (rawResult.required_unfilled ?? []) as Array<{ id?: string; label?: string }>
        if (errors.length > 0 || unfilled.length > 0) {
          lines.push('## Fill issues')
          lines.push('')
          for (const e of errors.slice(0, 20)) lines.push(`- ${e.label || e.id || 'field'}: ${typeof e === 'string' ? e : (e.error ?? 'error')}`)
          for (const u of unfilled.slice(0, 20)) lines.push(`- ${u.label || u.id || 'field'} — required, still empty`)
          lines.push('')
        }

        // AI recovery pass — what it was handed, what it did, what it cost.
        // Surfaced per-application because the cost/guardrail numbers are only
        // actionable next to the failure that triggered them.
        const rec = rawResult.recovery as Record<string, unknown> | undefined
        if (rec?.['attempted']) {
          const verdict = (rec['verdict'] ?? {}) as Record<string, unknown>
          const usage = (rec['usage'] ?? {}) as Record<string, number>
          const tools = (rec['tools'] ?? {}) as Record<string, unknown>
          const triggerIds = (rec['trigger_field_ids'] ?? []) as string[]
          lines.push('## AI recovery')
          lines.push('')
          lines.push(`- Trigger: \`${rec['trigger_status'] ?? 'unknown'}\` → mode \`${rec['mode']}\`, ${rec['focus_mode'] ?? 'unknown'} (skill rev ${rec['skill_rev'] ?? 'n/a'})`)
          if (triggerIds.length > 0) lines.push(`- Handed the agent: ${triggerIds.join(', ')}`)
          lines.push(`- Outcome: ${rec['outcome']} in ${rec['duration_s']}s`)
          const cost: string[] = []
          if (usage['uncached_input_tokens'] != null) cost.push(`${usage['uncached_input_tokens'].toLocaleString()} uncached input tokens`)
          if (tools['total'] != null) cost.push(`${tools['total']} tool calls (${tools['snapshot'] ?? 0} snapshots)`)
          if (tools['time_to_first_mutation_s'] != null) cost.push(`first fix at ${tools['time_to_first_mutation_s']}s`)
          if (cost.length > 0) lines.push(`- Cost: ${cost.join(', ')}`)
          const inferred = (verdict['inferred'] ?? []) as string[]
          if (inferred.length > 0) lines.push(`- **Inferred (review these): ${inferred.join('; ')}**`)
          const unfixable = (verdict['unfixable'] ?? []) as string[]
          if (unfixable.length > 0) lines.push(`- Unfixable: ${unfixable.join('; ')}`)
          if (rec['tab_url_mismatch'] === true) lines.push('- ⚠︎ Agent finished on a tab whose URL does not match the application')
          lines.push('')
        }
      } catch { /* no fill_result — skip section */ }

      await fsPromises.writeFile(filePath, lines.join('\n'), 'utf-8')
      return filePath
    } catch (e) {
      console.error('[record] write failed:', String(e).slice(0, 160))
      return null
    }
  }

  // ── Loop mode, per job. Nothing below runs when `hooks` is null. ──

  const hookJob = (job: ClaimedJob): HookJob => ({
    platform: job.platform, job_id: job.job_id, title: job.job_title,
    company: job.company_slug, apply_url: job.apply_url,
  })

  // The loop's view of one result. A policy bug must never take down a run
  // that is submitting real applications: it falls back to plain reporting.
  const loopView = (r: HookResult): HookView => {
    try { return hooks?.onResult(r) ?? { asSkipped: false } } catch (e) {
      console.error('[loop] onResult failed:', String(e).slice(0, 200))
      return { asSkipped: false }
    }
  }

  // Every tab of a finished job closes in a loop run, whatever happened. A
  // filler that was killed or crashed can never close its own.
  const closeJobTabs = async (job: ClaimedJob): Promise<void> => {
    try { await closeTabsFor(job.apply_url) } catch { /* Chrome gone: nothing to close */ }
  }

  // A claimed row the loop will not fill -- or whose filler it killed --
  // must not keep its lease. A killed filler's row stays 'filling' and holds
  // one of Go's slots until a waiting submit reclaims it, 30 minutes later.
  const releaseRow = (job: ClaimedJob, reason: string): Promise<boolean> =>
    cliDbExec(markSkippedSql(job.platform, job.job_id, reason), t)

  /**
   * Ask the loop whether to fill this job; when not, record it as skipped.
   * Asked twice per job -- after the claim, and again just before the fill,
   * since a platform can be paused or the Codex limit hit while answers were
   * being written. True when the job was skipped.
   */
  const skippedByLoop = async (job: ClaimedJob, agentId: string): Promise<boolean> => {
    if (!hooks) return false
    let gate: ReturnType<typeof hooks.beforeFill>
    try { gate = hooks.beforeFill(hookJob(job)) } catch (e) {
      console.error('[loop] beforeFill failed:', String(e).slice(0, 200))
      gate = { skip: true, reason: 'Skipped — the loop could not check this job; not applied' }
    }
    if (!gate.skip) return false
    await releaseRow(job, gate.reason)
    if (gate.notPicked) {
      // A row another run left behind, not a job of this one: released, and
      // never shown on this board or written into this profile's history.
      console.warn(`[loop] ${job.platform}/${job.job_id}: claimed but not picked by this round; released, not applied`)
      return true
    }
    push('payload:progress', {
      agentId, jobId: job.job_id, company: job.company_slug,
      title: job.job_title, platform: job.platform, applyUrl: job.apply_url,
      state: 'failed', skipped: true, message: gate.reason,
    })
    const entry: RunResult = { company: job.company_slug, jobId: job.job_id, platform: job.platform, title: job.job_title, applyUrl: job.apply_url, status: 'failed', message: gate.reason, via: 'auto', ts: new Date().toISOString() }
    runResults.push(entry)
    recordApplied(entry)
    return true
  }

  /**
   * Stop now arrived before this job's filler started: nothing was attempted.
   * The loop is not told -- it counts nothing and excludes nothing -- and the
   * history gets no entry for an application never made. The card leaves
   * Applying so the board does not show work that is not happening.
   */
  const stoppedBeforeFill = (job: ClaimedJob, agentId: string): void => {
    push('payload:progress', {
      agentId, jobId: job.job_id, company: job.company_slug,
      title: job.job_title, platform: job.platform, applyUrl: job.apply_url,
      state: 'failed', skipped: true, message: 'Stopped before filling — not applied',
    })
  }

  async function runAgent(agentId: string): Promise<void> {
    while (true) {
      if (t.canceled) return
      const claimed = await cliClaim(agentId, 1, t) as ClaimedJob[]
      if (claimed.length === 0) {
        // An empty queue no longer means the run is over: extraction is
        // still feeding it. See agent-loop.ts for why this is the one
        // decision that strands a run when it is wrong.
        if (shouldAgentExit({ claimedCount: 0, extractionComplete, canceled: t.canceled })) break
        await new Promise(r => setTimeout(r, AGENT_POLL_MS))
        continue
      }
      if (t.canceled) return

      const job = claimed[0]
      // Before any Codex turn is spent on it.
      if (await skippedByLoop(job, agentId)) continue
      const fieldsSummary = summarizeFieldsForPrompt(job.extracted_fields.fields ?? [])

      // Fetch job context (title, company, JD) for enriched prompt
      const jobCtx = await getJobContext(job.job_id, job.platform)

      // Single attempt per job — no retry. On failure the filler leaves the
      // browser tab open (unless nothing loaded) so the user finishes the
      // application manually; retrying here would open a duplicate tab and
      // risk double-submitting.
      push('payload:progress', {
        agentId, jobId: job.job_id, company: job.company_slug,
        title: job.job_title, platform: job.platform, applyUrl: job.apply_url,
        state: 'working', phase: 'generating', message: 'Generating answers...',
      })

      const jobLine = jobCtx.title || jobCtx.company
        ? `JOB: ${jobCtx.title || '(unknown title)'} at ${jobCtx.company || job.company_slug} [${job.platform}]\n`
        : ''
      const jdSection = jobCtx.description
        ? `\nJOB DESCRIPTION (first 2000 chars):\n${jobCtx.description}\n`
        : ''
      const userMsg = `${jobLine}${jdSection}\n${candidateProfileBlock}\nCANDIDATE RESUME:\n${resumeText}\n\nFORM FIELDS (answer every one):\n${JSON.stringify(fieldsSummary, null, 2)}`

      // Set once the filler is under way; a cancel before that was no attempt.
      let fillStarted = false
      // Set the moment a submission is known, so nothing after can pass it off as a failure.
      let submittedAs: string | null = null
      try {
        const wantsCoverLetter = (store.get('profileGenerateCoverLetter') as boolean) ?? false
        type PayloadReply = { answers: Record<string, string | string[]>; cover_letter?: string }
        const askPayload = async (): Promise<PayloadReply | null> =>
          parseJsonResponse<PayloadReply>(
            await runCodexThread(payloadSystem(wantsCoverLetter), userMsg))

        let parsed = await askPayload()
        // A turn that yields NO answers has failed, not answered. One live run
        // came back with zero: the form was filled from profile defaults alone,
        // went in with 5 required fields blank, failed validation and cost a
        // 67s recovery agent. Even `name` and `email` were missing, which the
        // resume answers trivially -- so this is a broken turn, not a hard form.
        if (Object.keys(parsed?.answers ?? {}).length === 0) {
          console.error(`[payload] ${job.platform}/${job.job_id}: no answers returned, retrying once`)
          parsed = await askPayload()
        }
        const answers = parsed?.answers ?? {}
        const built = await buildAndWritePayload(job, answers, profile, {
          candidateProfile: candidateProfileBlock,
          jobContext: jobCtx,
          coverLetter: wantsCoverLetter ? (parsed?.cover_letter ?? '') : '',
        })

        // The second ask: the answers took a while, and the loop may have
        // paused this platform or hit the Codex limit meanwhile.
        if (await skippedByLoop(job, agentId)) continue
        // Stopped while the answers were written: no fill, so no attempt.
        if (hooks && t.canceled) { stoppedBeforeFill(job, agentId); return }

        push('payload:progress', {
          agentId, jobId: job.job_id, company: job.company_slug,
          title: job.job_title, platform: job.platform, applyUrl: job.apply_url,
          state: 'working', phase: 'filling', message: 'Filling form...',
        })

        const submitStartedAt = Date.now()
        hooks?.onFillStart(hookJob(job))
        fillStarted = true
        const submit = await cliSubmit(job.claim_token, job.job_id, built.payloadPath, '', t,
          hooks ? { timeoutMs: FILLER_TIMEOUT_MS } : {})
        const output = submit.output
        // A fill cut off -- by its deadline, or by Stop now -- may already
        // have gone in. The loop counts it as interrupted, never as retryable.
        const cutOff = submit.timedOut || t.canceled
        console.log(`[filler:${job.company_slug}]`, output.slice(0, 300))

        const okLine = output.match(/Submission result: (\S+)/)?.[1] ?? null
        // A fill cut off -- a normal run cancelled, loop mode's Stop now or
        // deadline -- after it had submitted: Go never got to print the
        // result, but the filler's result file is the evidence Go reads.
        // Recorded as applied, so nobody applies twice.
        const late = !okLine && cutOff ? await readFillResult(job.platform, job.job_id, submitStartedAt) : null
        const sentAs = submittedStatus(okLine, cutOff, late)
        const okMatch: ['', string] | null = sentAs ? ['', sentAs] : null
        if (okMatch) {
          submittedAs = okMatch[1]
          const ts = new Date().toISOString()
          const detailsPath = await writeApplicationRecord({
            job, fields: built.fields, answers: built.answers,
            status: 'submitted', message: okMatch[1], ts,
          })
          push('payload:progress', {
            agentId, jobId: job.job_id, company: job.company_slug,
            title: job.job_title, platform: job.platform, applyUrl: job.apply_url,
            state: 'done', message: `✓ ${okMatch[1]}`,
          })
          const entry: RunResult = { company: job.company_slug, jobId: job.job_id, platform: job.platform, title: job.job_title, applyUrl: job.apply_url, status: 'submitted', message: okMatch[1], via: hooks ? 'auto' : 'manual', ts, ...(detailsPath ? { detailsPath } : {}) }
          runResults.push(entry)
          recordApplied(entry)
          // Append to persistent applied-jobs log (never cleared on reset)
          const existing = (store.get('appliedJobIds') as string[] | undefined) ?? []
          // Platform-qualified from here on, so a numeric greenhouse id can
          // never suppress a different platform's job that shares it. Legacy
          // bare ids already in the store still match -- see isApplied.
          const qualified = jobKey(job.platform, job.job_id)
          if (!existing.includes(qualified) && !existing.includes(job.job_id)) {
            store.set('appliedJobIds', [...existing, qualified] as never)
          }
          // After the record, never before: a submission is durable first.
          if (hooks) {
            if (submit.timedOut) await releaseRow(job, 'submitted; filler stopped after its time limit')
            const report = loopReport({ submittedAs, fillStarted, canceled: t.canceled, timedOut: submit.timedOut, status: 'submitted', detail: okMatch[1] })
            if (report) loopView({ ...hookJob(job), ...report })
            await closeJobTabs(job)
          }
        } else {
          // The killed filler's row would otherwise hold a fill slot.
          if (hooks && submit.timedOut) await releaseRow(job, 'filler stopped after its time limit')
          const fill = await readFillResult(job.platform, job.job_id, submitStartedAt)
          const failMatch = output.match(/Submission failed with status: (\S+)/)
          const status = submit.timedOut ? 'timed_out' : (fill?.status ?? failMatch?.[1] ?? 'failed')
          const reason = submit.timedOut
            ? `: filler stopped after ${Math.round(FILLER_TIMEOUT_MS / 60_000)} minutes`
            : (fill?.reason ? `: ${fill.reason.slice(0, 100)}` : '')
          const failMsg = `${status}${reason}${fill?.tabLeftOpen ? ' — browser tab left open, finish manually' : ''}`
          const needsYou = needsYouReason(status, `${status} ${fill?.reason ?? ''}`)
          let view: HookView | null = null
          if (hooks) {
            const report = loopReport({
              submittedAs: null, fillStarted, canceled: t.canceled, timedOut: submit.timedOut,
              status, detail: `${status} ${fill?.reason ?? ''}`,
            })
            if (report) view = loopView({ ...hookJob(job), ...report })
            await closeJobTabs(job)
          }
          const shown = failureShown({ board: `✗ ${failMsg}`, log: failMsg, needsYou }, view ? { view } : null)
          const ts = new Date().toISOString()
          const detailsPath = await writeApplicationRecord({
            job, fields: built.fields, answers: built.answers,
            status: 'failed', message: shown.log, ts,
          })
          push('payload:progress', {
            agentId, jobId: job.job_id, company: job.company_slug,
            title: job.job_title, platform: job.platform, applyUrl: job.apply_url,
            state: 'failed', message: shown.board,
            ...(shown.skipped ? { skipped: true } : {}),
            ...(shown.needsYou ? { needsYou: shown.needsYou } : {}),
          })
          const entry: RunResult = { company: job.company_slug, jobId: job.job_id, platform: job.platform, title: job.job_title, applyUrl: job.apply_url, status: 'failed', message: shown.log, ...(shown.needsYou ? { needsYou: shown.needsYou } : {}), via: shown.via, ts, ...(detailsPath ? { detailsPath } : {}) }
          runResults.push(entry)
          recordApplied(entry)
        }
      } catch (err) {
        const errMsg = String(err)
        let view: HookView | null = null
        if (hooks) {
          const report = loopReport({ submittedAs, fillStarted, canceled: t.canceled, timedOut: false, status: 'error', detail: errMsg })
          if (!report) { stoppedBeforeFill(job, agentId); continue }
          view = loopView({ ...hookJob(job), ...report })
          await closeJobTabs(job)
          // Submitted, and recorded as such, before whatever threw: nothing to add.
          if (report.submitted) {
            console.error(`[loop] after submitting ${job.platform}/${job.job_id}:`, errMsg.slice(0, 200))
            continue
          }
        }
        const shown = failureShown({ board: errMsg.slice(0, 120), log: errMsg.slice(0, 120) }, view ? { view } : null)
        push('payload:progress', {
          agentId, jobId: job.job_id, company: job.company_slug,
          title: job.job_title, platform: job.platform, applyUrl: job.apply_url,
          state: 'failed', message: shown.board,
          ...(shown.skipped ? { skipped: true } : {}),
        })
        const entry: RunResult = { company: job.company_slug, jobId: job.job_id, platform: job.platform, title: job.job_title, applyUrl: job.apply_url, status: 'failed', message: shown.log, via: shown.via, ts: new Date().toISOString() }
        runResults.push(entry)
        recordApplied(entry)
      }
    }
  }

  // Run agentCount agents concurrently
  await Promise.all(
    Array.from({ length: agentCount }, (_, i) => runAgent(`app-${i}`))
  )

  // Persist results before transitioning — DoneScreen pulls via invoke after mounting
  store.set('doneSummary', runResults as unknown as never)
  store.set('payloadInputHash', payloadHash())

  // Append every result (success + failure) to the persistent applied-jobs log
  // so AppliedJobsPanel can show full history across cycles, tagged by run mode.
  const existingLog = ((store.get('appliedJobsLog') as RunResult[] | undefined) ?? [])
  const seenKey = new Set(existingLog.map(r => `${r.platform}:${r.jobId}:${r.status}:${r.ts}`))
  const merged = existingLog.slice()
  for (const r of runResults) {
    const key = `${r.platform}:${r.jobId}:${r.status}:${r.ts}`
    if (!seenKey.has(key)) { merged.unshift(r); seenKey.add(key) }
  }
  // Unlimited history (per user request) — every application stays reachable
  // with its Q&A record.
  store.set('appliedJobsLog', merged as unknown as never)

  if (!t.canceled) setState('done')
}

// ─── Fetch / Rebuild ──────────────────────────────────────────────────────────

const FETCH_LINES_CAP = 500

function emptyFetchSnapshot(): FetchSnapshot {
  return {
    status: 'idle', phase: 'load',
    companiesTotal: null, companiesDone: null, jobsSoFar: null,
    jobsAdded: null, errorCount: null, emptyBoards: null,
    durations: {}, startedAt: null, finishedAt: null, exitCode: null,
    errorMessage: null, lastDurationSec: null,
  }
}

let _fetchSnapshot: FetchSnapshot = emptyFetchSnapshot()
let _fetchLines: string[] = []

export function getFetchState(): FetchSnapshot & { lines: string[] } {
  return { ..._fetchSnapshot, lines: _fetchLines.slice() }
}

function parseNum(v: string): number { return parseInt(v.replace(/,/g, ''), 10) }

// Milestone-line parser. Formats grounded in the CLI source
// (jobscan/cmd/fetch.go): its mpb progress bars render nothing on a pipe,
// so these plain Printf lines are all the Electron spawn ever receives.
const FETCH_RULES: Array<{ re: RegExp; apply: (m: RegExpMatchArray, s: FetchSnapshot) => void }> = [
  { re: /^Loaded company data:\s+(\S+)/,                 apply: (m, s) => { s.durations.load = m[1] } },
  { re: /^Fetching ([\d,]+) companies across platforms/, apply: (m, s) => { s.companiesTotal = parseNum(m[1]); s.phase = 'fetch' } },
  { re: /^Network fetch \+ DB inserts:\s+(\S+)/,         apply: (m, s) => { s.durations.fetch = m[1]; s.phase = 'fts' } },
  { re: /^Building full-text search index/,              apply: (_m, s) => { s.phase = 'fts' } },
  { re: /^Created FTS table:\s+(\S+)/,                   apply: (m, s) => { s.durations.ftsTable = m[1] } },
  { re: /^Rebuilt FTS index:\s+(\S+)/,                   apply: (m, s) => { s.durations.ftsRebuild = m[1] } },
  { re: /^Created FTS triggers:\s+(\S+)/,                apply: (m, s) => { s.durations.ftsTriggers = m[1] } },
  { re: /^Creating database indexes/,                    apply: (_m, s) => { s.phase = 'index' } },
  { re: /^Created SQL indexes:\s+(\S+)/,                 apply: (m, s) => { s.durations.index = m[1]; s.phase = 'finalize' } },
  { re: /^Checkpointed database:\s+(\S+)/,               apply: (m, s) => { s.durations.checkpoint = m[1] } },
  { re: /^Swapped database:\s+(\S+)/,                    apply: (m, s) => { s.durations.swap = m[1] } },
  { re: /^✓?\s*Fetch complete in (.+)$/,                 apply: (m, s) => { s.durations.total = m[1].trim(); s.phase = 'done' } },
  { re: /^([\d,]+) jobs from companies$/,                apply: (m, s) => { s.jobsAdded = parseNum(m[1]) } },
  { re: /^([\d,]+) errors?, ([\d,]+) empty boards$/,     apply: (m, s) => { s.errorCount = parseNum(m[1]); s.emptyBoards = parseNum(m[2]) } },
  { re: /^error:?\s+(.+)$/i,                             apply: (m, s) => { s.errorMessage = s.errorMessage ? `${s.errorMessage}\n${m[1]}` : m[1] } },
]

// Buffer + stream a cleaned output line; parse milestones into the snapshot.
// Unmatched lines land in the log buffer only (tolerant fallback).
function recordFetchLine(line: string): void {
  const trimmed0 = line.trim()
  // Live progress lines (1/s while fetching) — update the snapshot but keep
  // them out of the details log and fetch:data stream (pure noise there).
  const prog = trimmed0.match(/^PROGRESS companies=(\d+)\/(\d+) jobs=(\d+)$/)
  if (prog) {
    _fetchSnapshot.companiesDone = parseNum(prog[1])
    _fetchSnapshot.companiesTotal = parseNum(prog[2])
    _fetchSnapshot.jobsSoFar = parseNum(prog[3])
    _fetchSnapshot.phase = 'fetch'
    push('fetch:progress', { ..._fetchSnapshot })
    return
  }

  _fetchLines.push(line)
  if (_fetchLines.length > FETCH_LINES_CAP) _fetchLines.shift()
  push('fetch:data', { line })
  const trimmed = line.trim()
  for (const rule of FETCH_RULES) {
    const m = trimmed.match(rule.re)
    if (m) {
      rule.apply(m, _fetchSnapshot)
      push('fetch:progress', { ..._fetchSnapshot })
      return
    }
  }
}

/**
 * How long a cancelled fetch gets to abandon its rebuild before it is forced
 * (macOS/Linux). Past the network phase it only checks between stages, and a
 * stage can outlast this; jobscan then clears the leftover file at its next
 * start.
 */
const FETCH_STOP_GRACE_MS = 10_000

export async function runFetch(): Promise<void> {
  await withToken(async t => {
    setState('fetching')

    _fetchSnapshot = {
      ...emptyFetchSnapshot(),
      status: 'running',
      startedAt: Date.now(),
      lastDurationSec: ((store.get('lastFetchDurationSec') as number) || null),
    }
    _fetchLines = []
    push('fetch:progress', { ..._fetchSnapshot })

    const exePath = store.get('jobscanExePath') as string
    const dbPath = getDbPath()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JOB_AUTOMATOR_HOME:       store.get('jobAutomatorHome') as string,
      JOB_AUTOMATOR_PYTHON_DIR: store.get('pythonDir') as string,
      PYTHON:                   automatorPython(),
      PYTHONDONTWRITEBYTECODE:  '1',
      NO_COLOR: '1',
      TERM: 'dumb',
    }

    // Use regular spawn instead of node-pty for reliability across platforms.
    // node-pty (PTY) had native module loading issues in packaged Electron on Mac.
    // Lines stream to FetchScreen as fetch:data; parsed milestones as fetch:progress.
    const child = spawn(exePath, ['--db', dbPath, 'fetch', '--rebuild', '--progress-lines'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...treeSpawnOptions(),
    })
    // A cancel asks fetch to stop (it abandons the rebuild, jobs.db untouched)
    // before forcing it. macOS/Linux; Windows ends it by force.
    stopGently(child, FETCH_STOP_GRACE_MS)
    t.children.add(child)

    const STRIP_ANSI = /\x1b\[[0-9;]*[mGKHFJA-Da-d]|\x1b[()][A-Z0-9]|\x1b[=>]|\r/g
    function pushLines(chunk: Buffer): void {
      const clean = chunk.toString().replace(STRIP_ANSI, '')
      for (const raw of clean.split('\n')) {
        const line = raw.trimEnd()
        if (line.trim()) recordFetchLine(line)
      }
    }

    child.stdout?.on('data', pushLines)
    child.stderr?.on('data', pushLines)

    let finished = false
    const finishFetch = (code: number | null): void => {
      if (finished) return  // 'close' can follow 'error' on spawn failure
      finished = true
      const s = _fetchSnapshot
      const success = code === 0 && !t.canceled
      s.status = t.canceled ? 'canceled' : success ? 'success' : 'failed'
      s.finishedAt = Date.now()
      s.exitCode = code ?? -1
      const elapsedSec = Math.round((s.finishedAt - (s.startedAt ?? s.finishedAt)) / 1000)
      if (success) {
        store.set('lastFetchAt', new Date().toISOString() as never)
        store.set('lastFetchDurationSec', elapsedSec as never)
      }
      push('fetch:progress', { ...s })
      push('fetch:done', {
        success, exitCode: s.exitCode, elapsedSec,
        jobsAdded: s.jobsAdded, errorCount: s.errorCount, emptyBoards: s.emptyBoards,
      })

      if (t.canceled) {
        // User asked out — return to Resume immediately.
        setState('resume')
      }
      // Success AND failure both stay on 'fetching': success shows the stats
      // until the user clicks Continue; failure shows the error until Back or
      // Retry. Both dismiss via fetch:cancel. No auto-navigation.
    }

    // The spelling index is derived from the corpus, so it has to be rebuilt
    // when the corpus changes. Without it every query matches terms exactly and
    // `fullstack` reaches 6% of the full-stack jobs. ~22s against a 2.6GB
    // database, after a fetch that takes minutes.
    const buildTermIndex = (): Promise<void> => new Promise<void>(done => {
      recordFetchLine('Indexing search terms...')
      const indexer = spawn(exePath, ['--db', dbPath, 'db', 'build-terms'], {
        env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...treeSpawnOptions(),
      })
      stopGently(indexer, FETCH_STOP_GRACE_MS)
      t.children.add(indexer)
      indexer.stdout?.on('data', pushLines)
      indexer.stderr?.on('data', pushLines)
      const settle = (): void => { t.children.delete(indexer); done() }
      indexer.on('close', settle)
      // An older binary has no `db build-terms`. Search still works, it just
      // matches exactly — so this must never fail the fetch.
      indexer.on('error', settle)
    })

    await new Promise<void>(resolve => {
      child.on('close', async (code) => {
        t.children.delete(child)
        if (code === 0 && !t.canceled) await buildTermIndex()
        finishFetch(code)
        resolve()
      })
      child.on('error', (err) => {
        t.children.delete(child)
        recordFetchLine(`Error: ${err.message}`)  // parser rule also sets errorMessage
        finishFetch(null)
        resolve()
      })
    })
  })
}
