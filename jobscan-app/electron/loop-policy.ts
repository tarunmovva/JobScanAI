/**
 * Loop mode's decisions — pure: no Electron, no store, no I/O.
 *
 * Which jobs a round picks, what each job's result means for the loop, when a
 * platform that keeps showing CAPTCHAs is paused, which saved searches may
 * run, how long to wait out a Codex usage limit, and when the next round
 * starts. The conductor (loop-runner.ts) owns time and side effects; every
 * rule it applies lives here so it can be tested exhaustively.
 */
import type {
  BreakerState, CodexWindow, ExclusionEntry, LoopSettings, LoopState, Outcome,
  RateLimitSnapshot, RoundRecord, SelectableJob,
} from '../src/types'
import { isCaptchaOutcome, needsYouReason } from './needs-you'

export const DEFAULT_LOOP_SETTINGS: LoopSettings = {
  threshold: 8, dailyLimit: 25, minGapMin: 60,
}

/** Two CAPTCHAs with no submission between them pause a platform for 3 h,
 *  doubling on each repeat trip, capped at a day. */
export const BREAKER = { tripAfter: 2, baseHours: 3, maxHours: 24 } as const
export const MAX_ATTEMPTS = 2
export const HISTORY_CAP = 100
export const MAX_FAILED_ROUNDS = 3
export const FILLER_TIMEOUT_MS = 25 * 60_000
export const ROUND_TIMEOUT_MS = 3 * 3_600_000

/** Wait this long past a Codex window's reset before trying again. */
const RESET_MARGIN_MS = 2 * 60_000
const BACKOFF_HOURS = [1, 2, 4, 8, 16, 24]

const HOUR_MS = 3_600_000

export function emptyLoopState(): LoopState {
  return {
    excluded: {}, attempts: {}, inFlight: {},
    day: { date: '', attempted: 0 },
    history: [], lastStopReason: '', active: null,
  }
}

/**
 * Written as ratingFingerprint when an engine settles over ratings made under
 * different fingerprints. Never equal to a real one, and not '' -- '' means
 * "saved before loop mode", which the loop may adopt.
 */
export const MIXED_FINGERPRINT = 'mixed'

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

/**
 * The settings, each within its range. Anything else is dropped -- such as
 * the market list an earlier build kept: the loop's searches run as the
 * query agent wrote them from the target location, exactly as in a manual
 * run, with no market rule of the loop's own.
 */
export function clampSettings(p: Partial<LoopSettings>): LoopSettings {
  return {
    threshold: clampInt(p?.threshold, 1, 10, DEFAULT_LOOP_SETTINGS.threshold),
    dailyLimit: clampInt(p?.dailyLimit, 1, 500, DEFAULT_LOOP_SETTINGS.dailyLimit),
    minGapMin: clampInt(p?.minGapMin, 15, 1440, DEFAULT_LOOP_SETTINGS.minGapMin),
  }
}

export function jobKey(platform: string, jobId: string): string {
  return `${platform}:${jobId}`
}

