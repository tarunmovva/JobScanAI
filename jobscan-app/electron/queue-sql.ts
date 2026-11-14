/**
 * SQL for jobs.db's applications table (the lease table agents claim from).
 *
 * Pure builders, run through `jobscan db exec` on the normal asynchronous CLI
 * path. The reset before extraction used to be one synchronous `python -c`
 * spawn per selected job, on the main process, which stalled the window for
 * the whole loop.
 */

const q = (v: string): string => `'${String(v).replace(/'/g, "''")}'`

/** Put every selected job back to queued with no leftovers. '' when there is nothing to reset. */
export function resetSelectedSql(jobIds: string[]): string {
  const ids = (jobIds ?? []).map(id => String(id ?? '').trim()).filter(Boolean)
  if (ids.length === 0) return ''
  return "UPDATE applications SET status='queued',fill_result=NULL,fill_payload_path=NULL,"
    + 'extracted_fields_path=NULL,claim_token=NULL,error=NULL,updated_at=CURRENT_TIMESTAMP '
    + `WHERE job_id IN (${ids.map(q).join(',')})`
}

/**
 * Before a run: every row left by another run is abandoned. Queued rows too:
 * the extractor reads every queued row of a platform and agents claim every
 * extracted one, so a row an earlier run left queued would be read and
 * filled in this run without being picked. No selection abandons them all.
 */
export function abandonOthersSql(jobIds: string[]): string {
  const ids = (jobIds ?? []).map(id => String(id ?? '').trim()).filter(Boolean)
  const others = ids.length > 0 ? ` AND job_id NOT IN (${ids.map(q).join(',')})` : ''
  return "UPDATE applications SET status='failed', error='abandoned — not in current run', updated_at=CURRENT_TIMESTAMP "
    + `WHERE status IN ('queued','extracted','claimed','filling')${others}`
}

/**
 * A paused platform's jobs still waiting in this round. Only rows nobody is
 * working on: an extraction or a fill in progress finishes and reports as
 * usual. The DB status column has no constraint, so 'skipped' needs no Go
 * change, and agents only ever claim 'extracted' rows.
 */
export function skipPlatformSql(platform: string, reason: string): string {
  return `UPDATE applications SET status='skipped', error=${q(reason)}, updated_at=CURRENT_TIMESTAMP `
    + `WHERE platform=${q(platform)} AND status IN ('queued','extracted')`
}

/** One claimed job the loop decided not to fill. */
export function markSkippedSql(platform: string, jobId: string, reason: string): string {
  return `UPDATE applications SET status='skipped', error=${q(reason)}, updated_at=CURRENT_TIMESTAMP `
    + `WHERE platform=${q(platform)} AND job_id=${q(jobId)}`
}
