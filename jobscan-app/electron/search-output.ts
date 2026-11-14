/**
 * Reading `jobscan search --format json` strictly.
 *
 * The lenient reader in cliSearch turns every failure into "no results" --
 * acceptable while a person watches the screen, not in loop mode, where a
 * search that failed must fail the round instead of passing for an empty one.
 *
 * A search that matched nothing is not a failure. The CLI reports it in plain
 * text with exit 0, whatever --format says (cmd/search.go), so that notice is
 * read as an empty result.
 */

export interface CliOutput {
  exitCode: number
  stdout: string
  stderr: string
  timedOut?: boolean
}

const NO_RESULTS = /^\s*No results found\./m

const firstLine = (s: string): string => String(s ?? '').trim().split('\n')[0].slice(0, 200)

export function parseSearchOutput(r: CliOutput): unknown[] {
  if (r.timedOut) throw new Error('search timed out')
  if (r.exitCode !== 0) {
    throw new Error(`search failed (exit ${r.exitCode}): ${firstLine(r.stderr) || firstLine(r.stdout) || 'no output'}`)
  }
  const text = String(r.stdout ?? '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    if (NO_RESULTS.test(text)) return []
    throw new Error(`search output unreadable: ${firstLine(text) || 'empty'}`)
  }
  if (parsed === null) return []
  if (!Array.isArray(parsed)) throw new Error('search output is not a list of jobs')
  return parsed
}
