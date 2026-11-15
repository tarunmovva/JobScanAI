// What the loop's chip and start warning say. The chip is the only place a
// person sees, at a glance, whether the app is applying on its own right now.
// Every state it can be in has a legend entry (project rule: new codes ship
// with an in-app legend, pinned against drift).
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { CHIP_LEGEND, STAGE_LABELS, chipLabel, startConfirmCopy, roundLines, roundsTotal, unfinishedCount } =
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

// ── last rounds ──────────────────────────────────────────────────────────────
// The panel's round list. It used to be an eight-column table where Picked was
// always Sent + Failed + Skipped and most cells were 0; now each round says
// what happened, and only what is not zero.

const SAT = new Date(2026, 10, 14, 3, 0)   // Saturday 03:00, local time
const round = (h, m, counts, extra = {}) => {
  const start = new Date(2026, 10, 14, h, m)
  return {
    startedAt: start.toISOString(),
    endedAt: new Date(+start + 14 * 60_000).toISOString(),
    newJobs: 0, newlyRated: 0, selected: 0, submitted: 0, failed: 0, skipped: 0, searched: true,
    ...counts, ...extra,
  }
}

// The rounds a real loop showed, newest first.
const REAL = [
  round(2, 47, { newJobs: 1, newlyRated: 1 }),
  round(2, 32, { newJobs: 3, newlyRated: 3, selected: 1, submitted: 1 }),
  round(2, 17, { newJobs: 1, newlyRated: 1 }),
  round(2, 2, { newJobs: 3, newlyRated: 3 }),
  round(1, 47, { newJobs: 1, newlyRated: 21, selected: 23, submitted: 23 }),
]

test('rounds read as what happened, and back-to-back quiet rounds fold into one row', () => {
  const lines = roundLines(REAL, SAT)
  assert.deepEqual(lines.map(l => [l.time, l.quiet, l.outcome.map(o => o.text), l.detail]), [
    ['02:47', true, [], '1 new job, nothing to apply to'],
    ['02:32', false, ['1 sent'], '3 new jobs'],
    ['02:02–02:17', true, [], '2 rounds, 4 new jobs, nothing to apply to'],
    // Rated above New: older jobs that were never rated got rated too.
    ['01:47', false, ['23 sent'], '1 new job, 21 rated'],
  ])
  assert.ok(lines.every(l => l.day === 'Today'))
  assert.equal(roundsTotal(REAL), '24 sent in 5 rounds')
})

test('every number stays one hover away', () => {
  const [, sent] = roundLines(REAL, SAT)
  assert.equal(sent.tooltip, 'Started 02:32, took 14 minutes. 3 new, 3 rated, 1 picked: 1 sent, 0 failed, 0 skipped.')
  const folded = roundLines(REAL, SAT)[2]
  assert.equal(folded.tooltip, '2 rounds from 02:02 to 02:17: 4 new, 4 rated, none picked.')
})

test('only outcomes that happened are shown, sent first', () => {
  const [l] = roundLines([round(1, 0, { newJobs: 5, newlyRated: 5, selected: 6, submitted: 2, failed: 1, skipped: 3 })], SAT)
  assert.deepEqual(l.outcome.map(o => [o.tone, o.text]), [['sent', '2 sent'], ['failed', '1 failed'], ['skipped', '3 skipped']])
})

test('a stopped round tells fills that may have gone in from jobs that never started', () => {
  // Stop now, a timeout or a Codex limit ends the round before every picked
  // job has a result. Only a fill already under way may have gone in.
  const r = round(1, 0, { newJobs: 2, newlyRated: 2, selected: 6, submitted: 1, skipped: 1 }, { error: 'Stopped by you', cutOff: 1 })
  assert.deepEqual(unfinishedCount(r), { cutOff: 1, notStarted: 3 })
  const [l] = roundLines([r], SAT)
  assert.deepEqual(l.outcome.map(o => [o.tone, o.text]),
    [['sent', '1 sent'], ['cutoff', '1 cut off'], ['skipped', '1 skipped'], ['unfinished', '3 not started']])
  assert.equal(l.note, 'Stopped by you')
  assert.match(l.tooltip, /1 cut off mid-fill \(may have gone in: check your email\), 3 never started\.$/)
})

test('rounds recorded before cut-offs were counted say "not finished", never guess', () => {
  const r = round(1, 0, { selected: 4, submitted: 1 }, { error: 'Stopped by you' })
  assert.deepEqual(unfinishedCount(r), { cutOff: null, notStarted: 3 })
  const [l] = roundLines([r], SAT)
  assert.deepEqual(l.outcome.map(o => [o.tone, o.text]), [['sent', '1 sent'], ['unfinished', '3 not finished']])
})

test('a round that ended early says why; a Codex limit is not shown as a fault', () => {
  const [failed] = roundLines([round(1, 0, {}, { error: 'Search failed: backend roles', searched: false })], SAT)
  assert.equal(failed.quiet, false, 'a failed round is never folded away')
  assert.equal(failed.note, 'Search failed: backend roles')
  assert.equal(failed.noteIsError, true)
  assert.equal(failed.detail, '', 'it never searched, so it found nothing to report')
  const [limit] = roundLines([round(1, 0, { newJobs: 2, newlyRated: 2 }, { error: 'Codex usage limit', codexLimit: true })], SAT)
  assert.equal(limit.noteIsError, false)
  assert.equal(limit.detail, '2 new jobs')
})

test('quiet rounds never fold across a failed round or across days', () => {
  const lines = roundLines([
    round(2, 0, { newJobs: 1, newlyRated: 1 }),
    round(1, 45, {}, { error: 'Rating failed' }),
    round(1, 30, { newJobs: 1, newlyRated: 1 }),
    { ...round(23, 50, { newJobs: 2, newlyRated: 2 }), startedAt: new Date(2026, 10, 13, 23, 50).toISOString() },
  ], SAT)
  assert.deepEqual(lines.map(l => [l.day, l.time]), [['Today', '02:00'], ['Today', '01:45'], ['Today', '01:30'], ['Yesterday', '23:50']])
  assert.equal(roundLines([{ ...round(9, 0, {}), startedAt: new Date(2026, 10, 10, 9, 0).toISOString() }], SAT)[0].day, 'Tue, Nov 10')
})

test('the total counts rounds and sends, one or many', () => {
  assert.equal(roundsTotal([round(1, 0, {})]), '0 sent in 1 round')
})
