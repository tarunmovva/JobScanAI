/**
 * Which jobs must not be offered again.
 *
 * `appliedJobIds` was read in exactly one place -- the
 * skip-if-clean shortcut in runPayloadGenInner -- so already-applied jobs came
 * back from every search, entered the candidate pool, were sent to the rating
 * agent (paying tokens to score jobs that cannot be applied to), and appeared
 * in the selection list. `gen.seen` only ever deduped within a single run.
 *
 * Two populations count as spent:
 *
 *   - Confirmed submissions. Recorded in appliedJobIds, which is written only
 *     on the submitted branch, so it is already submitted-only.
 *   - Applications left open for the user ("needs you": CAPTCHA, email
 *     verification). The tab was handed over precisely so a person could finish
 *     it, so it may well have been submitted by hand. Offering it again risks a
 *     duplicate.
 *
 * Everything else -- genuine failures, closed postings, network errors -- stays
 * eligible. A transient failure must not permanently bury a job that was never
 * actually applied to.
 *
 * Both are per-profile: they live in PROFILE_KEYS, so each persona keeps its own
 * history and two personas may legitimately target the same posting.
 */
import store from './state-store'

/** Shape of an appliedJobsLog entry, narrowed to what matters here. */
interface AppliedLogEntry {
  jobId?: string
  platform?: string
  status?: string
  needsYou?: string
}

/** `platform:job_id`, the key the candidate pool uses. */
export function jobKey(platform: string, jobId: string): string {
  return `${platform}:${jobId}`
}

/**
 * Every key that identifies a spent job, in BOTH shapes.
 *
 * Historic appliedJobIds entries are bare `job_id` with no platform. New ones
 * are written platform-qualified. Membership is therefore tested against both
 * forms rather than migrating the store, which would risk dropping history.
 */
export function appliedKeys(): Set<string> {
  const keys = new Set<string>()

  for (const raw of (store.get('appliedJobIds') as string[] | undefined) ?? []) {
    const id = String(raw || '').trim()
    if (id) keys.add(id)
  }

  for (const entry of (store.get('appliedJobsLog') as AppliedLogEntry[] | undefined) ?? []) {
    const id = String(entry?.jobId || '').trim()
    if (!id) continue
    // A left-open "needs you" tab may have been finished by hand, so it counts
    // as spent even though the app never saw a confirmation.
    if (entry.status !== 'submitted' && !entry.needsYou) continue
    keys.add(id)
    if (entry.platform) keys.add(jobKey(entry.platform, id))
  }

  return keys
}

/** True when this job has already been applied to, or handed to the user. */
export function isApplied(keys: Set<string>, platform: string, jobId: string): boolean {
  const id = String(jobId || '').trim()
  if (!id) return false
  return keys.has(jobKey(platform, id)) || keys.has(id)
}

export const __testing = { jobKey }