/** Local calendar day, `YYYY-MM-DD`. The daily limit is per local day. */
export function localDay(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// ── outcomes ────────────────────────────────────────────────────────────────

/**
 * A Codex usage limit. Only this may stop a whole round, so a job board's own
 * "rate limit" (an HTTP 429 from Greenhouse) must not match.
 */
export function isCodexLimit(text: string): boolean {
  const t = String(text ?? '')
  if (/usage[ _]?limit|usageLimitExceeded/i.test(t)) return true
  return /codex/i.test(t) && /rate[ _]?limit/i.test(t)
}

/** Codex could not serve the turn: a limit, or the process died. Not the job's fault. */
export function isCodexFailure(text: string): boolean {
  return isCodexLimit(text) || /Codex exited/i.test(String(text ?? ''))
}

/**
 * A submit was clicked but no confirmation was seen: the application may
 * have gone in. Mirrors jobscan's submission_signals.UNSETTLED_STATUSES
 * (Greenhouse ends with 'clicked', Lever and Ashby with 'not_confirmed').
 * A normal run leaves these tabs open for the user to check; the loop closes
 * them, so it must never try the job again.
 */
export const UNSETTLED_STATUSES: ReadonlySet<string> = new Set(['not_confirmed', 'clicked'])

export function classifyOutcome(status: string, detail: string): Outcome {
  const s = String(status ?? '').trim()
  if (s === 'submitted') return 'submitted'
  if (isCaptchaOutcome(s, detail)) return 'captcha'
  if (needsYouReason(s, detail)) return 'needs_person'
  if (s === 'posting_closed') return 'closed'
  if (UNSETTLED_STATUSES.has(s)) return 'unconfirmed'
  if (isCodexFailure(`${s} ${detail ?? ''}`)) return 'codex'
  return 'retryable'
}

// ── the platform breaker ────────────────────────────────────────────────────

export function isPaused(b: BreakerState, platform: string, now: Date): boolean {
  const until = b?.[platform]?.pausedUntil
  return !!until && Date.parse(until) > +now
}

/**
 * Count one job result against its platform.
 *
 * Only a CAPTCHA moves the breaker, and only a submission resets it: other
 * failures between two CAPTCHAs still leave two strikes. A CAPTCHA that
 * arrives while the platform is already paused came from a fill that was
 * running when the pause began, and changes nothing.
 */
export function recordBreaker(
  b: BreakerState, platform: string, outcome: Outcome, now: Date,
): { breaker: BreakerState; tripped: boolean } {
  if (outcome === 'submitted') {
    if (!(platform in (b ?? {}))) return { breaker: b, tripped: false }
    const rest = { ...b }
    delete rest[platform]
    return { breaker: rest, tripped: false }
  }
  if (outcome !== 'captcha') return { breaker: b, tripped: false }
  if (isPaused(b, platform, now)) return { breaker: b, tripped: false }

  const entry = b?.[platform] ?? { consecutive: 0, trips: 0, pausedUntil: '' }
  const consecutive = entry.consecutive + 1
  // After a pause, the platform is on probation: one CAPTCHA re-pauses it.
  const threshold = entry.trips > 0 ? 1 : BREAKER.tripAfter
  if (consecutive < threshold) {
    return { breaker: { ...b, [platform]: { ...entry, consecutive } }, tripped: false }
  }
  const trips = entry.trips + 1
  const hours = Math.min(BREAKER.baseHours * 2 ** (trips - 1), BREAKER.maxHours)
  const pausedUntil = new Date(+now + hours * HOUR_MS).toISOString()
  return { breaker: { ...b, [platform]: { consecutive: 0, trips, pausedUntil } }, tripped: true }
}

// ── daily count, exclusions, attempts ───────────────────────────────────────

/** A filler started: it counts toward today, and is in flight until its result. */
export function markStarted(s: LoopState, key: string, now: Date): LoopState {
  const today = localDay(now)
  const attempted = s.day.date === today ? s.day.attempted + 1 : 1
  return {
    ...s,
    day: { date: today, attempted },
    inFlight: { ...s.inFlight, [key]: now.toISOString() },
  }
}

const EXCLUDING: ReadonlySet<Outcome> = new Set<Outcome>(['captcha', 'needs_person', 'closed', 'interrupted', 'unconfirmed'])

export function recordOutcome(
  s: LoopState, key: string, outcome: Outcome, status: string, now: Date,
  meta?: { title?: string; company?: string },
): LoopState {
  const inFlight = { ...s.inFlight }
  delete inFlight[key]
  const at = now.toISOString()
  const entry = (reason: ExclusionEntry['reason']): ExclusionEntry => ({
    reason, at,
    ...(meta?.title ? { title: meta.title } : {}),
    ...(meta?.company ? { company: meta.company } : {}),
  })

  if (EXCLUDING.has(outcome)) {
    return { ...s, inFlight, excluded: { ...s.excluded, [key]: entry(outcome) } }
  }
  if (outcome === 'retryable') {
    const count = (s.attempts[key]?.count ?? 0) + 1
    const attempts = { ...s.attempts, [key]: { count, lastStatus: status, at } }
    const excluded = count >= MAX_ATTEMPTS ? { ...s.excluded, [key]: entry('attempts') } : s.excluded
    return { ...s, inFlight, attempts, excluded }
  }
  return { ...s, inFlight }
}

/**
 * Jobs still in flight were cut off mid-fill (Stop now, a timeout, a crash).
 * The filler may already have clicked submit, so the loop never picks them
 * again; a normal run still can.
 */
export function sweepInterrupted(s: LoopState, now: Date): LoopState {
  const keys = Object.keys(s.inFlight)
  if (keys.length === 0) return s
  const excluded = { ...s.excluded }
  for (const key of keys) excluded[key] = { reason: 'interrupted', at: now.toISOString() }
  return { ...s, inFlight: {}, excluded }
}

/** Fewer results than this cannot tell a broken setup from a few bad jobs. */
const SYSTEMIC_MIN_RESULTS = 3

/** Outcomes a broken setup produces: Chrome unreachable, a reader that crashes, a filler that hangs. */
const SETUP_FAILURES: ReadonlySet<Outcome> = new Set<Outcome>(['retryable', 'codex', 'interrupted'])

/**
 * Did the round fail as a whole, rather than some of its jobs? Then it counts
 * toward stopping the loop -- the old scheduler's "failures did not fail" is
 * exactly a round like these passing as complete.
 *
 * - Codex failing on every application (it exited; a usage limit is handled
 *   before this): not the jobs' fault, so one is enough.
 * - Every application failing like a broken setup: three at least, since
 *   fewer cannot tell a broken setup from a few bad jobs.
 *
 * Never when anything was submitted, and never for unconfirmed submits:
 * those may have gone in.
 */
export function roundFailure(outcomes: Outcome[]): string | null {
  const o = outcomes ?? []
  if (o.length === 0 || o.includes('submitted')) return null
  if (o.every(x => x === 'codex')) return 'Codex failed on every application'
  if (o.length >= SYSTEMIC_MIN_RESULTS && o.every(x => SETUP_FAILURES.has(x))) return 'Every application failed'
  return null
}

/**
 * Take back the attempts a failed round charged to `keys`, as they were in
 * `before` -- including an exclusion for too many attempts that the round
 * itself caused. Exclusions that predate the round stay, and so does every
 * other kind: a fill that was cut off may have gone in.
 */
export function forgiveAttempts(s: LoopState, keys: string[], before: LoopState): LoopState {
  const attempts = { ...s.attempts }
  const excluded = { ...s.excluded }
  for (const key of keys ?? []) {
    if (before.attempts[key]) attempts[key] = before.attempts[key]
    else delete attempts[key]
    if (!before.excluded[key] && excluded[key]?.reason === 'attempts') delete excluded[key]
  }
  return { ...s, attempts, excluded }
}

export function remainingToday(s: LoopState, settings: LoopSettings, now: Date): number {
  if (s.day.date !== localDay(now)) return settings.dailyLimit
  return Math.max(0, settings.dailyLimit - s.day.attempted)
}

/**
 * Jobs a normal run left open for the user. They may have finished them by
 * hand, and the app would never know — so the loop never picks them.
 */
export function leftOpenKeys(
  log: Array<{ platform: string; jobId: string; status: string; message?: string; needsYou?: string }>,
): Set<string> {
  const keys = new Set<string>()
  for (const e of log ?? []) {
    if (!e || e.status === 'submitted') continue
    if (e.needsYou || /tab left open/i.test(String(e.message ?? ''))) keys.add(jobKey(e.platform, e.jobId))
  }
  return keys
}

// ── searches ───────────────────────────────────────────────────────────────

const REPLACED_FLAGS = ['--since', '--sort', '--limit', '--offset']

/** The same search, newest first, posted on or after `sinceDate`. */
export function newPostingsTokens(tokens: string[], sinceDate: string): string[] {
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (REPLACED_FLAGS.includes(t)) { i++; continue }
    if (REPLACED_FLAGS.some(f => t.startsWith(`${f}=`))) continue
    out.push(t)
  }
  return [...out, '--sort', 'newest', '--since', sinceDate, '--limit', '100']
}

