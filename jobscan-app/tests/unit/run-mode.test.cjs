// Loop runs are marked so the Python fillers close every tab (nobody is there
// to finish one), and the agent pool gets per-job hooks. Neither may leak into
// a normal run.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const { setUnattended, isUnattended, unattendedEnv, setRunHooks, getRunHooks } =
  require('../../out/unit/electron/run-mode.js')

test('the unattended variable exists only while the flag is on', () => {
  assert.equal(isUnattended(), false)
  assert.deepEqual(unattendedEnv(), {})
  setUnattended(true)
  assert.equal(isUnattended(), true)
  assert.deepEqual(unattendedEnv(), { JOB_AUTOMATOR_UNATTENDED: '1' })
  setUnattended(false)
  assert.deepEqual(unattendedEnv(), {})
})

test('hooks are absent unless installed', () => {
  assert.equal(getRunHooks(), null)
  const h = { beforeFill: () => ({ skip: false }), onFillStart() {}, onResult: () => ({ asSkipped: false }) }
  setRunHooks(h)
  assert.equal(getRunHooks(), h)
  setRunHooks(null)
  assert.equal(getRunHooks(), null)
})
