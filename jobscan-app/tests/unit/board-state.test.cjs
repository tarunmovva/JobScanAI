// The board is a projection of pipeline events onto per-job cards.
//
// The event stream guarantees nothing about ordering or uniqueness: extraction
// and the agent pool run concurrently, events cross IPC, and a re-run replays
// cached results. So the reducer has to be total -- every event either moves a
// card or is ignored, and no sequence can produce a card in a state that
// contradicts what actually happened.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { applyBoardEvent, emptyBoard, seedCards, COLUMNS } = require(
  path.join(__dirname, '..', '..', 'out', 'unit', 'electron', 'board-state.js'))

const JOB = { platform: 'greenhouse', jobId: '123', company: 'acme', title: 'Engineer', applyUrl: 'https://x/1' }
const KEY = 'greenhouse:123'

const seeded = () => seedCards(emptyBoard(), [JOB])
const col = (b, k = KEY) => b[k] && b[k].column

test('seeding puts every selected job in to-do', () => {
  const b = seeded()
  assert.equal(col(b), 'todo')
  assert.equal(b[KEY].company, 'acme')
})

test('the full happy path walks every column in order', () => {
  let b = seeded()
  b = applyBoardEvent(b, { type: 'extract:job', ...JOB, status: 'extracted' })
  assert.equal(col(b), 'extracted')
  b = applyBoardEvent(b, { type: 'payload:progress', ...JOB, state: 'working', phase: 'generating' })
  assert.equal(col(b), 'applying')
  b = applyBoardEvent(b, { type: 'payload:progress', ...JOB, state: 'working', phase: 'filling' })
  assert.equal(col(b), 'applying', 'generating and filling share a column')
  assert.equal(b[KEY].detail, undefined)
  b = applyBoardEvent(b, { type: 'payload:progress', ...JOB, state: 'done', message: 'submitted' })
  assert.equal(col(b), 'done')
})

test('a card stays in To do until its OWN form is extracted', () => {
  // extract:start used to sweep every card of a platform into 'extracting' at
  // once, so To do emptied the instant a run began and was never seen
  // populated. Extraction runs three workers and reports only on completion.
  let b = seedCards(emptyBoard(), [JOB, { ...JOB, jobId: '456' }])
  b = applyBoardEvent(b, { type: 'extract:start', platform: 'greenhouse' })
  assert.equal(b['greenhouse:123'].column, 'todo')
  assert.equal(b['greenhouse:456'].column, 'todo')
  b = applyBoardEvent(b, { type: 'extract:job', ...JOB, status: 'extracted' })
  assert.equal(b['greenhouse:123'].column, 'extracted')
  assert.equal(b['greenhouse:456'].column, 'todo', 'the other job has not been extracted yet')
})

test('a failed extraction lands in defects, tagged as an error', () => {
  let b = seeded()
  b = applyBoardEvent(b, { type: 'extract:job', ...JOB, status: 'failed', error: 'no form' })
  assert.equal(col(b), 'defect')
  assert.equal(b[KEY].defect, 'error')
  assert.match(b[KEY].detail, /no form/)
})

test('a failure with a needs-you reason routes to needs_you, not failed', () => {
  let b = seeded()
  b = applyBoardEvent(b, {
    type: 'payload:progress', ...JOB, state: 'failed',
    message: 'otp_required', needsYou: 'Email verification needed — enter the code in the open tab',
  })
  assert.equal(col(b), 'defect')
  assert.equal(b[KEY].defect, 'needs_you')
  assert.match(b[KEY].needsYou, /Email verification/)
})

test('a failure without a reason is an error, not a needs-you', () => {
  let b = seeded()
  b = applyBoardEvent(b, { type: 'payload:progress', ...JOB, state: 'failed', message: 'network error' })
  assert.equal(col(b), 'defect')
  assert.equal(b[KEY].defect, 'error')
  assert.equal(b[KEY].needsYou, undefined)
})

test('terminal columns are not walked back by a late in-flight event', () => {
  // The agent pool and extraction run concurrently; a stale 'filling' arriving
  // after 'done' must not resurrect a finished application.
  let b = seeded()
  b = applyBoardEvent(b, { type: 'payload:progress', ...JOB, state: 'done', message: 'submitted' })
  b = applyBoardEvent(b, { type: 'payload:progress', ...JOB, state: 'working', phase: 'filling' })
  assert.equal(col(b), 'done')
})

test('a defect is terminal too', () => {
  let b = seeded()
  b = applyBoardEvent(b, { type: 'payload:progress', ...JOB, state: 'failed', needsYou: 'CAPTCHA' })
  b = applyBoardEvent(b, { type: 'payload:progress', ...JOB, state: 'working', phase: 'generating' })
  assert.equal(col(b), 'defect')
})

test('duplicate events are idempotent', () => {
  let b = seeded()
  const ev = { type: 'extract:job', ...JOB, status: 'extracted' }
  b = applyBoardEvent(b, ev)
  const once = JSON.stringify(b[KEY].column)
  b = applyBoardEvent(b, ev)
  b = applyBoardEvent(b, ev)
  assert.equal(JSON.stringify(b[KEY].column), once)
  assert.equal(Object.keys(b).length, 1)
})

test('an event for an unseeded job creates the card rather than dropping it', () => {
  // A cached extract replay can emit for a job the board never seeded.
  let b = emptyBoard()
  b = applyBoardEvent(b, { type: 'extract:job', ...JOB, status: 'extracted' })
  assert.equal(col(b), 'extracted')
  assert.equal(b[KEY].company, 'acme')
})

