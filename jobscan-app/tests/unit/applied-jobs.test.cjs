// Already-applied jobs were coming back in every run.
//
// appliedJobIds was read in exactly ONE place -- the
// skip-if-clean shortcut in runPayloadGenInner. Nothing in search, pool
// building or rating consulted it, and gen.seen only deduped within a single
// run. So a job applied to last week came back from cliSearch, entered the
// pool, was sent to the rating agent (paying tokens to score something that
// cannot be applied to), and showed up in the selection list again.
//
// Two populations count as spent: confirmed submissions, and applications left
// open for the user ("needs you" -- CAPTCHA, email verification), because the
// tab was handed over so a person could finish it and may well have been
// submitted by hand. Genuine failures stay eligible; a transient error must not
// permanently bury a job that was never actually applied to.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

// The module reads electron-store; stub it the way campaign.cjs does.
let STATE = {}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { __esModule: true, app: { getPath: () => '' } }
  if (request.endsWith('state-store')) {
    return { __esModule: true, default: { get: (k) => STATE[k], set: () => {} } }
  }
  return origLoad.apply(this, arguments)
}
const { appliedKeys, isApplied, jobKey } = require(
  path.join(__dirname, '..', '..', 'out', 'unit', 'electron', 'applied-jobs.js'))
Module._load = origLoad

const reset = (state) => { STATE = state }

test('a confirmed submission is spent', () => {
  reset({ appliedJobIds: ['greenhouse:4000000002'], appliedJobsLog: [] })
  const keys = appliedKeys()
  assert.ok(isApplied(keys, 'greenhouse', '4000000002'))
})

test('a legacy bare job id still matches', () => {
  // Historic entries carry no platform. Migrating the store risked
  // dropping history, so membership accepts both shapes instead.
  reset({ appliedJobIds: ['4000000002'], appliedJobsLog: [] })
  const keys = appliedKeys()
  assert.ok(isApplied(keys, 'greenhouse', '4000000002'))
  assert.ok(isApplied(keys, 'lever', '4000000002'),
    'a bare id cannot be attributed to a platform, so it suppresses conservatively')
})

test('a platform-qualified record does NOT suppress another platform', () => {
  reset({ appliedJobIds: ['greenhouse:123'], appliedJobsLog: [] })
  const keys = appliedKeys()
  assert.ok(isApplied(keys, 'greenhouse', '123'))
  assert.ok(!isApplied(keys, 'lever', '123'),
    'this is the whole point of qualifying new records')
})

test('a needs-you job is spent, because the user may have finished it', () => {
  reset({
    appliedJobIds: [],
    appliedJobsLog: [
      { jobId: 'abc', platform: 'lever', status: 'failed',
        needsYou: 'CAPTCHA challenge — clear it in the open tab and submit' },
    ],
  })
  const keys = appliedKeys()
  assert.ok(isApplied(keys, 'lever', 'abc'))
})

test('a genuine failure stays eligible', () => {
  reset({
    appliedJobIds: [],
    appliedJobsLog: [{ jobId: 'def', platform: 'ashby', status: 'failed', message: 'network error' }],
  })
  const keys = appliedKeys()
  assert.ok(!isApplied(keys, 'ashby', 'def'),
    'a transient failure must not permanently bury a job never applied to')
})

test('a closed posting stays eligible', () => {
  reset({
    appliedJobIds: [],
    appliedJobsLog: [{ jobId: 'ghi', platform: 'greenhouse', status: 'failed', message: 'posting_closed' }],
  })
  const keys = appliedKeys()
  assert.ok(!isApplied(keys, 'greenhouse', 'ghi'))
})

test('empty and malformed records are ignored', () => {
  reset({
    appliedJobIds: ['', '   ', null, undefined],
    appliedJobsLog: [null, {}, { platform: 'lever' }, { jobId: '' }],
  })
  const keys = appliedKeys()
  assert.equal(keys.size, 0)
  assert.ok(!isApplied(keys, 'lever', ''))
  assert.ok(!isApplied(keys, 'lever', 'anything'))
})

test('missing store keys do not throw', () => {
  reset({})
  assert.equal(appliedKeys().size, 0)
})

test('jobKey is the same shape the candidate pool uses', () => {
  assert.equal(jobKey('greenhouse', '123'), 'greenhouse:123')
})
