// What `jobscan search --format json` printed, read strictly.
//
// The lenient reader turns every failure into "no results". Loop mode must
// not: a search that failed is a failed round, never an empty one. But a
// search that matched nothing is not a failure -- and the CLI says so in
// plain text, exit 0, even with --format json (cmd/search.go).
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { parseSearchOutput } = require(path.join(__dirname, '..', '..', 'out', 'unit', 'electron', 'search-output.js'))

const ok = stdout => ({ exitCode: 0, stdout, stderr: '', timedOut: false })

test('a search that matched nothing is an empty result, not a failure', () => {
  // Verbatim from the CLI, 2026-11-13.
  const text = '  No results found.\n  Try: broadening your query, removing --since, or running `jobscan fetch` first.\n'
  assert.deepEqual(parseSearchOutput(ok(text)), [])
})

test('JSON rows come back as rows, and null or [] as none', () => {
  assert.deepEqual(parseSearchOutput(ok('[{"platform":"lever","job_id":"1"}]\n')), [{ platform: 'lever', job_id: '1' }])
  assert.deepEqual(parseSearchOutput(ok('[]')), [])
  assert.deepEqual(parseSearchOutput(ok('null\n')), [])
})

test("a non-zero exit is a failure, carrying the CLI's own message", () => {
  assert.throws(
    () => parseSearchOutput({ exitCode: 1, stdout: '', stderr: 'Error: unknown flag: --bogus\n', timedOut: false }),
    /exit 1.*unknown flag: --bogus/)
})

test('output that is neither rows nor the no-results notice is a failure', () => {
  assert.throws(() => parseSearchOutput(ok('{"error":"x"}')), /not a list/)
  assert.throws(() => parseSearchOutput(ok('panic: runtime error')), /unreadable/)
  assert.throws(() => parseSearchOutput(ok('')), /unreadable/)
})

test('a search cut off by its deadline is a failure', () => {
  assert.throws(() => parseSearchOutput({ exitCode: -2, stdout: '[]', stderr: '', timedOut: true }), /timed out/)
})