test('events with no job id are ignored', () => {
  let b = seeded()
  const before = JSON.stringify(b)
  for (const ev of [
    { type: 'payload:progress', agentId: 'system', company: 'Starting Chrome...', jobId: '', state: 'working' },
    { type: 'extract:job', platform: 'greenhouse', jobId: '', status: 'extracted' },
    { type: 'payload:progress' },
    {},
  ]) b = applyBoardEvent(b, ev)
  assert.equal(JSON.stringify(b), before)
})

test('unknown event types leave the board untouched', () => {
  let b = seeded()
  const before = JSON.stringify(b)
  assert.equal(JSON.stringify(applyBoardEvent(b, { type: 'rating:done' })), before)
})

test('extract:start moves nothing at all', () => {
  let b = seedCards(emptyBoard(), [JOB, { ...JOB, platform: 'lever', jobId: 'abc' }])
  const before = JSON.stringify(b)
  b = applyBoardEvent(b, { type: 'extract:start', platform: 'greenhouse' })
  assert.equal(JSON.stringify(b), before)
})

// The reducer still supports extract:clear, but the pipeline no longer routes
// it: it fires inside runExtract, after the board has been seeded at selection
// time, and would empty To do a moment after filling it. Kept because a clear
// is the correct response to the event, and a future caller may want it.
test('extract:clear resets to a clean board', () => {
  let b = seeded()
  b = applyBoardEvent(b, { type: 'extract:job', ...JOB, status: 'extracted' })
  b = applyBoardEvent(b, { type: 'extract:clear' })
  assert.deepEqual(b, {})
})

test('the reducer never mutates the board it was given', () => {
  const b = seeded()
  const snapshot = JSON.stringify(b)
  applyBoardEvent(b, { type: 'extract:job', ...JOB, status: 'extracted' })
  assert.equal(JSON.stringify(b), snapshot)
})

test('agentId and detail are carried for display', () => {
  let b = seeded()
  b = applyBoardEvent(b, {
    type: 'payload:progress', ...JOB, state: 'working', phase: 'filling',
    agentId: 'app-3', message: 'Filling form...',
  })
  assert.equal(b[KEY].agentId, 'app-3')
  assert.equal(b[KEY].detail, 'Filling form...')
})

test('COLUMNS lists every column the reducer can produce', () => {
  assert.deepEqual([...COLUMNS], ['todo', 'extracted', 'applying', 'done', 'defect'])
})

test('every in-flight payload:progress push carries a phase', () => {
  // The board reads phase, not the English message. A 'working' push without
  // one moves no card: the first live run had cards jump generating -> done,
  // skipping Filling entirely, because one of the two pushes was missed.
  const fs = require('node:fs')
  const src = fs.readFileSync(
    require('node:path').join(__dirname, '..', '..', 'electron', 'pipeline.ts'), 'utf-8')
  const working = src.match(new RegExp("state: 'working'[^\\n]*", 'g')) || []
  assert.ok(working.length >= 2, `expected the generating and filling pushes, found ${working.length}`)
  for (const line of working) {
    // A push with an empty jobId is not a card event -- the Chrome-startup
    // notice uses payload:progress purely to put a message on screen.
    if (line.includes("jobId: ''")) continue
    assert.match(line, /phase: '(generating|filling)'/,
      `a working push with no phase moves no card: ${line.trim()}`)
  }
})

test('a skipped result lands in Defects tagged skipped, and stays there', () => {
  // Loop mode reports jobs it deliberately did not finish (a CAPTCHA page it
  // closed, a paused platform) as skipped: not a failure, and not "needs you",
  // because the tab is already gone.
  let b = seeded()
  b = applyBoardEvent(b, { type: 'payload:progress', platform: 'greenhouse', jobId: '123', state: 'failed', skipped: true, message: 'CAPTCHA — tab closed; not applied' })
  assert.equal(b[KEY].column, 'defect')
  assert.equal(b[KEY].defect, 'skipped')
  assert.equal(b[KEY].detail, 'CAPTCHA — tab closed; not applied')
  b = applyBoardEvent(b, { type: 'payload:progress', platform: 'greenhouse', jobId: '123', state: 'working', phase: 'filling' })
  assert.equal(b[KEY].column, 'defect')
})

test('the cards still waiting on a platform are its To do and Extracted cards', () => {
  const { waitingCards } = require(path.join(__dirname, '..', '..', 'out', 'unit', 'electron', 'board-state.js'))
  let b = seedCards(emptyBoard(), [
    { platform: 'lever', jobId: 'a' }, { platform: 'lever', jobId: 'b' },
    { platform: 'lever', jobId: 'c' }, { platform: 'ashby', jobId: 'd' },
  ])
  b = applyBoardEvent(b, { type: 'extract:job', status: 'extracted', platform: 'lever', jobId: 'b' })
  b = applyBoardEvent(b, { type: 'payload:progress', state: 'working', phase: 'filling', platform: 'lever', jobId: 'c' })
  assert.deepEqual(waitingCards(b, 'lever').map(c => c.jobId).sort(), ['a', 'b'])
  assert.deepEqual(waitingCards(b, 'greenhouse'), [])
})

test('after a run, the cards no agent started are the ones still in To do or Extracted', () => {
  const { cardsNotStarted } = require(path.join(__dirname, '..', '..', 'out', 'unit', 'electron', 'board-state.js'))
  let b = seedCards(emptyBoard(), [
    { platform: 'lever', jobId: 'a' }, { platform: 'ashby', jobId: 'b' }, { platform: 'lever', jobId: 'c' },
  ])
  b = applyBoardEvent(b, { type: 'extract:job', status: 'extracted', platform: 'ashby', jobId: 'b' })
  b = applyBoardEvent(b, { type: 'payload:progress', state: 'done', platform: 'lever', jobId: 'c' })
  assert.deepEqual(cardsNotStarted(b).map(c => c.key).sort(), ['ashby:b', 'lever:a'])
})
