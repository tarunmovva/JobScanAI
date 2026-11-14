/**
 * The two lines of an application record that say what happened.
 *
 * Every record used to open "Applied: <date>" and list its answers under
 * "Questions & Answers", whatever the outcome. A job whose page never loaded
 * (seven in one run, all navigation timeouts) therefore read as an
 * application sent on that date, with a full set of answers that never
 * reached a form. The filler's own result says what was entered; the record
 * now follows it.
 */

export interface RecordHeader {
  /** "Applied" only when the application went in. */
  whenLabel: 'Applied' | 'Attempted'
  answersHeading: string
}

export function recordHeader(
  status: 'submitted' | 'failed',
  fillResult: unknown,
): RecordHeader {
  if (status === 'submitted') {
    return { whenLabel: 'Applied', answersHeading: 'Questions & Answers' }
  }
  const result = (fillResult && typeof fillResult === 'object' ? fillResult : null) as
    | { filled?: unknown; submission?: { status?: unknown } }
    | null
  // "Never entered" only on positive evidence: a filled list that exists and
  // is empty. No result file, or one without the list, makes no claim.
  if (!result || !Array.isArray(result.filled) || result.filled.length > 0) {
    return { whenLabel: 'Attempted', answersHeading: 'Questions & Answers' }
  }
  const why = result.submission?.status === 'nav_failed'
    ? 'the page did not load'
    : 'the form was never filled'
  return { whenLabel: 'Attempted', answersHeading: `Prepared answers — never entered (${why})` }
}