// ── selection ───────────────────────────────────────────────────────────────

type SkipReason = 'below' | 'applied' | 'left_open' | 'excluded' | 'paused' | 'attempts' | 'over_limit'

export function selectForRound(
  rated: SelectableJob[],
  ctx: {
    settings: LoopSettings
    state: LoopState
    breaker: BreakerState
    isApplied: (platform: string, jobId: string) => boolean
    leftOpen: Set<string>
    now: Date
  },
): { selected: SelectableJob[]; skipped: Record<SkipReason, number> } {
  const skipped: Record<SkipReason, number> = {
    below: 0, applied: 0, left_open: 0, excluded: 0, paused: 0, attempts: 0, over_limit: 0,
  }
  const eligible: SelectableJob[] = []
  const seen = new Set<string>()
  for (const job of rated ?? []) {
    const key = jobKey(job.platform, job.job_id)
    if (seen.has(key)) continue
    seen.add(key)
    if (!(Number(job.rating) >= ctx.settings.threshold)) { skipped.below++; continue }
    if (ctx.isApplied(job.platform, job.job_id)) { skipped.applied++; continue }
    if (ctx.leftOpen.has(key)) { skipped.left_open++; continue }
    if (ctx.state.excluded[key]) { skipped.excluded++; continue }
    if (isPaused(ctx.breaker, job.platform, ctx.now)) { skipped.paused++; continue }
    if ((ctx.state.attempts[key]?.count ?? 0) >= MAX_ATTEMPTS) { skipped.attempts++; continue }
    eligible.push(job)
  }
  eligible.sort((a, b) =>
    b.rating - a.rating
    || String(b.posted_at ?? '').localeCompare(String(a.posted_at ?? ''))
    || a.id.localeCompare(b.id))
  const limit = remainingToday(ctx.state, ctx.settings, ctx.now)
  const selected = eligible.slice(0, limit)
  skipped.over_limit = eligible.length - selected.length
  return { selected, skipped }
}

