// Selection ids, as the Rating screen and the loop hand them to the board.
//
// An id is `<abbr>:<company-slug>:<job_id>` -- the CLI's own `id` field. The
// loop needs each one as the `platform:job_id` key the hooks and the board
// use, and must never mix in an extraction result from another selection.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const unit = path.join(__dirname, '..', '..', 'out', 'unit', 'electron')
const { selectionKey, extractFailures } = require(path.join(unit, 'selection.js'))

test('a selection id becomes the platform and job id the rest of the app keys on', () => {
  assert.equal(selectionKey('lv:example-enterprises-inc.:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'),
    'lever:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')   // the CLI's own id shape
  assert.equal(selectionKey('gh:acme:1234567'), 'greenhouse:1234567')
  assert.equal(selectionKey('ab:co:a:b'), 'ashby:a:b', 'job ids may hold colons')
  assert.equal(selectionKey('gh:acme:'), null)
  assert.equal(selectionKey(''), null)
})

test('only this selection\'s forms that could not be read count', () => {
  const results = [
    { platform: 'lever', jobId: 'a', status: 'failed', title: 'A', company: 'co', error: 'x' },
    { platform: 'lever', jobId: 'b', status: 'extracted', title: 'B', company: 'co' },
    { platform: 'ashby', jobId: 'z', status: 'failed', title: 'Z', company: 'old' },   // a previous run's
  ]
  assert.deepEqual(extractFailures(results, ['lv:co:a', 'lv:co:b']),
    [{ platform: 'lever', jobId: 'a', title: 'A', company: 'co' }])
  assert.deepEqual(extractFailures(undefined, ['lv:co:a']), [])
})

test('a form never tried because a command failed says so', () => {
  const results = [
    { platform: 'lever', jobId: 'a', status: 'failed', title: 'A', company: 'co', error: 'extract exited 1', setupFailed: true },
  ]
  assert.deepEqual(extractFailures(results, ['lv:co:a']),
    [{ platform: 'lever', jobId: 'a', title: 'A', company: 'co', setupFailed: true }])
})

test('the selected jobs of a platform that extraction gave no answer for', () => {
  const { unextracted } = require(path.join(unit, 'selection.js'))
  const ids = ['ab:northwind:a1b2c3d4', 'gh:acme:2', 'ab:co:3', 'ab:co:3']
  assert.deepEqual(unextracted(ids, 'ashby', new Set(['a1b2c3d4'])), [{ platform: 'ashby', jobId: '3' }])
  assert.deepEqual(unextracted(ids, 'greenhouse', new Set()), [{ platform: 'greenhouse', jobId: '2' }])
  assert.deepEqual(unextracted(ids, 'lever', new Set()), [])
})
