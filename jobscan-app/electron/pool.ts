/**
 * The candidate pool: the jobs a run's searches found, which the rater reads.
 *
 * Pure. The search itself is passed in, so the rules for building a pool run
 * in unit tests without a jobs.db.
 */
import { tokenizeQueryFlags, searchFlagProblem } from './query-flags'
import { newPostingsTokens } from './loop-policy'

export interface PoolJob {
  platform: string
  job_id: string
}

const keyOf = (j: PoolJob): string => `${j.platform}:${j.job_id}`

/**
 * Add one search's results to the pool: each job once, by platform and id,
 * and never a job already applied to.
 *
 * Applied jobs are left out BEFORE the pool, not after: the rater never pays
 * to score a job that cannot be applied to.
 */
export function mergeIntoPool<J extends PoolJob>(
  seen: Set<string>, pool: J[], results: J[], isApplied: (platform: string, jobId: string) => boolean,
): { added: J[]; skippedApplied: number } {
  const added: J[] = []
  let skippedApplied = 0
  for (const j of results ?? []) {
    const key = keyOf(j)
    if (seen.has(key)) continue
    seen.add(key)
    if (isApplied(j.platform, j.job_id)) { skippedApplied++; continue }
    pool.push(j)
    added.push(j)
  }
  return { added, skippedApplied }
}

/** The first job of each platform and id, in order. */
export function uniqueByKey<J extends PoolJob>(jobs: J[]): J[] {
  const seen = new Set<string>()
  return (jobs ?? []).filter(j => {
    const key = keyOf(j)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export interface SavedSearch {
  name?: string
  flags: string
  description?: string
  count?: number | null
}

/** A saved search and its position in the saved list. */
export type PlacedSearch = SavedSearch & { index: number }

export interface ResearchEntry {
  index: number
  query: SavedSearch
  found: number
  totalAfter: number
}

export interface ResearchResult<J extends PoolJob> {
  ok: boolean
  error?: string
  pool: J[]
  entries: ResearchEntry[]
  newJobs: number
}

export interface ResearchEvents {
  started?(index: number, query: SavedSearch): void
  searched?(index: number, found: number, total: number): void
  failed?(index: number, error: string, detail: string): void
}

const searchName = (q: SavedSearch): string => String(q.name ?? '').trim() || q.flags

/**
 * Loop mode's search stage: re-run the saved searches against a fresh
 * database, without asking the model for new ones.
 *
 * Each search runs as saved -- the backlog, by relevance -- and, after the
 * first round, once more newest first since the previous round started, which
 * is what catches postings that appear while the loop runs.
 *
 * Strict: a search that fails fails the stage, and searches that return
 * nothing at all fail it too. Neither may pass for "nothing new".
 */
export async function researchPool<J extends PoolJob>(opts: {
  run: PlacedSearch[]
  sinceDate: string | null
  previousPool: PoolJob[]
  isApplied: (platform: string, jobId: string) => boolean
  /** One CLI search. Throws when the search did not work. */
  search: (tokens: string[]) => Promise<J[]>
  events?: ResearchEvents
}): Promise<ResearchResult<J>> {
  const seen = new Set<string>()
  const pool: J[] = []
  const entries: ResearchEntry[] = []
  const failed = (error: string): ResearchResult<J> =>
    ({ ok: false, error, pool, entries, newJobs: 0 })

  if ((opts.run ?? []).length === 0) return failed('No saved searches — run Find Jobs once first')

  let rows = 0
  for (const placed of opts.run) {
    const { index, ...query } = placed
    opts.events?.started?.(index, query)
    const tokens = tokenizeQueryFlags(query.flags)
    // A search saved before the flag allowlist existed is skipped, not run;
    // the rest of the stage carries on (a throw here would fail all of it).
    const unsafe = searchFlagProblem(tokens)
    if (unsafe) {
      opts.events?.failed?.(index, `Skipped: ${searchName(query)}`, unsafe)
      continue
    }
    const passes = opts.sinceDate ? [tokens, newPostingsTokens(tokens, opts.sinceDate)] : [tokens]
    let found = 0
    for (const pass of passes) {
      let results: J[]
      try {
        results = await opts.search(pass)
      } catch (e) {
        const error = `Search failed: ${searchName(query)}`
        opts.events?.failed?.(index, error, String((e as Error)?.message ?? e))
        return failed(error)
      }
      rows += results.length
      found += mergeIntoPool(seen, pool, results, opts.isApplied).added.length
    }
    entries.push({ index, query, found, totalAfter: pool.length })
    opts.events?.searched?.(index, found, pool.length)
  }

  if (rows === 0) return failed('Searches returned no jobs')

  const before = new Set((opts.previousPool ?? []).map(keyOf))
  const newJobs = pool.filter(j => !before.has(keyOf(j))).length
  return { ok: true, pool, entries, newJobs }
}
