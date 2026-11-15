/**
 * The query behind the payload prompt's job context.
 *
 * Extracted from pipeline.ts so it can be tested. It previously named a
 * `company` column that the jobs table does not have (it is `company_name`);
 * SQLite raised "no such column", the child process exited non-zero, and
 * getJobContext's error guard returned empty strings. The only visible effect
 * was an empty JOB DESCRIPTION section in every payload prompt — no crash, no
 * log line — so it went unnoticed across every payload written.
 *
 * Keeping the column list here means a schema change breaks a unit test rather
 * than quietly emptying the prompt.
 */

/** Columns selected; jobContextFromRows reads them by name. */
export const JOB_CONTEXT_COLUMNS = ['title', 'company_name', 'description_plain'] as const

/** Job descriptions are truncated before they reach the prompt. */
export const DESCRIPTION_LIMIT = 2000

export function jobContextSql(jobId: string, platform: string): string {
  // Single quotes are the only SQL metacharacter reachable here — both values
  // come from the jobs table itself, but doubling them costs nothing.
  const safeId = jobId.replace(/'/g, "''")
  const safePlat = platform.replace(/'/g, "''")
  return `SELECT ${JOB_CONTEXT_COLUMNS.join(',')} FROM jobs `
    + `WHERE job_id='${safeId}' AND platform='${safePlat}'`
}

/**
 * The prompt's job context from `jobscan db query` output (a JSON array of
 * rows, by column name). {} when the job has dropped out of the database.
 */
export function jobContextFromRows(rows: unknown): { title?: string; company?: string; description?: string } {
  const r = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined
  if (!r || typeof r !== 'object') return {}
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    title: text(r['title']),
    company: text(r['company_name']),
    description: text(r['description_plain']).slice(0, DESCRIPTION_LIMIT),
  }
}

/**
 * Runs `query` again after a quick failure, up to `attempts` times in all.
 *
 * On the board, extraction and form answers run side by side, and their
 * jobscan processes open jobs.db at the same moments. The CLI fails at once
 * with SQLITE_BUSY ("database is locked") instead of waiting, and one such
 * collision used to send a payload prompt out with no job description. A
 * slow failure (the query's own timeout) is not retried: it would only wait
 * again.
 */
export async function retryQuickFailures<T>(
  query: () => Promise<T | null>,
  opts: { attempts: number; delayMs: number; quickMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<T | null> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  for (let attempt = 1; ; attempt++) {
    const started = now()
    const result = await query()
    if (result !== null || attempt >= opts.attempts || now() - started > opts.quickMs) return result
    await sleep(opts.delayMs)
  }
}
