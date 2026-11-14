// Every tag a card in Defects can carry is explained on the board (project
// rule: new codes ship with an in-app legend, pinned against drift).
//
// The defects are collected by driving the real reducer through every event
// that lands a card in Defects -- not read from the same list the legend uses.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const unit = path.join(__dirname, '..', '..', 'out', 'unit', 'electron')
const { DEFECT_TAGS } = require(path.join(unit, 'board-tags.js'))
const { applyBoardEvent, emptyBoard, seedCards } = require(path.join(unit, 'board-state.js'))

const EVENTS_INTO_DEFECTS = [
  { type: 'payload:progress', state: 'failed', needsYou: 'CAPTCHA challenge — clear it in the open tab and submit', message: 'x' },
  { type: 'payload:progress', state: 'failed', message: 'validation_errors' },
  { type: 'payload:progress', state: 'failed', skipped: true, message: 'CAPTCHA — tab closed; not applied' },
  { type: 'extract:job', status: 'failed', error: 'extractor failed' },
]

test('every way a card lands in Defects has exactly one legend entry', () => {
  const defects = new Set(EVENTS_INTO_DEFECTS.map(ev => {
    const b = applyBoardEvent(seedCards(emptyBoard(), [{ platform: 'lever', jobId: 'a' }]),
      { ...ev, platform: 'lever', jobId: 'a' })
    assert.equal(b['lever:a'].column, 'defect')
    return b['lever:a'].defect
  }))
  assert.deepEqual([...defects].sort(), ['error', 'needs_you', 'skipped'])
  for (const d of defects) assert.equal(DEFECT_TAGS.filter(t => t.id === d).length, 1, d)
  for (const t of DEFECT_TAGS) assert.ok(t.label && t.meaning.length > 20, t.id)
})

test('the Skipped tag says it was not applied and can still be done by hand', () => {
  const skipped = DEFECT_TAGS.find(t => t.id === 'skipped')
  assert.equal(skipped.label, 'Skipped')
  assert.match(skipped.meaning, /not applied/i)
  assert.match(skipped.meaning, /by hand/i)
})
