// How one failed application is shown on the board and kept in the record.
//
// A normal run must show exactly what it showed before loop mode existed. A
// loop run closes every tab, so it can never ask a person to finish one:
// no "Needs you", and never "tab left open" -- that phrase also keeps a job
// out of every later loop round (leftOpenKeys).
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const unit = path.join(__dirname, '..', '..', 'out', 'unit', 'electron')
const { failureShown, TAB_LEFT_OPEN } = require(path.join(unit, 'agent-result.js'))
const { leftOpenKeys } = require(path.join(unit, 'loop-policy.js'))

const manual = {
  board: `✗ otp_timeout: no code arrived${TAB_LEFT_OPEN}`,
  log: `otp_timeout: no code arrived${TAB_LEFT_OPEN}`,
  needsYou: 'Verification code — enter it in the open tab and submit',
}

test('a normal run shows and records a failure exactly as before', () => {
  assert.deepEqual(failureShown(manual, null), { ...manual, via: 'manual' })
  assert.deepEqual(failureShown({ board: 'Error: boom', log: 'Error: boom' }, null),
    { board: 'Error: boom', log: 'Error: boom', via: 'manual' })
})

test('a loop failure never asks for a person and never says a tab was left open', () => {
  const r = failureShown(manual, { view: { asSkipped: false } })
  assert.deepEqual(r, { board: '✗ otp_timeout: no code arrived', log: 'otp_timeout: no code arrived', via: 'auto' })
  const left = leftOpenKeys([{ platform: 'lever', jobId: 'a', status: 'failed', message: r.log, needsYou: r.needsYou }])
  assert.equal(left.size, 0, 'the loop must not mark its own result as left open')
})

test('a job the loop skipped shows its reason on the board and keeps the failure in the record', () => {
  const r = failureShown(manual, { view: { asSkipped: true, message: 'Needs a person — tab closed; not applied' } })
  assert.deepEqual(r, {
    board: 'Needs a person — tab closed; not applied',
    log: 'otp_timeout: no code arrived',
    skipped: true,
    via: 'auto',
  })
})

test('a skipped job with no reason of its own shows the failure', () => {
  const r = failureShown({ board: '✗ blocked_captcha_puzzle', log: 'blocked_captcha_puzzle' }, { view: { asSkipped: true } })
  assert.equal(r.board, 'blocked_captcha_puzzle')
  assert.equal(r.skipped, true)
})

// What the loop is told about one job's end. The decisions that touch an
// irreversible submission live here, where they can be tested.
const { loopReport } = require(path.join(unit, 'agent-result.js'))
const base = { submittedAs: null, fillStarted: true, canceled: false, timedOut: false, status: 'validation_errors', detail: 'validation_errors x' }

test('a submission is reported as submitted, whatever else happened', () => {
  for (const extra of [{}, { timedOut: true }, { canceled: true }]) {
    assert.deepEqual(loopReport({ ...base, ...extra, submittedAs: 'submitted' }),
      { submitted: true, status: 'submitted', detail: 'submitted', timedOut: false })
  }
})

test('a fill cut off by its deadline or by Stop now is reported as cut off', () => {
  assert.equal(loopReport({ ...base, timedOut: true }).timedOut, true)
  assert.equal(loopReport({ ...base, canceled: true }).timedOut, true)
})

test('Stop now before the filler started reports nothing: no attempt was made', () => {
  assert.equal(loopReport({ ...base, fillStarted: false, canceled: true }), null)
})

test('a failure is reported as it is, for the loop to classify', () => {
  assert.deepEqual(loopReport(base), { submitted: false, status: 'validation_errors', detail: 'validation_errors x', timedOut: false })
  assert.deepEqual(loopReport({ ...base, fillStarted: false, status: 'error', detail: 'Codex: usage limit' }),
    { submitted: false, status: 'error', detail: 'Codex: usage limit', timedOut: false })
})

// Did a fill submit? Go prints "Submission result: X" only when it saw the
// filler finish. A fill cut off -- a normal run cancelled, Stop now, the
// loop's deadline -- can have submitted first; its result file says so.
const { submittedStatus } = require(path.join(unit, 'agent-result.js'))

test("Go's own success line wins", () => {
  assert.equal(submittedStatus('submitted', false, null), 'submitted')
  assert.equal(submittedStatus('submitted', true, { status: 'failed' }), 'submitted')
})

test('a cut-off fill whose fresh result says submitted was submitted — in a normal run too', () => {
  assert.equal(submittedStatus(null, true, { status: 'submitted' }), 'submitted')
})

test('a fill that ran to the end without a success line did not submit', () => {
  assert.equal(submittedStatus(null, false, { status: 'submitted' }), null, 'Go read the same file and said no')
  assert.equal(submittedStatus(null, true, { status: 'not_confirmed' }), null)
  assert.equal(submittedStatus(null, true, null), null)
})
