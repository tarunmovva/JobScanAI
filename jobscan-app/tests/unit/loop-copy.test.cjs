// What the loop's chip and start warning say. The chip is the only place a
// person sees, at a glance, whether the app is applying on its own right now.
// Every state it can be in has a legend entry (project rule: new codes ship
// with an in-app legend, pinned against drift).
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { CHIP_LEGEND, STAGE_LABELS, chipLabel, startConfirmCopy } =
  require(path.join(__dirname, '..', '..', 'out', 'unit', 'electron', 'loop-copy.js'))

const NOW = new Date(2026, 10, 12, 22, 0)   // Thursday, local time
const base = {
  phase: 'off', round: 0, stage: null, nextAt: null, waitReason: '',
  codexUsage: { fiveHour: null, weekly: null }, stopReason: '',
  today: { attempted: 0, limit: 25 }, paused: [], excluded: [], history: [],
  settings: { threshold: 8, dailyLimit: 25, minGapMin: 60 },
}

test('every loop state has one legend entry', () => {
  assert.deepEqual(CHIP_LEGEND.map(e => e.phase).sort(), ['off', 'running', 'stopped', 'stopping', 'waiting'])
  for (const e of CHIP_LEGEND) assert.ok(e.label && e.meaning.length > 20, e.phase)
})

test('the chip says where the loop is', () => {
  assert.equal(chipLabel({ ...base, phase: 'off' }, NOW), 'Loop')
  assert.equal(chipLabel({ ...base, phase: 'running', round: 3, stage: 'apply' }, NOW), 'Round 3 · Applying')
  assert.equal(chipLabel({ ...base, phase: 'running', round: 1, stage: null }, NOW), 'Round 1')
  assert.equal(chipLabel({ ...base, phase: 'stopping' }, NOW), 'Stopping…')
  assert.equal(chipLabel({ ...base, phase: 'waiting', nextAt: new Date(2026, 10, 12, 23, 40).toISOString() }, NOW), 'Next 23:40')
  assert.equal(chipLabel({ ...base, phase: 'waiting', nextAt: new Date(2026, 10, 13, 0, 0).toISOString() }, NOW), 'Next Fri 00:00')
  assert.equal(chipLabel({ ...base, phase: 'waiting', waitReason: 'codex_5h', nextAt: new Date(2026, 10, 12, 23, 34).toISOString() }, NOW), 'Waiting — Codex 5-hour limit · resets 23:34')
  assert.equal(chipLabel({ ...base, phase: 'waiting', waitReason: 'codex_weekly', nextAt: new Date(2026, 10, 14, 14, 5).toISOString() }, NOW), 'Waiting — Codex weekly limit · resets Sat 14:05')
  assert.equal(chipLabel({ ...base, phase: 'waiting', waitReason: 'codex_unknown', nextAt: new Date(2026, 10, 12, 23, 0).toISOString() }, NOW), 'Waiting — Codex usage limit · retry 23:00')
  assert.equal(chipLabel({ ...base, phase: 'stopped', stopReason: 'Codex is not signed in' }, NOW), 'Stopped — Codex is not signed in')
  assert.equal(chipLabel({ ...base, phase: 'stopped' }, NOW), 'Stopped')
})

test('the stage labels are exact', () => {
  assert.deepEqual(STAGE_LABELS, { rebuild: 'Rebuilding', search: 'Finding jobs', rate: 'Rating', apply: 'Applying' })
})

test('the start warning is exact', () => {
  assert.equal(startConfirmCopy({ threshold: 8, dailyLimit: 25, minGapMin: 60 }),
    'Loop mode sends real applications without asking — up to 25 a day, to jobs rated 8 or higher from your saved searches. They cannot be withdrawn. Start?')
  assert.equal(startConfirmCopy({ threshold: 9, dailyLimit: 3, minGapMin: 15 }),
    'Loop mode sends real applications without asking — up to 3 a day, to jobs rated 9 or higher from your saved searches. They cannot be withdrawn. Start?')
})
