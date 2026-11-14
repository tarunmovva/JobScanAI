/**
 * The application board, as a pure projection of pipeline events.
 *
 * Board state is app-level. The `applications` table in jobs.db is not the
 * source of truth here and never was -- it holds a few rows, far fewer than
 * the applications made. The DB keeps only its lease role, stopping two agents claiming
 * the same posting.
 *
 * This module is pure on purpose: no Electron import, no store access, no I/O.
 * The board is the one place a user reads what the run is doing, so its rules
 * have to be testable without standing up a pipeline.
 *
 * The event stream guarantees nothing. Extraction and the agent pool run
 * concurrently, events cross an IPC boundary, and a cached re-run replays
 * results for jobs the board may not have seeded. Every reducer rule below
 * exists because of one of those.
 */

/**
 * Five columns, not eight.
 *
 * The pipeline has more internal states than a person watching it needs.
 * Extracting and waiting-to-be-picked are the same thing to a reader (the
 * form is being got ready), and generating answers and filling are one
 * activity (the application is being made). The finer state is still on the
 * card, in `detail`, for anyone who wants it.
 *
 * Defects merges the two outcomes that need a human, tagged apart on the card
 * itself: one asks you to finish something, the other reports a failure.
 */
export const COLUMNS = ['todo', 'extracted', 'applying', 'done', 'defect'] as const

import type { Defect } from './board-tags'
export { DEFECTS } from './board-tags'

export type Column = (typeof COLUMNS)[number]

/**
 * Once an application has finished, nothing may move it.
 *
 * A late 'filling' arriving after 'done' is not a correction, it is a stale
 * event from a concurrent worker -- and resurrecting a submitted application
 * would show the user work in progress that already went out.
 */
const TERMINAL: ReadonlySet<Column> = new Set<Column>(['done', 'defect'])

export interface Card {
  key: string
  platform: string
  jobId: string
  company: string
  title: string
  applyUrl: string
  column: Column
  /** Why a card is in Defects: it needs you, it failed, or the loop skipped it. */
  defect?: Defect
  detail?: string
  needsYou?: string
  detailsPath?: string
  agentId?: string
  updatedAt: string
}

export type Board = Record<string, Card>

export interface JobRef {
  platform: string
  jobId: string
  company?: string
  title?: string
  applyUrl?: string
}

/** Board event. Deliberately loose: it is parsed from a live event stream. */
export interface BoardEvent {
  type?: string
  platform?: string
  jobId?: string
  company?: string
  title?: string
  applyUrl?: string
  status?: string
  state?: string
  phase?: string
  message?: string
  error?: string
  needsYou?: string
  detailsPath?: string
  agentId?: string
  /** Loop mode deliberately did not finish this job (CAPTCHA page closed, platform paused). */
  skipped?: boolean
}

export function jobKey(platform: string, jobId: string): string {
  return `${platform}:${jobId}`
}

export function emptyBoard(): Board {
  return {}
}

function card(ref: JobRef, column: Column): Card {
  return {
    key: jobKey(ref.platform, ref.jobId),
    platform: ref.platform,
    jobId: ref.jobId,
    company: ref.company ?? '',
    title: ref.title ?? '',
    applyUrl: ref.applyUrl ?? '',
    column,
    updatedAt: new Date().toISOString(),
  }
}

/** Put every selected job on the board in `todo`. */
export function seedCards(board: Board, jobs: JobRef[]): Board {
  const next: Board = { ...board }
  for (const job of jobs) {
    if (!job?.platform || !job?.jobId) continue
    const key = jobKey(job.platform, job.jobId)
    if (next[key]) continue
    next[key] = card(job, 'todo')
  }
  return next
}