// ── timing ──────────────────────────────────────────────────────────────────

/**
 * When the next round may start: the gap after this one started, never in
 * the past, and — once today's limit is used up — not before local midnight,
 * so the loop does not rebuild every hour with nothing it may pick.
 */
export function nextRoundAt(
  roundStartedAt: Date, settings: LoopSettings, now: Date, remainingToday: number,
): Date {
  let at = Math.max(+now, +roundStartedAt + settings.minGapMin * 60_000)
  if (remainingToday <= 0) {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
    at = Math.max(at, +midnight)
  }
  return new Date(at)
}

// ── ratings ─────────────────────────────────────────────────────────────────

export function carryForward<J extends { platform: string; job_id: string }, R extends J>(
  rated: R[], pool: J[], sameFingerprint: boolean,
): { seed: R[]; toRate: J[] } {
  if (!sameFingerprint) return { seed: [], toRate: [...pool] }
  const inPool = new Set(pool.map(j => jobKey(j.platform, j.job_id)))
  const seed = rated.filter(r => inPool.has(jobKey(r.platform, r.job_id)))
  const ratedKeys = new Set(seed.map(r => jobKey(r.platform, r.job_id)))
  const toRate = pool.filter(j => !ratedKeys.has(jobKey(j.platform, j.job_id)))
  return { seed, toRate }
}

/**
 * Do the stored ratings still hold? With no stored fingerprint (the first
 * round after this shipped), the ratings are adopted when the manual cache
 * says they are current, rather than re-rating the whole pool.
 */
export function fingerprintMatches(stored: string, current: string, legacyHashMatches: boolean): boolean {
  if (!stored) return legacyHashMatches
  return stored === current
}

/**
 * Must the saved searches be regenerated? Only when what they were generated
 * from has changed. Searches saved before loop mode carry no inputs hash;
 * they are taken as current -- regenerating on that alone would spend Codex
 * turns and swap the pool for nothing. The search stage records the hash.
 */
export function queriesStale(stored: string, current: string): boolean {
  return !!stored && stored !== current
}

/**
 * Did rating work? More than half of what it was given without a score is a
 * failure, whether the batches threw or Codex answered with almost nothing.
 */
