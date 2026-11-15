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

/**
 * The `jobscan search` flags an AI-written query may use (jobscan/cmd/search.go).
 *
 * The flags are written by a model after it reads the résumé, and the
 * saved ones are re-run every loop round. Anything else is refused: `--db`
 * opens or creates any SQLite file, `-o/--output` overwrites any file --
 * the app's own config.json, which holds the only record of past
 * applications, included -- and `--format`/`--count` would change the
 * output the app parses. The app appends its own `--count`,
 * `--format json` and pool defaults after this check.
 *
 * true = takes a value, false = a switch.
 */
const SEARCH_FLAGS: ReadonlyMap<string, boolean> = new Map([
  ['--desc', false], ['--raw', false], ['--remote', false], ['--hybrid', false],
  ['--onsite', false], ['--fast', false], ['--no-expand', false], ['--dedupe', false],
  ['--title-query', true], ['--key-query', true], ['--exclude-key-query', true],
  ['--exclude-title-phrase', true], ['--location', true], ['--market', true],
  ['--since', true], ['--before', true], ['--platform', true], ['--company', true],
  ['--department', true], ['--type', true], ['--country', true], ['--sort', true],
  ['--limit', true], ['--offset', true], ['--max-per-company', true],
])
/** Single-letter forms: -d (--desc, a switch) and -Q (--key-query, takes a value). */
const SEARCH_SHORTHANDS: ReadonlyMap<string, boolean> = new Map([['d', false], ['Q', true]])

/**
 * Why these AI-written search tokens must not run, or null when they may.
 * Reads them the way the CLI's flag parser does: `--flag=value`, a flag's
 * value in the next token (even one starting with '-'), clustered
 * single-letter switches (`-dQ value`, `-d=true`); `--` is refused.
 */
export function searchFlagProblem(tokens: readonly string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    // `--` ends the flags: the app's own --format/--count after it would be
    // read as search words, and the output could not be parsed.
    if (token === '--') return 'Search flag -- is not allowed; use only search filters such as --title-query, --key-query, --market or --since'
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      const name = eq === -1 ? token : token.slice(0, eq)
      const takesValue = SEARCH_FLAGS.get(name)
      if (takesValue === undefined) return `Search flag ${name} is not allowed; use only search filters such as --title-query, --key-query, --market or --since`
      if (takesValue && eq === -1) i++          // its value is the next token
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      for (let c = 1; c < token.length; c++) {
        if (token[c] === '=' && c > 1) break     // -d=true: the switch's own value
        const takesValue = SEARCH_SHORTHANDS.get(token[c]!)
        if (takesValue === undefined) return `Search flag -${token[c]} is not allowed; use only search filters such as --title-query, --key-query, --market or --since`
        if (takesValue) {
          if (c === token.length - 1) i++        // -Q value
          break                                  // -Qvalue: the rest is its value
        }
      }
    }
  }
  return null
}

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