function move(board: Board, ev: BoardEvent, column: Column, patch: Partial<Card> = {}): Board {
  const platform = String(ev.platform ?? '')
  const jobId = String(ev.jobId ?? '')
  if (!platform || !jobId) return board

  const key = jobKey(platform, jobId)
  const existing = board[key]
  // An event can arrive for a job the board never seeded -- a cached extract
  // replay does exactly this. Creating the card beats dropping the event,
  // because a missing card is a job the user cannot see.
  const base = existing ?? card({ platform, jobId, company: ev.company, title: ev.title, applyUrl: ev.applyUrl }, column)

  if (existing && TERMINAL.has(existing.column)) return board

  const next: Card = {
    ...base,
    column,
    // Identity fields are filled in when an event carries them and the seed
    // did not; never blanked by an event that omits them.
    company: base.company || (ev.company ?? ''),
    title: base.title || (ev.title ?? ''),
    applyUrl: base.applyUrl || (ev.applyUrl ?? ''),
    ...patch,
    updatedAt: new Date().toISOString(),
  }

  if (existing && existing.column === column
      && existing.detail === next.detail
      && existing.needsYou === next.needsYou
      && existing.agentId === next.agentId) {
    return board  // idempotent: nothing about this card changed
  }

  return { ...board, [key]: next }
}

export function applyBoardEvent(board: Board, ev: BoardEvent): Board {
  if (!ev || typeof ev !== 'object') return board

  switch (ev.type) {
    case 'extract:clear':
      return emptyBoard()

    // extract:start deliberately moves nothing. It used to sweep every card
    // of a platform into 'extracting' at once, which emptied To do the
    // instant a run began -- the column was never seen populated. Extraction
    // runs three workers at a time and only reports per job on completion, so
    // a card leaves To do when its own form is ready, and not before.
    case 'extract:start':
      return board

    case 'extract:job':
      if (ev.status === 'extracted') return move(board, ev, 'extracted')
      if (ev.status === 'failed') {
        return move(board, ev, 'defect', { defect: 'error', detail: ev.error || 'extraction failed' })
      }
      return board

    case 'payload:progress': {
      const patch: Partial<Card> = {}
      if (ev.message) patch.detail = ev.message
      if (ev.agentId) patch.agentId = ev.agentId
      if (ev.detailsPath) patch.detailsPath = ev.detailsPath

      if (ev.state === 'done') return move(board, ev, 'done', patch)
      if (ev.state === 'failed') {
        // A job the loop chose not to finish: not a failure, and never
        // "needs you" -- its tab is already closed.
        if (ev.skipped) return move(board, ev, 'defect', { ...patch, defect: 'skipped' })
        // Both land in Defects, tagged apart. needs_you is not a worse
        // failure but a different one: the form is filled and a person has to
        // finish it, so it keeps the signal colour and leads the column.
        return ev.needsYou
          ? move(board, ev, 'defect', { ...patch, defect: 'needs_you', needsYou: ev.needsYou })
          : move(board, ev, 'defect', { ...patch, defect: 'error' })
      }
      if (ev.state === 'working') {
        // Generating and filling are one activity to a reader. Which of the
        // two it is stays on the card, in detail.
        if (ev.phase === 'filling' || ev.phase === 'generating') {
          return move(board, ev, 'applying', patch)
        }
        return board
      }
      return board
    }

    default:
      return board
  }
}

/**
 * A platform's cards that no agent has started on: still in To do or
 * Extracted. Loop mode skips these when it pauses the platform mid-round --
 * nothing else would ever move them.
 */
export function waitingCards(board: Board, platform: string): Card[] {
  return Object.values(board ?? {})
    .filter(c => c.platform === platform && (c.column === 'todo' || c.column === 'extracted'))
}

/**
 * After a run has ended, the cards no agent ever started -- still in To do or
 * Extracted. They would otherwise sit there as if work were still coming.
 */
export function cardsNotStarted(board: Board): Card[] {
  return Object.values(board ?? {}).filter(c => c.column === 'todo' || c.column === 'extracted')
}

/** Cards in a column, most recently touched first. */
export function cardsIn(board: Board, column: Column): Card[] {
  return Object.values(board)
    .filter(c => c.column === column)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
