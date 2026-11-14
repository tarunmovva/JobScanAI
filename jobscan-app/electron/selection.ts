/**
 * Selection ids -- what the Rating screen and the loop put in selectedJobIds.
 *
 * An id is the CLI's `id`: `<abbr>:<company-slug>:<job_id>`, where the first
 * segment is a two-letter platform abbreviation and the SECOND is the
 * company, not the platform. Reading it the other way round once produced
 * keys that could never match an applied record. Pure.
 */

export const PLATFORM_ABBR: Record<string, string> = { gh: 'greenhouse', lv: 'lever', ab: 'ashby' }

/** `platform:job_id` for a selection id, or null when it has no job id. */
export function selectionKey(id: string): string | null {
  const parts = String(id ?? '').split(':')
  const jobId = parts.slice(2).join(':')   // job ids may themselves hold colons
  if (!jobId) return null
  return `${PLATFORM_ABBR[parts[0]] ?? 'greenhouse'}:${jobId}`
}

/**
 * The selected jobs of `platform` that extraction gave no answer for --
 * neither extracted nor failed. Without this they vanish: no agent can claim
 * a job whose form was never read, and nothing reports it.
 */
export function unextracted(
  selectedIds: string[], platform: string, seenJobIds: Set<string>,
): Array<{ platform: string; jobId: string }> {
  const out: Array<{ platform: string; jobId: string }> = []
  const seen = new Set<string>()
  for (const id of selectedIds ?? []) {
    const key = selectionKey(id)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const at = key.indexOf(':')
    const p = key.slice(0, at)
    const jobId = key.slice(at + 1)
    if (p === platform && !seenJobIds.has(jobId)) out.push({ platform: p, jobId })
  }
  return out
}

/**
 * The selected jobs whose application form could not be read, from the
 * extraction snapshot -- only this selection's, never a previous run's.
 * `setupFailed`: the form was never tried, because a command failed (the
 * queue or the extractor itself) -- not because of the job.
 */
export function extractFailures(
  results: Array<{ platform: string; jobId: string; status: string; title?: string; company?: string; setupFailed?: boolean }> | undefined,
  selectedIds: string[],
): Array<{ platform: string; jobId: string; title?: string; company?: string; setupFailed?: true }> {
  const wanted = new Set((selectedIds ?? []).map(selectionKey).filter((k): k is string => !!k))
  return (results ?? [])
    .filter(r => r?.status === 'failed' && wanted.has(`${r.platform}:${r.jobId}`))
    .map(r => ({
      platform: r.platform, jobId: r.jobId,
      ...(r.title ? { title: r.title } : {}),
      ...(r.company ? { company: r.company } : {}),
      ...(r.setupFailed === true ? { setupFailed: true as const } : {}),
    }))
}
