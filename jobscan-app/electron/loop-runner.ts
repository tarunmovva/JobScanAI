/**
 * Loop mode's conductor: rounds, one after another, unattended, until stopped.
 *
 * A round is fixed: preconditions, rebuild the database, find jobs (new saved
 * searches only when their inputs changed, then every saved search, as the
 * query agent wrote it from the target location -- exactly as a manual run),
 * rate what is new, pick the best jobs within today's limit, apply. After every step the conductor reads what the step reported,
 * never the absence of an error -- the Auto-Apply scheduler this replaces
 * (removed in dbfe25a) failed exactly there: its stop did not stop, and its
 * failures did not fail.
 *
 * Every rule lives in loop-policy.ts; this module owns time, order and side
 * effects, all through `deps`, so the whole conductor runs in unit tests with
 * a manual clock and fake stages.
 */
import {
  MAX_FAILED_ROUNDS, ROUND_TIMEOUT_MS,
  clampSettings, classifyOutcome, codexWaitUntil, emptyLoopState,
  exhaustedWindow, forgiveAttempts, isCodexLimit, isPaused, jobKey, roundFailure,
  leftOpenKeys, localDay, markStarted, nextRoundAt, pushHistory, recordBreaker, recordOutcome,
  remainingToday, selectForRound, sweepInterrupted,
} from './loop-policy'
import type { HookJob, HookResult, HookView, RunHooks } from './run-mode'
import type {
  BreakerState, LoopPhase, LoopSettings, LoopStage, LoopState, LoopStatus, Outcome,
  RateLimitSnapshot, RoundRecord, SelectableJob,
} from '../src/types'

export interface ApplyResult {
  /** The board finished (it can still have failed jobs). */
  ok: boolean
  /**
   * Selected jobs whose application form could not be read: never reached an
   * agent. `setupFailed`: never tried at all, because a command failed.
   */
  extractFailed: Array<{ platform: string; jobId: string; title?: string; company?: string; setupFailed?: true }>
}

export interface LoopDeps {
  /** The engine's name in the loop's messages; 'Codex' when absent. */
  aiName?: () => string
  now(): Date
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(h: unknown): void
  signedIn(): Promise<boolean>
  codexLimits(): Promise<RateLimitSnapshot | null>
  hasResume(): boolean
  exeExists(): boolean
  isBusy(): boolean
  savedQueries(): Array<{ name?: string; flags: string }>
  queriesStale(): boolean
  rebuild(): Promise<'success' | 'failed' | 'canceled'>
  /** New saved searches from the model. The pool is not touched; research builds it. */
  regenerate(): Promise<{ ok: boolean; newJobs: number; error?: string }>
  research(o: { sinceDate: string | null }): Promise<{ ok: boolean; newJobs: number; error?: string }>
  rate(): Promise<{ health: 'ok' | 'failed' | 'codex_limit'; enqueued: number; newlyRated: number; failedJobs: number; lastError: string }>
  ratedJobs(): SelectableJob[]
  isApplied(platform: string, jobId: string): boolean
  appliedLog(): Array<{ platform: string; jobId: string; status: string; message?: string; needsYou?: string }>
  apply(ids: string[]): Promise<ApplyResult>
  cancelPipeline(reason: string): Promise<void>
  /** Skip a paused platform's jobs still waiting in this round; `reason` goes on their cards. */
  sweepPlatform(platform: string, reason: string): void
  closeTabsFor(applyUrl: string): void
  load(): { settings: LoopSettings; state: LoopState; breaker: BreakerState }
  saveSettings(s: LoopSettings): void
  saveState(s: LoopState): void
  saveBreaker(b: BreakerState): void
  setUnattended(on: boolean): void
  setHooks(h: RunHooks | null): void
  keepAwake(on: boolean): void
  emit(s: LoopStatus): void
}

export interface Loop {
  start(): Promise<{ ok: true } | { ok: false; reason: string }>
  stopAfterRound(): void
  stopNow(): Promise<void>
  updateSettings(p: Partial<LoopSettings>): LoopSettings
  status(): LoopStatus
  isOn(): boolean
  markClosedByQuit(): void
}

