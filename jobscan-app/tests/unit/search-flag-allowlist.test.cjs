// Search flags written by an AI are checked against an allowlist before the
// jobscan CLI ever sees them.
//
// The model writes them after reading the résumé, and the saved ones re-run
// every loop round. `--db` opens or creates any SQLite file and
// `-o/--output` overwrites any file -- the app's own config.json, the only
// record of past applications, included. The check reads tokens the way the
// CLI's flag parser does, so the combined and `=` forms are caught too.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const unit = path.join(__dirname, '..', '..', 'out', 'unit', 'electron')
const { searchFlagProblem, tokenizeQueryFlags } = require(path.join(unit, 'query-flags.js'))
const { researchPool } = require(path.join(unit, 'pool.js'))

const ok = flags => assert.equal(searchFlagProblem(tokenizeQueryFlags(flags)), null, flags)
const refused = (flags, flag) => {
  const problem = searchFlagProblem(tokenizeQueryFlags(flags))
  assert.ok(problem && problem.includes(flag), `${flags} -> ${problem}`)
}

test('every flag the search prompt teaches is allowed', () => {
  ok(`--title-query "'backend engineer' OR 'platform engineer'" --market usa --since 30d`)
  ok(`--key-query "'kubernetes' AND 'go'" --exclude-title-phrase senior,staff --remote --hybrid --onsite`)
  ok(`--company stripe,anthropic --platform lever,ashby --location berlin --type full-time --exclude-key-query "'unpaid'"`)
  ok(`-d -Q "'rust'" --no-expand --dedupe --max-per-company 2 --limit=50 --sort newest --offset 0 --fast --raw`)
  ok(`-dQ "'rust'"`)
  ok(`-Qrust`)
  ok(`backend engineer --market europe`)
})

test('flags that open or write files, or change the output, are refused', () => {
  refused('--title-query x --db C:/Users/me/AppData/Roaming/jobscan-app/jobs.db', '--db')
  refused('--title-query x --db=other.db', '--db')
  refused('--title-query x -o C:/Users/me/AppData/Roaming/jobscan-app/config.json', '-o')
  refused('--title-query x --output=config.json', '--output')
  refused('--title-query x -oconfig.json', '-o')
  refused('--title-query x -do/tmp/x', '-o')
  refused('--title-query x --format csv', '--format')
  refused('--title-query x --count', '--count')
  refused('--title-query x --help', '--help')
  refused('--title-query x -h', '-h')
  refused('--title-query x --not-a-flag 1', '--not-a-flag')
  refused('--title-query x -=', '-=')
})

test('`--` is refused: the app\'s own flags after it would become search words', () => {
  for (const flags of ['--market usa -- --db x', '--title-query x --', '-- backend']) {
    const problem = searchFlagProblem(tokenizeQueryFlags(flags))
    assert.ok(problem && problem.startsWith('Search flag -- '), `${flags} -> ${problem}`)
  }
})

test("a flag's value is never read as a flag, as the CLI reads it", () => {
  ok(`--title-query --db`)            // --db is the title query's value
  ok(`-Q -o`)                         // so is -o here
  ok(`--title-query x -d=true`)       // a switch with its own value, as the CLI accepts
  ok(`-d=false --market usa`)
})

test('a saved search with a refused flag is skipped, and the rest still run', async () => {
  const calls = []
  const failures = []
  const r = await researchPool({
    run: [
      { name: 'bad', flags: `--title-query "'x'" -o C:/somewhere/config.json`, description: '', count: 10, index: 0 },
      { name: 'good', flags: `--title-query "'backend'" --market usa`, description: '', count: 10, index: 1 },
    ],
    sinceDate: null, previousPool: [], isApplied: () => false,
    search: async tokens => { calls.push(tokens); return [{ platform: 'lever', job_id: '1', title: 't', company: 'c' }] },
    events: { failed: (index, error, detail) => failures.push([index, error, detail]) },
  })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1, 'only the safe search ran')
  assert.ok(!calls[0].includes('-o'))
  assert.equal(failures.length, 1)
  assert.equal(failures[0][0], 0)
  assert.match(failures[0][2], /-o is not allowed/)
})
