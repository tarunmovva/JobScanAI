// A run that did not finish does not survive a restart.
//
// Closing the app mid-run used to leave two kinds of residue. In the store, the
// board cards and the selection of whatever was being applied; in jobs.db, rows
// stuck at extracting/extracted/claimed/filling whose process is long gone. The
// next run then inherited both -- a board describing work that stopped hours
// ago, and queue rows no agent would ever finish.
//
// The rule: whatever was already SUBMITTED is permanent, and everything else is
// abandoned. A submitted application cannot be taken back, so it stays in
// appliedJobIds and appliedJobsLog (both written the moment each submit is
// detected, not at the end of the run) and is never touched here. Anything
// still in flight simply stops.
//
// Deliberately scoped to an interrupted run. A run that reached 'done'
// finished; its summary is a result, not residue.

/** Statuses in jobs.db that mean "a process was working on this". */
export const IN_FLIGHT_STATUSES = ['extracting', 'extracted', 'claimed', 'filling'] as const

/** Store keys describing the interrupted run. Never includes applied history. */
export const RUN_STATE_KEYS = [
  'boardCards',
  'selectedJobIds',
  'extractResults',
  // Skip-if-clean caches. Left behind, they make the next run believe the
  // abandoned extraction and payload work is still valid.
  'extractInputHash',
  'payloadInputHash',
] as const

/**
 * Keys that must survive, because they record things that really happened.
 * Listed explicitly so a future addition to RUN_STATE_KEYS has to confront it.
 */
export const PRESERVED_KEYS = ['appliedJobIds', 'appliedJobsLog', 'ratedJobs'] as const

/**
 * Where to land after discarding an interrupted run.
 *
 * Back to the ratings, not the board: the selection is gone with the rest of
 * the run, so the next one starts from a deliberate choice rather than from
 * whatever the interrupted one happened to be holding. Ratings themselves are
 * preserved, so nothing has to be recomputed.
 */
export const RESUME_STATE = 'rating'

/**
 * Is there a previous run's residue to throw away?
 *
 * Two ways to get it. The obvious one is closing the app on the board, with
 * work in flight. The quieter one is stepping back to an earlier screen first
 * -- the board cards stay in the store, unreachable and stale, and were still
 * sitting there at the next launch.
 *
 * 'done' is the exception: that run finished, and its summary is a result the
 * user asked to see rather than residue.
 */
export function wasInterrupted(appState: string, boardCardCount = 0): boolean {
  if (appState === 'done') return false
  return appState === 'board' || boardCardCount > 0
}

/**
 * Where to send the user, or null to leave them where they are.
 *
 * Only the board becomes unusable when its run is discarded -- it would render
 * empty with no way to fill it. Someone already on an earlier screen is
 * somewhere valid and should not be moved out from under.
 */
export function landingState(appState: string): string | null {
  return appState === 'board' ? RESUME_STATE : null
}

export function abandonSql(): string {
  const list = IN_FLIGHT_STATUSES.map(s => `'${s}'`).join(',')
  return "UPDATE applications SET status='failed', "
    // Plain ASCII: this string is embedded into a python -c argument on
    // Windows, and a dash is not worth an encoding question.
    + "error='abandoned - app closed mid-run', updated_at=datetime('now') "
    + `WHERE status IN (${list})`
}