/** Why the loop stopped, or would not start. Exact copy; the panel shows it. */
export const STOP_REASONS = {
  notSignedIn: 'Codex is not signed in',
  noResume: 'No resume',
  noSearches: 'No saved searches — run Find Jobs once first',
  noExe: 'jobscan executable not found',
  busy: 'Another step is still running',
  byYou: 'Stopped by you',
  alreadyOn: 'Loop mode is already on',
} as const

const ROUND_TOO_LONG = 'Round took longer than 3 hours'
const CODEX_LIMIT = 'Codex usage limit'
const NOTHING_REACHED = 'Applying reached none of the picked jobs'

const STAGE_ERRORS: Record<LoopStage, string> = {
  rebuild: 'Rebuild failed',
  search: 'Search failed',
  rate: 'Rating failed',
  apply: 'Applying failed',
}

/** How a round ended. */
type RoundEnd =
  | { kind: 'complete' }
  | { kind: 'failed'; error: string }
  | { kind: 'codex'; errorText: string; snap?: RateLimitSnapshot | null; preRound?: boolean }
  | { kind: 'halted' }
  | { kind: 'precondition'; reason: string }

interface Round {
  number: number
  settings: LoopSettings      // as they were when it started; edits apply next round
  startedAt: Date
  rec: RoundRecord
  stateAtStart: LoopState
  halted: 'stop' | 'timeout' | null
  abort: () => void
  aborted: Promise<typeof ABORTED>
  timer: unknown
  codexLimitText: string | null
  outcomes: Outcome[]
  retryableKeys: string[]
  skippedKeys: Set<string>
  swept: Set<string>
  /** Picked jobs an agent claimed and asked about: they reached the form. */
  reached: Set<string>
  /** The jobs this round picked. An agent may fill no other. */
  picked: Set<string>
}

const ABORTED = Symbol('aborted')

/** Thrown out of a stage when the round was stopped or ran out of time. */
class Halt extends Error {}

const platformName = (p: string): string => (p ? p[0].toUpperCase() + p.slice(1) : p)

function whenText(iso: string, now: Date): string {
  const at = new Date(iso)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  if (localDay(at) === localDay(now)) return hhmm
  return `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm}`
}

