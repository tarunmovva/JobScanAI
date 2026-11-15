// The query behind the payload prompt's job context.
//
// It named a `company` column that the jobs table does not have (it is
// `company_name`). SQLite raised "no such column", the spawned child exited
// non-zero, and getJobContext's `r.status !== 0` guard returned empty strings.
// Nothing crashed and nothing logged — the only symptom was an empty JOB
// DESCRIPTION section in the payload prompt, for every job. Every written
// payload carried an empty description while jobs.db holds one for
// 270,961 of 271,700 rows.
//
// The query now runs through the jobscan CLI (`db query`), like every other
// database call: a Mac has no `python` command, and the app no longer needs
// one for this. The real-database tests run the query against the REAL
// schema, because a mocked database answers happily for a column that does
// not exist — which is exactly the failure being guarded. They skip on a
// machine with no built CLI or no jobs.db.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const {
  JOB_CONTEXT_COLUMNS, DESCRIPTION_LIMIT, jobContextSql, jobContextFromRows, retryQuickFailures,
} = require('../../out/unit/electron/job-context-sql.js')

// This checkout's CLI; jobs.db sits beside it (cli-runner.getDbPath()).
const exe = path.resolve(__dirname, '..', '..', '..', 'jobscan', process.platform === 'win32' ? 'jobscan.exe' : 'jobscan')
const db = path.join(path.dirname(exe), 'jobs.db')
const ready = () => fs.existsSync(exe) && fs.existsSync(db)
const query = sql => spawnSync(exe, ['--db', db, 'db', 'query', sql], { encoding: 'utf-8', shell: false, maxBuffer: 64 * 1024 * 1024 })

test('every selected column exists in the real jobs table', (t) => {
  if (!ready()) return t.skip('no built jobscan CLI or jobs.db on this machine')
  const r = query(jobContextSql('any-id', 'ashby'))
  assert.doesNotMatch(r.stderr || '', /no such column/,
    'the prompt loses its job description silently when this drifts from the schema')
  assert.equal(r.status, 0, r.stderr)
})

test('a real row comes back with a non-empty description', (t) => {
  if (!ready()) return t.skip('no built jobscan CLI or jobs.db on this machine')
  // Any row that has a description, so the test does not depend on one
  // hard-coded job id surviving future fetches.
  const pick = query("SELECT platform,job_id FROM jobs WHERE description_plain IS NOT NULL AND TRIM(description_plain)<>'' LIMIT 1")
  if (pick.status !== 0) return t.skip('could not sample a row')
  const [{ platform, job_id: jobId }] = JSON.parse(pick.stdout)

  const r = query(jobContextSql(jobId, platform))
  assert.equal(r.status, 0, r.stderr)
  const ctx = jobContextFromRows(JSON.parse(r.stdout))
  assert.ok(ctx.title, 'title should be populated')
  assert.ok(ctx.description && ctx.description.length > 0,
    'description drives the JOB DESCRIPTION section of the payload prompt')
  assert.ok(ctx.description.length <= DESCRIPTION_LIMIT)
})

test('a missing job yields empty context rather than a crash', (t) => {
  if (!ready()) return t.skip('no built jobscan CLI or jobs.db on this machine')
  const r = query(jobContextSql('no-such-job', 'ashby'))
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(jobContextFromRows(JSON.parse(r.stdout)), {})
})

test('single quotes in a job id cannot break out of the query', () => {
  const sql = jobContextSql("o'brien", 'ashby')
  assert.match(sql, /job_id='o''brien'/)
})

test('the row is read by column name, nulls as empty, the description cut to the limit', () => {
  assert.deepEqual([...JOB_CONTEXT_COLUMNS], ['title', 'company_name', 'description_plain'])
  assert.deepEqual(
    jobContextFromRows([{ title: 'Platform Engineer', company_name: 'Acme', description_plain: 'x'.repeat(DESCRIPTION_LIMIT + 500) }]),
    { title: 'Platform Engineer', company: 'Acme', description: 'x'.repeat(DESCRIPTION_LIMIT) })
  assert.deepEqual(jobContextFromRows([{ title: null, company_name: null, description_plain: null }]),
    { title: '', company: '', description: '' })
  assert.deepEqual(jobContextFromRows([]), {})
  assert.deepEqual(jobContextFromRows(null), {})
})

test('the column it used to select really is absent', (t) => {
  if (!ready()) return t.skip('no built jobscan CLI or jobs.db on this machine')
  // Pins the reason for the fix. If a future schema adds a `company` column,
  // this fails and whoever sees it decides which name is canonical, rather
  // than discovering the ambiguity through silently empty prompts.
  const r = query('SELECT company FROM jobs LIMIT 1')
  assert.match(r.stderr || '', /no such column: company/)
})

// On the board, extraction and form answers open jobs.db at the same moments,
// and the CLI fails at once with SQLITE_BUSY instead of waiting. One such
// collision sent a payload prompt out with no job description (seen in a
// real run). A quick failure is retried; a slow one (the timeout) is not.
test('a quick failure (a locked database) is retried; rows end it', async () => {
  let clock = 0
  const answers = [null, null, [{ title: 'x' }]]
  const waits = []
  const rows = await retryQuickFailures(async () => { clock += 100; return answers.shift() }, {
    attempts: 3, delayMs: 1500, quickMs: 5000, now: () => clock, sleep: async ms => { waits.push(ms) },
  })
  assert.deepEqual(rows, [{ title: 'x' }])
  assert.deepEqual(waits, [1500, 1500])
})

test('it gives up after the last attempt, and never retries a slow failure', async () => {
  let calls = 0
  let clock = 0
  const quick = await retryQuickFailures(async () => { calls++; clock += 100; return null }, {
    attempts: 3, delayMs: 10, quickMs: 5000, now: () => clock, sleep: async () => {},
  })
  assert.equal(quick, null)
  assert.equal(calls, 3)

  calls = 0
  const slow = await retryQuickFailures(async () => { calls++; clock += 30_000; return null }, {
    attempts: 3, delayMs: 10, quickMs: 5000, now: () => clock, sleep: async () => {},
  })
  assert.equal(slow, null)
  assert.equal(calls, 1)
})
