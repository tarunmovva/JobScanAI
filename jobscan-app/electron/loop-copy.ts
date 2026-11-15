/**
 * What loop mode's chip, legend and start warning say. Pure, and shared with
 * the renderer, so it imports only types.
 */
import type { LoopPhase, LoopSettings, LoopStage, LoopStatus, RoundRecord } from '../src/types'

/** What a refused action says while the loop runs (main refuses, the renderer shows it). */
export const LOOP_ON_MESSAGE = 'Loop mode is on — stop it first'

export const STAGE_LABELS: Record<LoopStage, string> = {
  rebuild: 'Rebuilding',
  search: 'Finding jobs',
  rate: 'Rating',
  apply: 'Applying',
}

/** One entry per chip state; the panel shows them as its legend. */
export const CHIP_LEGEND: Array<{ phase: LoopPhase; label: string; meaning: string }> = [
  { phase: 'off', label: 'Loop', meaning: 'Loop mode is off. Open it to choose what it applies to, then start it.' },
  { phase: 'running', label: 'Round 3 · Applying', meaning: 'A round is running: rebuilding, finding jobs, rating, or applying on its own.' },
  { phase: 'stopping', label: 'Stopping…', meaning: 'The current round finishes, then the loop turns off. Nothing new starts.' },
  { phase: 'waiting', label: 'Next 23:40', meaning: 'Between rounds — or waiting for a Codex usage limit to reset. Nothing is being sent.' },
  { phase: 'stopped', label: 'Stopped — why', meaning: 'The loop stopped itself and says why. Fix that, then start it again.' },
]

