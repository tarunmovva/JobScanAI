// The candidate pool: how searches become the jobs a round rates.
//
// researchPool is loop mode's search stage with the CLI injected, so its
// rules run here without a jobs.db: which searches run, the new-postings
// pass, strict failure, and what counts as "no jobs".
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const unit = path.join(__dirname, '..', '..', 'out', 'unit', 'electron')
const { mergeIntoPool, uniqueByKey, researchPool } = require(path.join(unit, 'pool.js'))

const key = j => `${j.platform}:${j.job_id}`
const job = (platform, id) => ({ platform, job_id: String(id) })

test('the pool dedupes by platform and id and leaves out applied jobs', () => {
  const seen = new Set(['greenhouse:1']), pool = []
  const r = mergeIntoPool(seen, pool, [
    { platform: 'greenhouse', job_id: '1' }, { platform: 'lever', job_id: '1' },
    { platform: 'lever', job_id: '2' }, { platform: 'lever', job_id: '2' },
  ], (p, id) => p === 'lever' && id === '2')
  assert.deepEqual(r.added.map(j => `${j.platform}:${j.job_id}`), ['lever:1'])
  assert.equal(r.skippedApplied, 1)
  assert.equal(pool.length, 1)
})

test('uniqueByKey keeps the first job of each platform and id', () => {
  const a = { ...job('lever', 1), rating: 9 }
  const b = { ...job('lever', 1), rating: 3 }
  const c = { ...job('ashby', 1), rating: 5 }
  assert.deepEqual(uniqueByKey([a, b, c]), [a, c])
})

// A fake CLI: each search's flags map to the rows it returns.
function fakeSearch(table, calls = []) {
  return async tokens => {
    calls.push(tokens)
    const flags = tokens.join(' ')
    for (const [needle, rows] of table) {
      if (flags.includes(needle)) {
        if (rows instanceof Error) throw rows
        return rows.map(([p, id]) => job(p, id))
      }
    }
    return []
  }
}

const usa = (name, extra = '') => ({ name, flags: `--title-query "'${name}'" --market usa${extra}`, description: '', count: 10 })

test('the first round runs each saved search once, as saved', async () => {
  const calls = []
  const run = [{ ...usa('backend'), index: 0 }, { ...usa('platform'), index: 2 }]
  const r = await researchPool({
    run, sinceDate: null, previousPool: [], isApplied: () => false,
    search: fakeSearch([["'backend'", [['lever', 1]]], ["'platform'", [['ashby', 2]]]], calls),
  })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(t => !t.includes('--since')))
  assert.deepEqual(r.entries.map(e => [e.index, e.query.name, e.found, e.totalAfter]),
    [[0, 'backend', 1, 1], [2, 'platform', 1, 2]])
  assert.equal(r.entries[0].query.index, undefined, 'the saved entry is stored without its position')
})

test('later rounds add the same search, newest first, since the previous round', async () => {
  const calls = []
  const r = await researchPool({
    run: [{ ...usa('backend', ' --limit 50 --sort relevance'), index: 0 }],
    sinceDate: '2026-11-12', previousPool: [], isApplied: () => false,
    search: fakeSearch([['--since 2026-11-12', [['lever', 9]]], ["'backend'", [['lever', 1]]]], calls),
  })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].slice(-6), ['--sort', 'newest', '--since', '2026-11-12', '--limit', '100'])
  assert.ok(!calls[1].includes('relevance') && !calls[1].includes('50'), 'replaced, not appended')
  assert.deepEqual(r.pool.map(key), ['lever:1', 'lever:9'])
  assert.equal(r.entries[0].found, 2)
})

test('a failing search fails the stage, names the search, and runs nothing after it', async () => {
  const calls = []
  const r = await researchPool({
    run: [{ ...usa('backend'), index: 0 }, { ...usa('platform'), index: 1 }],
    sinceDate: null, previousPool: [], isApplied: () => false,
    search: fakeSearch([["'backend'", new Error('exit 1: unknown flag')]], calls),
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'Search failed: backend')
  assert.equal(calls.length, 1)
})

test('searches that all return nothing fail the stage rather than counting as an empty round', async () => {
  const r = await researchPool({
    run: [{ ...usa('backend'), index: 0 }], sinceDate: '2026-11-12',
    previousPool: [job('lever', 1)], isApplied: () => false, search: fakeSearch([]),
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'Searches returned no jobs')
})

test('searches whose jobs are all applied to are a working search with an empty pool', async () => {
  const r = await researchPool({
    run: [{ ...usa('backend'), index: 0 }], sinceDate: null,
    previousPool: [], isApplied: () => true, search: fakeSearch([["'backend'", [['lever', 1], ['lever', 2]]]]),
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.pool, [])
  assert.equal(r.newJobs, 0)
})

test('the pool dedupes across searches and passes; new jobs are the ones the last pool lacked', async () => {
  const r = await researchPool({
    run: [{ ...usa('backend'), index: 0 }, { ...usa('platform'), index: 1 }],
    sinceDate: '2026-11-12', previousPool: [job('lever', 1), job('ashby', 7)], isApplied: () => false,
    search: fakeSearch([
      ['--since', [['lever', 3]]],
      ["'backend'", [['lever', 1], ['lever', 2]]],
      ["'platform'", [['lever', 2], ['ashby', 4]]],
    ]),
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.pool.map(key), ['lever:1', 'lever:2', 'lever:3', 'ashby:4'])
  assert.equal(r.newJobs, 3)
  assert.deepEqual(r.entries.map(e => e.found), [3, 1])
  assert.equal('skippedSearches' in r, false)
})

test('with no saved searches nothing runs', async () => {
  const calls = []
  const r = await researchPool({
    run: [], sinceDate: null,
    previousPool: [], isApplied: () => false, search: fakeSearch([], calls),
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'No saved searches — run Find Jobs once first')
  assert.equal(calls.length, 0)
})

test('progress is reported per search, with the saved position', async () => {
  const seen = []
  await researchPool({
    run: [{ ...usa('backend'), index: 3 }], sinceDate: null, previousPool: [],
    isApplied: () => false, search: fakeSearch([["'backend'", [['lever', 1]]]]),
    events: {
      started: (i, q) => seen.push(['started', i, q.name]),
      searched: (i, found, total) => seen.push(['searched', i, found, total]),
    },
  })
  assert.deepEqual(seen, [['started', 3, 'backend'], ['searched', 3, 1, 1]])
})
