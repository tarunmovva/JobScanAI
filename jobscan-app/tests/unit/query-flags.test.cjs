// jobscan's boolean parser needs single quotes around multi-word FTS phrases,
// but the comma-list flags are plain values where the same quotes are matched
// literally. Verified against the live CLI:
//
//     --company stripe,anthropic     -> 1208 jobs across 2 companies
//     --company 'stripe,anthropic'   -> 0 jobs, and NO error
//     --market  'usa'                -> "unknown market" (at least it's loud)
//
// The company case is the dangerous one: a silently empty slice looks exactly
// like a genuinely empty one, so nothing ever surfaces it.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')

const { tokenizeQueryFlags } = require('../../out/unit/electron/query-flags.js')

test('a single-quoted comma list loses its quotes', () => {
  assert.deepEqual(tokenizeQueryFlags("--company 'stripe,anthropic'"),
    ['--company', 'stripe,anthropic'])
  assert.deepEqual(tokenizeQueryFlags("--market 'usa'"), ['--market', 'usa'])
  assert.deepEqual(tokenizeQueryFlags("--platform 'greenhouse,lever'"),
    ['--platform', 'greenhouse,lever'])
})

test('an FTS phrase KEEPS its quotes — the parser needs them', () => {
  assert.deepEqual(tokenizeQueryFlags("--title-query 'backend engineer'"),
    ['--title-query', "'backend engineer'"])
})

test('a double-quoted boolean expression passes through whole', () => {
  assert.deepEqual(
    tokenizeQueryFlags(`--title-query "'backend engineer' OR developer"`),
    ['--title-query', "'backend engineer' OR developer"],
    'inner single quotes must survive inside the expression')
})

test('bare values are untouched', () => {
  assert.deepEqual(tokenizeQueryFlags('--market usa --remote --since 30d'),
    ['--market', 'usa', '--remote', '--since', '30d'])
})

test('a realistic full query tokenizes correctly', () => {
  const flags = `--title-query "'backend engineer' OR 'platform engineer'" --market 'usa' --since 30d --remote`
  assert.deepEqual(tokenizeQueryFlags(flags), [
    '--title-query', "'backend engineer' OR 'platform engineer'",
    '--market', 'usa',
    '--since', '30d',
    '--remote',
  ])
})

test('a quoted value after a boolean flag is still treated as a phrase', () => {
  // --key-query is NOT a list flag, so quotes stay even for a single word.
  assert.deepEqual(tokenizeQueryFlags("--key-query 'kubernetes'"),
    ['--key-query', "'kubernetes'"])
})

test('empty input yields no tokens', () => {
  assert.deepEqual(tokenizeQueryFlags(''), [])
})
