/**
 * How one failed application is shown on the board and kept in the record.
 *
 * A normal run shows exactly what it always has. A loop run closes every tab
 * when its job ends, so nothing it reports may ask a person to finish one:
 * no "needs you", and never "tab left open" -- a phrase that also keeps the
 * job out of every later loop round (leftOpenKeys).
 */
import type { HookView } from './run-mode'

/** What a normal run appends when the filler kept the tab for the user. */
export const TAB_LEFT_OPEN = ' — browser tab left open, finish manually'

export interface FailureShown {
  /** The card's detail on the board. */
  board: string
  /** The message kept in appliedJobsLog and the application record. */
  log: string
  needsYou?: string
  /** The loop chose not to finish this job; the board tags it Skipped. */
  skipped?: true
  via: 'auto' | 'manual'
}

/**
 * Did this fill submit? Go prints "Submission result: <status>" only when it
 * saw the filler finish. A fill that was cut off -- a normal run cancelled,
 * loop mode's Stop now or deadline -- may have submitted before it died:
 * then the filler's fresh result file is the evidence, the same file Go
 * reads ("submitted" is the only success). A fill that ran to the end without
 * the line did not submit -- Go read that file and said so.
 */
export function submittedStatus(
  okLine: string | null, cutOff: boolean, lateFill: { status: string } | null,
): string | null {
  if (okLine) return okLine
  if (cutOff && lateFill?.status === 'submitted') return 'submitted'
  return null
}

/**
 * What the loop is told about one job's end, or null when nothing was
 * attempted. The rules that decide whether a possibly-sent application is
 * counted, retried or excluded:
 *
 * - A submission is a submission, whatever else happened -- the deadline,
 *   Stop now, or an exception while recording it.
 * - A fill cut off (its deadline, Stop now, the round's time limit) may have
 *   gone in: reported as cut off, which the loop never retries.
 * - Stop now before the filler started: no attempt, nothing to report.
 * - Anything else is reported as it is, for the loop to classify.
 */
export function loopReport(f: {
  /** The success status seen: Go's "Submission result:", or a fresh fill result saying 'submitted'. */
  submittedAs: string | null
  fillStarted: boolean
  canceled: boolean
  timedOut: boolean
  status: string
  detail: string
}): { submitted: boolean; status: string; detail: string; timedOut: boolean } | null {
  if (f.submittedAs) return { submitted: true, status: 'submitted', detail: f.submittedAs, timedOut: false }
  if (!f.fillStarted) {
    if (f.canceled) return null
    return { submitted: false, status: f.status, detail: f.detail, timedOut: false }
  }
  if (f.timedOut || f.canceled) return { submitted: false, status: f.status, detail: f.detail, timedOut: true }
  return { submitted: false, status: f.status, detail: f.detail, timedOut: false }
}

/**
 * `manual` is what a normal run shows for this failure. `loop` is the loop's
 * view of the result, or null when no loop is running.
 */
export function failureShown(
  manual: { board: string; log: string; needsYou?: string },
  loop: { view: HookView } | null,
): FailureShown {
  if (!loop) {
    return {
      board: manual.board,
      log: manual.log,
      ...(manual.needsYou ? { needsYou: manual.needsYou } : {}),
      via: 'manual',
    }
  }
  const strip = (s: string): string => s.split(TAB_LEFT_OPEN).join('')
  const log = strip(manual.log)
  if (loop.view?.asSkipped) {
    return { board: loop.view.message || log, log, skipped: true, via: 'auto' }
  }
  return { board: strip(manual.board), log, via: 'auto' }
}
