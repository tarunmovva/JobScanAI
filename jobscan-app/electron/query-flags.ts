/**
 * Split a query-flags string into argv for the jobscan CLI.
 *
 * This lived in two places (cli-runner and pipeline's validator) with identical
 * regexes, so a fix to one silently missed the other. One copy now.
 *
 * The subtlety is single quotes. jobscan's boolean parser wants them around
 * multi-word FTS phrases, so `--title-query 'backend engineer'` must keep them.
 * But the comma-list flags are plain SQL/enum values, and there the quotes are
 * poison:
 *
 *     --company stripe,anthropic     -> 1208 jobs across 2 companies
 *     --company 'stripe,anthropic'   -> 0 jobs, and NO error
 *
 * `--market 'usa'` at least fails loudly ("unknown market"), so the model can
 * recover. `--company` just returns nothing, which looks like a genuinely empty
 * slice — the worst kind of wrong.
 */

/** Flags whose value is a comma-separated list or enum, never an FTS phrase. */
const LIST_FLAGS = new Set([
  '--company', '--market', '--platform', '--location', '--type',
  '--exclude-title-phrase', '--since', '--before', '--department', '--country',
])

const TOKEN_RE = /(?:"([^"]*)")|(?:'([^']*)')|([^\s]+)/g

export function tokenizeQueryFlags(queryFlags: string): string[] {
  const tokens: string[] = []
  let match: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((match = TOKEN_RE.exec(queryFlags)) !== null) {
    const previous = tokens[tokens.length - 1]
    if (match[1] !== undefined) {
      tokens.push(match[1])                       // double-quoted → bare value
    } else if (match[2] !== undefined) {
      // Single-quoted. Keep the quotes for FTS phrases, drop them for the
      // list flags where they are matched literally against the value.
      tokens.push(LIST_FLAGS.has(previous ?? '') ? match[2] : `'${match[2]}'`)
    } else {
      tokens.push(match[3]!)                      // bare word
    }
  }
  return tokens
}