export function ratingHealth(
  r: { enqueued: number; newlyRated: number; failedJobs: number; lastError: string },
): 'ok' | 'failed' | 'codex_limit' {
  if (r.enqueued <= 0) return 'ok'
  const unrated = Math.max(r.failedJobs, r.enqueued - r.newlyRated)
  if (unrated * 2 <= r.enqueued) return 'ok'
  return isCodexLimit(r.lastError) ? 'codex_limit' : 'failed'
}

export function pushHistory(s: LoopState, r: RoundRecord): LoopState {
  return { ...s, history: [r, ...s.history].slice(0, HISTORY_CAP) }
}

// ── Codex usage limits ──────────────────────────────────────────────────────

function windowFromReachedType(type: string): CodexWindow {
  const t = type.toLowerCase()
  if (/week|secondary/.test(t)) return 'weekly'
  if (/primary|hour|session|short/.test(t)) return '5-hour'
  return 'unknown'
}

/**
 * Which Codex window has run out, if any. `primary` is the 5-hour window and
 * `secondary` the weekly one. When both have, the later reset is the one that
 * matters.
 */
export function exhaustedWindow(
  snap: RateLimitSnapshot | null,
): { window: CodexWindow; resetsAt: number | null } | null {
  if (!snap) return null
  const reached = snap.rateLimitReachedType ? windowFromReachedType(snap.rateLimitReachedType) : null
  const out: Array<{ window: CodexWindow; resetsAt: number | null }> = []
  if (snap.primary && (snap.primary.usedPercent >= 100 || reached === '5-hour')) {
    out.push({ window: '5-hour', resetsAt: snap.primary.resetsAt ?? null })
  }
  if (snap.secondary && (snap.secondary.usedPercent >= 100 || reached === 'weekly')) {
    out.push({ window: 'weekly', resetsAt: snap.secondary.resetsAt ?? null })
  }
  if (out.length > 0) return out.sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0]
  if (snap.ordinaryUsageAllowed === false || reached === 'unknown') return { window: 'unknown', resetsAt: null }
  return null
}

const UNIT_MS: Record<string, number> = { day: 86_400_000, hour: HOUR_MS, minute: 60_000, second: 1_000 }

/** "…try again in 2 days 3 hours 52 minutes." → that moment. */
export function parseTryAgainIn(text: string, now: Date): Date | null {
  const m = /try again in\s+([^.]*)/i.exec(String(text ?? ''))
  if (!m) return null
  let ms = 0
  let found = false
  const re = /(\d+)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/gi
  for (let u = re.exec(m[1]); u; u = re.exec(m[1])) {
    const unit = u[2].toLowerCase()
    const key = unit.startsWith('d') ? 'day' : unit.startsWith('h') ? 'hour' : unit.startsWith('m') ? 'minute' : 'second'
    ms += Number(u[1]) * UNIT_MS[key]
    found = true
  }
  return found ? new Date(+now + ms) : null
}

/**
 * How long to wait out a Codex limit: the exhausted window's reset plus a
 * margin; else what the error text says; else a backoff that doubles up to a
 * day. A known reset restarts the backoff.
 */
export function codexWaitUntil(
  o: { snap: RateLimitSnapshot | null; errorText: string; now: Date; backoffStep: number },
): { until: Date; window: CodexWindow; nextBackoffStep: number } {
  const ex = exhaustedWindow(o.snap)
  if (ex?.resetsAt) {
    const until = Math.max(+o.now + 60_000, ex.resetsAt * 1000 + RESET_MARGIN_MS)
    return { until: new Date(until), window: ex.window, nextBackoffStep: 0 }
  }
  const parsed = parseTryAgainIn(o.errorText, o.now)
  if (parsed) {
    return { until: new Date(+parsed + RESET_MARGIN_MS), window: ex?.window ?? 'unknown', nextBackoffStep: 0 }
  }
  const step = Math.max(0, Math.floor(o.backoffStep))
  const hours = BACKOFF_HOURS[Math.min(step, BACKOFF_HOURS.length - 1)]
  return { until: new Date(+o.now + hours * HOUR_MS), window: ex?.window ?? 'unknown', nextBackoffStep: step + 1 }
}