export function createLoop(deps: LoopDeps): Loop {
  const aiName = (): string => deps.aiName?.() ?? 'Codex'
  let settings: LoopSettings
  let state: LoopState
  let breaker: BreakerState
  reload()

  let phase: LoopPhase = 'off'
  let stage: LoopStage | null = null
  let roundNumber = 0
  let current: Round | null = null
  let roundRunning = false
  let starting = false
  let stopAfter = false
  let waitTimer: unknown = null
  let nextAt: Date | null = null
  let waitReason: LoopStatus['waitReason'] = ''
  let codexUsage: LoopStatus['codexUsage'] = { fiveHour: null, weekly: null }
  let failedRounds = 0
  let lastFailure = ''
  let backoffStep = 0
  /** Fills under way, for closing their tabs when they are cut off. */
  const liveFills = new Map<string, HookJob>()

  function reload(): void {
    const loaded = deps.load() ?? ({} as ReturnType<LoopDeps['load']>)
    settings = clampSettings(loaded.settings ?? {})
    const s = loaded.state ?? emptyLoopState()
    state = {
      ...emptyLoopState(), ...s,
      excluded: { ...(s.excluded ?? {}) },
      attempts: { ...(s.attempts ?? {}) },
      inFlight: { ...(s.inFlight ?? {}) },
      day: s.day ?? { date: '', attempted: 0 },
      history: Array.isArray(s.history) ? s.history : [],
    }
    breaker = { ...(loaded.breaker ?? {}) }
  }

  const save = (): void => deps.saveState(state)
  const isOn = (): boolean => phase === 'running' || phase === 'stopping' || phase === 'waiting'

  /**
   * While the loop is off, the store is the truth: a profile switch swaps
   * loopSettings and loopState underneath, and the panel must show -- and
   * edit -- the profile that is active now. (Switching is refused while on.)
   */
  function syncWhileOff(): void {
    if (!isOn() && !roundRunning && !starting) reload()
  }

  function status(): LoopStatus {
    syncWhileOff()
    const now = deps.now()
    return {
      phase,
      round: roundNumber,
      stage,
      nextAt: nextAt ? nextAt.toISOString() : null,
      waitReason,
      codexUsage: { ...codexUsage },
      stopReason: state.lastStopReason,
      today: { attempted: state.day.date === localDay(now) ? state.day.attempted : 0, limit: settings.dailyLimit },
      paused: Object.entries(breaker)
        .filter(([platform]) => isPaused(breaker, platform, now))
        .map(([platform, e]) => ({ platform, until: e.pausedUntil })),
      excluded: Object.entries(state.excluded)
        .map(([key, e]) => ({
          key, reason: e.reason, at: e.at,
          ...(e.title ? { title: e.title } : {}),
          ...(e.company ? { company: e.company } : {}),
        }))
        .sort((a, b) => b.at.localeCompare(a.at)),
      history: state.history.slice(0, 10),
      settings: { ...settings },
    }
  }

  const emit = (): void => {
    try { deps.emit(status()) } catch { /* a closed window must not break the loop */ }
  }

  // ── stages ──────────────────────────────────────────────────────────────

  /** Await a stage, unless the round is stopped or out of time first. */
  async function step<T>(r: Round, p: Promise<T>): Promise<T> {
    const v = await Promise.race([p, r.aborted])
    if (v === ABORTED || r.halted) throw new Halt()
    return v as T
  }

  function setStage(s: LoopStage | null): void {
    stage = s
    emit()
  }

  async function preconditionFailure(r: Round | null): Promise<string | null> {
    let signed = false
    try {
      signed = r ? await step(r, deps.signedIn()) : await deps.signedIn()
    } catch (e) {
      if (e instanceof Halt) throw e
      signed = false
    }
    if (!signed) return STOP_REASONS.notSignedIn.replace('Codex', aiName())
    if (!deps.hasResume()) return STOP_REASONS.noResume
    const saved = deps.savedQueries()
    if (saved.length === 0) return STOP_REASONS.noSearches
    if (!deps.exeExists()) return STOP_REASONS.noExe
    if (deps.isBusy()) return STOP_REASONS.busy
    return null
  }

  /** Read the Codex limits; the snapshot when a window has run out, else null. */
  async function exhaustedLimits(r: Round): Promise<{ snap: RateLimitSnapshot } | null> {
    let snap: RateLimitSnapshot | null = null
    try {
      snap = await step(r, deps.codexLimits())
    } catch (e) {
      if (e instanceof Halt) throw e
      snap = null
    }
    noteUsage(snap)
    return snap && exhaustedWindow(snap) ? { snap } : null
  }

  function noteUsage(snap: RateLimitSnapshot | null): void {
    if (!snap) return
    codexUsage = { fiveHour: snap.primary?.usedPercent ?? null, weekly: snap.secondary?.usedPercent ?? null }
  }

  /** The start of the last round that got through its searches. */
  function lastSearchDay(): string | null {
    const last = state.history.find(h => h.searched)
    return last ? localDay(new Date(last.startedAt)) : null
  }

  async function stages(r: Round, checkPreconditions: boolean): Promise<RoundEnd> {
    if (checkPreconditions) {
      const why = await preconditionFailure(r)
      if (why) return { kind: 'precondition', reason: why }
    }
    const before = await exhaustedLimits(r)
    if (before) return { kind: 'codex', errorText: '', snap: before.snap, preRound: true }

    setStage('rebuild')
    if (await step(r, deps.rebuild()) !== 'success') return { kind: 'failed', error: STAGE_ERRORS.rebuild }

    setStage('search')
    if (deps.queriesStale()) {
      const gen = await step(r, deps.regenerate())
      if (!gen.ok) {
        const error = gen.error || 'Search generation failed'
        return isCodexLimit(error) ? { kind: 'codex', errorText: error } : { kind: 'failed', error }
      }
    }
    const found = await step(r, deps.research({ sinceDate: lastSearchDay() }))
    if (!found.ok) return { kind: 'failed', error: found.error || STAGE_ERRORS.search }
    r.rec.newJobs = found.newJobs
    r.rec.searched = true

    const beforeRating = await exhaustedLimits(r)
    if (beforeRating) return { kind: 'codex', errorText: '', snap: beforeRating.snap }
    setStage('rate')
    const rating = await step(r, deps.rate())
    r.rec.newlyRated = rating.newlyRated
    if (rating.health === 'codex_limit') return { kind: 'codex', errorText: rating.lastError }
    if (rating.health !== 'ok') return { kind: 'failed', error: STAGE_ERRORS.rate }
    backoffStep = 0   // got past rating: the unknown-reset backoff starts over

    const { selected } = selectForRound(deps.ratedJobs(), {
      settings: r.settings, state, breaker,
      isApplied: (p, id) => deps.isApplied(p, id),
      leftOpen: leftOpenKeys(deps.appliedLog()),
      now: deps.now(),
    })
    r.rec.selected = selected.length
    if (selected.length === 0) return { kind: 'complete' }   // nothing new above threshold

    const beforeApplying = await exhaustedLimits(r)
    if (beforeApplying) return { kind: 'codex', errorText: '', snap: beforeApplying.snap }
    setStage('apply')
    r.picked = new Set(selected.map(j => jobKey(j.platform, j.job_id)))
    const applied = await step(r, applyWithHooks(r, selected.map(j => j.id)))

    const now = deps.now()
    const forms = applied.extractFailed ?? []
    // Never tried, because a command failed (the queue, the extractor): not
    // the job's doing, so no attempt is charged for it.
    const notTried = new Set(forms.filter(f => f.setupFailed).map(f => jobKey(f.platform, f.jobId)))
    const failedForms = new Set<string>()
    for (const f of forms) {
      if (f.setupFailed) continue
      // The form could not be read, so no agent ever saw the job: an attempt.
      const key = jobKey(f.platform, f.jobId)
      failedForms.add(key)
      state = recordOutcome(state, key, 'retryable', 'extract_failed', now, { title: f.title, company: f.company })
      r.outcomes.push('retryable')
      r.retryableKeys.push(key)
      r.rec.failed++
    }
    if (failedForms.size > 0) save()

    if (r.codexLimitText != null) return { kind: 'codex', errorText: r.codexLimitText }
    if (!applied.ok) return { kind: 'failed', error: STAGE_ERRORS.apply }

    // Picked jobs that no agent ever reached, and whose form did not fail
    // either: the board ended without them. Found live -- extraction gave no
    // answer, nothing claimed the job, and the round passed for complete.
    const unreached = selected.filter(j => {
      const key = jobKey(j.platform, j.job_id)
      return !r.reached.has(key) && !failedForms.has(key)
    })
    if (unreached.length > 0 && unreached.length === selected.length) {
      // Nothing reached at all: the setup failed, not the jobs. No attempt charged.
      r.rec.failed += unreached.length
      return { kind: 'failed', error: NOTHING_REACHED }
    }
    for (const j of unreached) {
      const key = jobKey(j.platform, j.job_id)
      // Never tried, or swept when its platform was paused mid-round: skipped,
      // like the rest of that platform -- the pause is not the job's doing.
      if (notTried.has(key) || r.swept.has(j.platform)) { r.skippedKeys.add(key); continue }
      state = recordOutcome(state, key, 'retryable', 'not_reached', now, { title: j.title, company: j.company })
      r.outcomes.push('retryable')
      r.retryableKeys.push(key)
      r.rec.failed++
    }
    if (unreached.length > 0) save()
    const failure = roundFailure(r.outcomes)
    if (failure) {
      // A broken setup, not bad jobs: give the jobs their attempts back.
      // Cut-off fills stay excluded -- they may have gone in.
      if (r.retryableKeys.length > 0) {
        state = forgiveAttempts(state, r.retryableKeys, r.stateAtStart)
        save()
      }
      return { kind: 'failed', error: failure }
    }
    return { kind: 'complete' }
  }

  async function applyWithHooks(r: Round, ids: string[]): Promise<ApplyResult> {
    deps.setUnattended(true)
    deps.setHooks(hooksFor(r))
    try {
      return await deps.apply(ids)
    } finally {
      deps.setUnattended(false)
      deps.setHooks(null)
    }
  }

  // ── rounds ──────────────────────────────────────────────────────────────

  async function runRound(checkPreconditions = true): Promise<void> {
    if (roundRunning) return   // a late timer while a round runs: ignored
    roundRunning = true
    try {
      await roundBody(checkPreconditions)
    } finally {
      roundRunning = false
    }
  }

  async function roundBody(checkPreconditions: boolean): Promise<void> {
    const startedAt = deps.now()
    roundNumber++
    let abort!: () => void
    const aborted = new Promise<typeof ABORTED>(res => { abort = () => res(ABORTED) })
    const r: Round = {
      number: roundNumber,
      settings: { ...settings },
      startedAt,
      rec: {
        startedAt: startedAt.toISOString(), endedAt: '',
        newJobs: 0, newlyRated: 0, selected: 0, submitted: 0, failed: 0, skipped: 0,
      },
      stateAtStart: state,
      halted: null,
      abort, aborted,
      timer: null,
      codexLimitText: null,
      outcomes: [], retryableKeys: [], skippedKeys: new Set(), swept: new Set(), reached: new Set(),
      picked: new Set(),
    }
    current = r
    nextAt = null
    waitReason = ''
    phase = stopAfter ? 'stopping' : 'running'
    state = { ...state, active: { round: r.number, since: r.rec.startedAt } }
    save()
    r.timer = deps.setTimer(() => { void roundTimedOut(r) }, ROUND_TIMEOUT_MS)
    emit()

    let end: RoundEnd
    try {
      end = await stages(r, checkPreconditions)
    } catch (e) {
      end = e instanceof Halt || r.halted
        ? { kind: 'halted' }
        : { kind: 'failed', error: stage ? STAGE_ERRORS[stage] : 'Round failed' }
      if (!(e instanceof Halt)) console.error('[loop] round failed:', String(e).slice(0, 300))
    } finally {
      deps.clearTimer(r.timer)
    }
    await finishRound(r, end)
  }

  async function finishRound(r: Round, end: RoundEnd): Promise<void> {
    const now = deps.now()
    stage = null
    current = null
    r.rec.endedAt = now.toISOString()
    r.rec.skipped += r.skippedKeys.size
    // Counted even when 0: the round's row can then say "not started" for the
    // rest, where older rounds can only say "not finished".
    r.rec.cutOff ??= 0
    // A fill that started and never reported -- however the round ended --
    // may have gone in: excluded, never picked again.
    if (Object.keys(state.inFlight ?? {}).length > 0) cutOffFills(r)

    if (end.kind === 'precondition') {
      // The round never started; nothing to record.
      state = { ...state, active: null }
      stopLoop('stopped', end.reason)
      return
    }

    if (end.kind === 'complete') {
      failedRounds = 0
    } else if (end.kind === 'failed') {
      r.rec.error = end.error
      failedRounds++
      lastFailure = end.error
    } else if (end.kind === 'codex') {
      r.rec.error = CODEX_LIMIT.replace('Codex', aiName())
      r.rec.codexLimit = true
    } else if (r.halted === 'timeout') {
      r.rec.error = ROUND_TOO_LONG
      failedRounds++
      lastFailure = ROUND_TOO_LONG
    } else {
      r.rec.error = STOP_REASONS.byYou
    }
    state = { ...pushHistory(state, r.rec), active: null }

    if (end.kind === 'halted' && r.halted === 'stop') { stopLoop('off', STOP_REASONS.byYou); return }
    if (failedRounds >= MAX_FAILED_ROUNDS) { stopLoop('stopped', lastFailure); return }
    if (stopAfter) { stopLoop('off', STOP_REASONS.byYou); return }

    const gapAt = nextRoundAt(r.startedAt, settings, now, remainingToday(state, settings, now))
    if (end.kind === 'codex') {
      let snap = end.snap
      if (snap === undefined) {
        // A limit hit mid-round: read the limits again for the reset time.
        try { snap = await deps.codexLimits() } catch { snap = null }
        noteUsage(snap ?? null)
        // A stop pressed during that read must not be lost.
        if (stopAfter) { stopLoop('off', STOP_REASONS.byYou); return }
      }
      const wait = codexWaitUntil({ snap: snap ?? null, errorText: end.errorText, now, backoffStep })
      backoffStep = wait.nextBackoffStep
      waitReason = wait.window === '5-hour' ? 'codex_5h' : wait.window === 'weekly' ? 'codex_weekly' : 'codex_unknown'
      // A round that never started owes no gap; one that ran keeps it.
      schedule(end.preRound ? wait.until : new Date(Math.max(+wait.until, +gapAt)))
    } else {
      waitReason = ''
      schedule(gapAt)
    }
    save()
    emit()
  }

  function schedule(at: Date): void {
    nextAt = at
    phase = 'waiting'
    const ms = Math.max(0, +at - +deps.now())
    waitTimer = deps.setTimer(() => {
      waitTimer = null
      if (phase === 'waiting') void runRound()
    }, ms)
  }

  function stopLoop(to: 'off' | 'stopped', reason: string): void {
    if (waitTimer) { deps.clearTimer(waitTimer); waitTimer = null }
    phase = to
    stage = null
    nextAt = null
    waitReason = ''
    stopAfter = false
    state = { ...state, lastStopReason: reason, active: null }
    save()
    deps.keepAwake(false)
    emit()
  }

  /** Fills under way when a round was cut off may already have gone in. */
  // `r` is the round the fills belong to: it records how many were cut off,
  // so its row can tell them (may have gone in) from jobs that never started.
  function cutOffFills(r: Round | null): void {
    const swept = Object.keys(state.inFlight ?? {}).length
    if (r && swept > 0) r.rec.cutOff = (r.rec.cutOff ?? 0) + swept
    const urls = [...liveFills.values()].map(j => j.apply_url ?? '').filter(Boolean)
    liveFills.clear()
    state = sweepInterrupted(state, deps.now())
    save()
    for (const url of urls) {
      try { deps.closeTabsFor(url) } catch { /* nothing to close */ }
    }
    emit()
  }

  async function roundTimedOut(r: Round): Promise<void> {
    if (current !== r || r.halted) return
    r.halted = 'timeout'
    try { await deps.cancelPipeline('loop:round-timeout') } catch { /* already gone */ }
    cutOffFills(r)
    r.abort()
  }

  // ── the per-job hooks ───────────────────────────────────────────────────

  function viewFor(outcome: Outcome, r: HookResult): HookView {
    switch (outcome) {
      case 'captcha':
        return { asSkipped: true, message: 'CAPTCHA — tab closed; not applied. You can still apply by hand from Rating.' }
      case 'needs_person':
        return { asSkipped: true, message: 'Needs a person (a code or a check) — tab closed; not applied. You can still apply by hand from Rating.' }
      case 'interrupted':
        return { asSkipped: true, message: 'Cut off mid-fill — it may have gone in. Look for a confirmation email before applying by hand.' }
      case 'unconfirmed':
        return { asSkipped: true, message: 'Submit clicked but not confirmed — it may have gone in. Look for a confirmation email before applying by hand.' }
      case 'codex':
        return isCodexLimit(`${r.status} ${r.detail}`)
          ? { asSkipped: true, message: `${aiName()} usage limit — not applied; the loop tries again after the limit resets.` }
          : { asSkipped: true, message: `${aiName()} stopped — not applied; the loop tries again next round.` }
      default:
        return { asSkipped: false }
    }
  }

  function hooksFor(r: Round): RunHooks {
    const skip = (job: HookJob, reason: string): { skip: true; reason: string } => {
      r.skippedKeys.add(jobKey(job.platform, job.job_id))
      return { skip: true, reason }
    }
    return {
      // Only looks: asked twice per job (after the claim, and again before the
      // fill). It notes, for this round only, that the job reached an agent.
      beforeFill(job) {
        // The extractor reads every queued row and agents claim every
        // extracted one: a row another run left behind must not go in here.
        // It is no job of this round's -- not counted, not reached.
        if (!r.picked.has(jobKey(job.platform, job.job_id))) {
          return { skip: true, reason: 'Not picked by this round — not applied.', notPicked: true }
        }
        r.reached.add(jobKey(job.platform, job.job_id))
        if (r.halted) return skip(job, 'The loop stopped — not applied.')
        if (r.codexLimitText != null) {
          return skip(job, `${aiName()} usage limit — not started; the loop tries again after the limit resets.`)
        }
        const now = deps.now()
        if (isPaused(breaker, job.platform, now)) {
          const until = whenText(breaker[job.platform].pausedUntil, now)
          return skip(job, `${platformName(job.platform)} paused until ${until} after repeated CAPTCHAs — not applied. You can still apply by hand.`)
        }
        if (remainingToday(state, r.settings, now) <= 0) {
          return skip(job, "Today's limit reached — not started.")
        }
        return { skip: false }
      },

      onFillStart(job) {
        const key = jobKey(job.platform, job.job_id)
        r.reached.add(key)
        state = markStarted(state, key, deps.now())
        liveFills.set(key, job)
        save()
        emit()
      },

      onResult(res) {
        const now = deps.now()
        const key = jobKey(res.platform, res.job_id)
        r.reached.add(key)
        liveFills.delete(key)
        const outcome: Outcome = res.timedOut ? 'interrupted'
          : res.submitted ? 'submitted'
            : classifyOutcome(res.status, res.detail)
        if (outcome === 'codex' && r.codexLimitText == null && isCodexLimit(`${res.status} ${res.detail}`)) {
          // The first usage limit stops new jobs for the rest of the round.
          r.codexLimitText = res.detail || res.status
        }

        const b = recordBreaker(breaker, res.platform, outcome, now)
        if (b.breaker !== breaker) {
          breaker = b.breaker
          deps.saveBreaker(breaker)
        }
        if (b.tripped && !r.swept.has(res.platform)) {
          r.swept.add(res.platform)
          const until = whenText(breaker[res.platform].pausedUntil, now)
          try {
            deps.sweepPlatform(res.platform,
              `${platformName(res.platform)} paused until ${until} after repeated CAPTCHAs — not applied. You can still apply by hand.`)
          } catch (e) {
            console.error('[loop] sweep failed:', String(e).slice(0, 200))
          }
        }

        state = recordOutcome(state, key, outcome, res.status, now, { title: res.title, company: res.company })
        r.outcomes.push(outcome)
        if (outcome === 'retryable') r.retryableKeys.push(key)
        if (outcome === 'submitted') r.rec.submitted++
        else if (outcome === 'retryable' || outcome === 'closed') r.rec.failed++
        else r.rec.skipped++
        save()
        emit()
        return viewFor(outcome, res)
      },
    }
  }

  // ── controls ────────────────────────────────────────────────────────────

  async function start(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (isOn()) return { ok: false, reason: STOP_REASONS.alreadyOn }
    if (starting || roundRunning) return { ok: false, reason: STOP_REASONS.busy }
    starting = true
    try {
      reload()
      const why = await preconditionFailure(null)
      if (why) return { ok: false, reason: why }
      // Anything still in flight was cut off by a crash or a quit.
      state = { ...sweepInterrupted(state, deps.now()), lastStopReason: '', active: null }
      save()
      liveFills.clear()
      roundNumber = 0
      failedRounds = 0
      lastFailure = ''
      backoffStep = 0
      stopAfter = false
      codexUsage = { fiveHour: null, weekly: null }
      phase = 'running'
      deps.keepAwake(true)
      // The preconditions were just checked; the first round does not repeat them.
      void runRound(false)
      return { ok: true }
    } finally {
      starting = false
    }
  }

  function stopAfterRound(): void {
    if (phase === 'waiting') { stopLoop('off', STOP_REASONS.byYou); return }
    if (phase === 'running') {
      stopAfter = true
      phase = 'stopping'
      emit()
    }
  }

  async function stopNow(): Promise<void> {
    if (phase === 'waiting') { stopLoop('off', STOP_REASONS.byYou); return }
    if (phase !== 'running' && phase !== 'stopping') return
    stopAfter = true
    phase = 'stopping'
    const r = current
    if (r) r.halted = 'stop'
    emit()
    try { await deps.cancelPipeline('loop:stop-now') } catch { /* already gone */ }
    cutOffFills(r ?? null)
    r?.abort()
  }

  function updateSettings(p: Partial<LoopSettings>): LoopSettings {
    syncWhileOff()
    settings = clampSettings({ ...settings, ...(p ?? {}) })
    deps.saveSettings(settings)
    emit()
    return { ...settings }
  }

  function markClosedByQuit(): void {
    if (!isOn()) return
    state = { ...state, lastStopReason: `The app was closed during round ${roundNumber}`, active: null }
    save()
  }

  return { start, stopAfterRound, stopNow, updateSettings, status, isOn, markClosedByQuit }
}