const hhmm = (at: Date): string =>
  `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

function clock(at: Date, now: Date): string {
  return sameDay(at, now) ? hhmm(at) : `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm(at)}`
}

export function chipLabel(s: LoopStatus, now: Date): string {
  switch (s.phase) {
    case 'running':
      return s.stage ? `Round ${s.round} · ${STAGE_LABELS[s.stage]}` : `Round ${s.round}`
    case 'stopping':
      return 'Stopping…'
    case 'waiting': {
      const at = s.nextAt ? clock(new Date(s.nextAt), now) : ''
      if (s.waitReason === 'codex_5h') return `Waiting — Codex 5-hour limit · resets ${at}`
      if (s.waitReason === 'codex_weekly') return `Waiting — Codex weekly limit · resets ${at}`
      if (s.waitReason === 'codex_unknown') return `Waiting — Codex usage limit · retry ${at}`
      return at ? `Next ${at}` : 'Waiting'
    }
    case 'stopped':
      return s.stopReason ? `Stopped — ${s.stopReason}` : 'Stopped'
    default:
      return 'Loop'
  }
}

// ── last rounds ─────────────────────────────────────────────────────────────

/**
 * What became of a round's picked jobs. Every picked job lands in exactly one.
 * `cutoff` may have gone in; `unfinished` never started (or, on rounds
 * recorded before cut-offs were counted, cannot be told apart).
 */
export type RoundTone = 'sent' | 'failed' | 'skipped' | 'cutoff' | 'unfinished'

/** One row of the panel's round list: a round, or a run of quiet ones. */
export interface RoundLine {
  key: string
  /** The day the row sits under: Today, Yesterday, or "Sat, Nov 14". */
  day: string
  /** "02:47", or "02:02–02:17" for quiet rounds shown together. */
  time: string
  /** Nothing picked and nothing went wrong: shown muted, and merged with its neighbours. */
  quiet: boolean
  /** Only the non-zero outcomes, sent first. */
  outcome: Array<{ tone: RoundTone; count: number; text: string }>
  /** What the round found and rated. */
  detail: string
  /** Why the round ended early; '' when it did not. */
  note: string
  /** False for an AI usage limit (Codex or Claude Code): waiting for a reset is not a fault. */
  noteIsError: boolean
  /** Every count, for anyone checking the arithmetic. */
  tooltip: string
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function dayLabel(at: Date, now: Date): string {
  if (sameDay(at, now)) return 'Today'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (sameDay(at, yesterday)) return 'Yesterday'
  return at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

/**
 * Picked jobs the round ended without a result for: it was stopped, timed
 * out, or hit an AI usage limit first. Of those, `cutOff` had started filling and
 * may have gone in (they are on the "will not pick again" list); the rest
 * never started. `cutOff` is null on rounds recorded before it was counted.
 */
export function unfinishedCount(r: RoundRecord): { cutOff: number | null; notStarted: number } {
  const gap = Math.max(0, r.selected - r.submitted - r.failed - r.skipped)
  if (r.cutOff === undefined) return { cutOff: null, notStarted: gap }
  const cutOff = Math.min(gap, r.cutOff)
  return { cutOff, notStarted: gap - cutOff }
}

function found(newJobs: number, rated: number, searched: boolean): string {
  if (!searched && newJobs === 0 && rated === 0) return ''
  const fresh = newJobs === 0 ? 'no new jobs' : plural(newJobs, 'new job')
  // Rated differs from new when older, never-rated jobs were rated too.
  return rated === newJobs ? fresh : `${fresh}, ${rated} rated`
}

function took(r: RoundRecord): string {
  const ms = Date.parse(r.endedAt) - Date.parse(r.startedAt)
  if (!Number.isFinite(ms)) return ''
  const min = Math.round(ms / 60_000)
  return min < 1 ? ', took under a minute' : `, took ${plural(min, 'minute')}`
}

function roundLine(r: RoundRecord, now: Date): RoundLine {
  const at = new Date(r.startedAt)
  const { cutOff, notStarted } = unfinishedCount(r)
  const outcome: RoundLine['outcome'] = []
  const add = (tone: RoundTone, count: number, text: string): void => {
    if (count > 0) outcome.push({ tone, count, text: `${count} ${text}` })
  }
  add('sent', r.submitted, 'sent')
  add('cutoff', cutOff ?? 0, 'cut off')
  add('failed', r.failed, 'failed')
  add('skipped', r.skipped, 'skipped')
  add('unfinished', notStarted, cutOff === null ? 'not finished' : 'not started')
  const leftover = (cutOff ? `, ${cutOff} cut off mid-fill (may have gone in: check your email)` : '')
    + (notStarted ? `, ${notStarted} ${cutOff === null ? 'not finished' : 'never started'}` : '')
  const quiet = r.selected === 0 && !r.error
  const what = found(r.newJobs, r.newlyRated, r.searched !== false)
  return {
    key: r.startedAt,
    day: dayLabel(at, now),
    time: hhmm(at),
    quiet,
    outcome,
    detail: quiet ? `${what || 'no new jobs'}, nothing to apply to` : what,
    note: r.error ?? '',
    noteIsError: !!r.error && !r.codexLimit,
    tooltip: `Started ${hhmm(at)}${took(r)}. ${r.newJobs} new, ${r.newlyRated} rated, ${r.selected} picked: `
      + `${r.submitted} sent, ${r.failed} failed, ${r.skipped} skipped${leftover}.`,
  }
}

/**
 * The rounds as the panel lists them, newest first. Back-to-back quiet rounds
 * on the same day become one row, so the rounds that did something stand out.
 */
export function roundLines(history: RoundRecord[], now: Date): RoundLine[] {
  const lines: RoundLine[] = []
  // The quiet rounds folded into the last line, newest first.
  let run: RoundRecord[] = []
  for (const r of history) {
    const line = roundLine(r, now)
    const last = lines[lines.length - 1]
    if (line.quiet && last?.quiet && last.day === line.day) {
      run.push(r)
      const newest = new Date(run[0].startedAt)
      const oldest = new Date(r.startedAt)
      const fresh = run.reduce((n, x) => n + x.newJobs, 0)
      const rated = run.reduce((n, x) => n + x.newlyRated, 0)
      lines[lines.length - 1] = {
        ...last,
        time: `${hhmm(oldest)}–${hhmm(newest)}`,
        detail: `${run.length} rounds, ${found(fresh, rated, true)}, nothing to apply to`,
        tooltip: `${run.length} rounds from ${hhmm(oldest)} to ${hhmm(newest)}: `
          + `${fresh} new, ${rated} rated, none picked.`,
      }
      continue
    }
    run = line.quiet ? [r] : []
    lines.push(line)
  }
  return lines
}

/** The list's one-line total: "24 sent in 5 rounds". */
export function roundsTotal(history: RoundRecord[]): string {
  const sent = history.reduce((n, r) => n + r.submitted, 0)
  return `${sent} sent in ${plural(history.length, 'round')}`
}

/** The warning before the loop starts. Exact copy (spec). */
export function startConfirmCopy(settings: LoopSettings): string {
  return `Loop mode sends real applications without asking — up to ${settings.dailyLimit} a day, `
    + `to jobs rated ${settings.threshold} or higher from your saved searches. `
    + 'They cannot be withdrawn. Start?'
}
