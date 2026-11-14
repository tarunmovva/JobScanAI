// A Codex turn whose reply and completion arrive in the same chunk as the
// turn/start reply. readline delivers those lines before the client learns
// the turn id; they used to be dropped, and the call then waited out its
// 3-minute timeout -- so a fast "usage limit" failure looked like a timeout
// and was charged to the job. The client now parks them by turn id and
// claims them the moment it registers the turn.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { EarlyTurnEvents } = require(path.join(__dirname, '..', '..', 'out', 'unit', 'electron', 'turn-buffer.js'))

test('text and completion that came first are handed over when the turn is claimed', () => {
  const early = new EarlyTurnEvents()
  early.delta('tu-1', '[{"job_id"')
  early.delta('tu-1', ':"1"}]')
  early.completed('tu-1', { status: 'completed', error: undefined })
  assert.deepEqual(early.take('tu-1'), {
    text: '[{"job_id":"1"}]',
    completion: { status: 'completed', error: undefined },
  })
  assert.equal(early.size, 0, 'claimed once, then gone')
  assert.deepEqual(early.take('tu-1'), { text: '', completion: null })
})

test('a failed turn keeps its error, so a usage limit is reported as one', () => {
  const early = new EarlyTurnEvents()
  const error = { message: 'You have hit your usage limit. Try again in 2 hours.' }
  early.completed('tu-2', { status: 'failed', error })
  assert.deepEqual(early.take('tu-2').completion, { status: 'failed', error })
})

test('turns are kept apart', () => {
  const early = new EarlyTurnEvents()
  early.delta('a', 'one')
  early.delta('b', 'two')
  assert.equal(early.take('a').text, 'one')
  assert.equal(early.take('b').text, 'two')
})

test('nothing claimed is kept forever', () => {
  let now = 0
  const early = new EarlyTurnEvents(60_000, () => now)
  early.delta('orphan', 'text from a turn that already timed out')
  now = 61_000
  early.delta('fresh', 'x')
  assert.equal(early.take('orphan').text, '', 'pruned')
  assert.equal(early.take('fresh').text, 'x')
})
