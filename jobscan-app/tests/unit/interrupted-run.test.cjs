// A run that did not finish must not carry into the next one.
//
// Closing the app mid-run left a board describing work that stopped hours ago,
// a selection from that run, and jobs.db rows stuck at claimed/filling whose
// process died with the app. The next run inherited all of it.
//
// The rule has one hard exception, and it is the one that matters: an
// application that was already SUBMITTED cannot be taken back, so its record
// must survive. If it did not, the job would fall out of the applied list and
// be applied to a second time -- a real duplicate sent to a real employer.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  IN_FLIGHT_STATUSES, RUN_STATE_KEYS, PRESERVED_KEYS,
  wasInterrupted, abandonSql, landingState, RESUME_STATE,
} = require(path.join(__dirname, '..', '..', 'out', 'unit', 'electron', 'interrupted-run.js'))

test('closing on the board is an interrupted run', () => {
  assert.equal(wasInterrupted('board', 0), true)
  assert.equal(wasInterrupted('board', 3), true)
})

test('board cards left on an earlier screen are residue too', () => {
  // The quieter case, and the one actually found in the store: appState was
  // 'query_gen' with two cards from a previous run still sitting there.
  for (const s of ['resume', 'query_gen', 'rating']) {
    assert.equal(wasInterrupted(s, 2), true, s)
    assert.equal(wasInterrupted(s, 0), false, `${s} with a clean board`)
  }
})

test('a finished run is not residue, however many cards it has', () => {
  // 'done' is a result the user asked to see. Discarding it would delete the
  // summary of a run that completed normally.
  assert.equal(wasInterrupted('done', 8), false)
  assert.equal(wasInterrupted('done', 0), false)
})

test('only the board strands the user, so only the board redirects', () => {
  // A discarded board would render empty with no way to fill it. Someone on an
  // earlier screen is somewhere valid and must not be moved out from under.
  assert.equal(landingState('board'), RESUME_STATE)
  for (const s of ['resume', 'query_gen', 'rating', 'done']) {
    assert.equal(landingState(s), null, s)
  }
})

test('nothing recording a real application is cleared', () => {
  // The whole safety property in one assertion.
  for (const keep of PRESERVED_KEYS) {
    assert.ok(!RUN_STATE_KEYS.includes(keep),
      `${keep} records work that actually happened and must survive`)
  }
  assert.ok(PRESERVED_KEYS.includes('appliedJobIds'))
  assert.ok(PRESERVED_KEYS.includes('appliedJobsLog'))
})

test('ratings survive, so the next run does not re-rate', () => {
  assert.ok(PRESERVED_KEYS.includes('ratedJobs'))
  assert.ok(!RUN_STATE_KEYS.includes('ratedJobs'))
})

test('the run state cleared is the board, the selection and the caches', () => {
  assert.deepEqual([...RUN_STATE_KEYS], [
    'boardCards', 'selectedJobIds', 'extractResults',
    'extractInputHash', 'payloadInputHash',
  ])
})

test('the skip-if-clean caches are cleared with the work they describe', () => {
  // Left behind, they convince the next run that the abandoned extraction and
  // payload generation are still valid, so it skips redoing them.
  assert.ok(RUN_STATE_KEYS.includes('extractInputHash'))
  assert.ok(RUN_STATE_KEYS.includes('payloadInputHash'))
})

test('every in-flight status is abandoned and no terminal one is touched', () => {
  const sql = abandonSql()
  for (const s of IN_FLIGHT_STATUSES) {
    assert.match(sql, new RegExp(`'${s}'`), `${s} would be left for the next run`)
  }
  // Submitted and failed are terminal. Rewriting 'submitted' would erase the
  // record of an application that was really sent.
  assert.doesNotMatch(sql, /IN \([^)]*'submitted'/)
  assert.match(sql, /SET status='failed'/)
})

test('the abandon statement is scoped by status, not a blanket update', () => {
  const sql = abandonSql()
  assert.match(sql, /WHERE status IN \(/, 'an unscoped UPDATE would rewrite every row')
  assert.match(sql, /error='abandoned/, 'the reason must be legible in the db')
})

test('the user lands where a new selection is made', () => {
  // The selection went with the run, so returning to the board would show an
  // empty one with no way to fill it.
  assert.equal(RESUME_STATE, 'rating')
})
