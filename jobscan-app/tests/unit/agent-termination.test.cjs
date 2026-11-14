// When an agent may stop asking for work.
//
// This is the one decision in the board work that strands a whole run if it is
// wrong. Get it too eager and agents quit while extraction is still feeding the
// queue, leaving extracted jobs that nobody ever applies to. Get it too patient
// and they poll forever after the last job, and the run never finishes.
//
// The rule is therefore extracted from the agent loop so it can be tested
// without a pipeline, a database, or a browser.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { shouldAgentExit } = require(
  path.join(__dirname, '..', '..', 'out', 'unit', 'electron', 'agent-loop.js'))

test('work in hand is always processed, whatever else is true', () => {
  for (const extractionComplete of [true, false]) {
    for (const canceled of [true, false]) {
      assert.equal(
        shouldAgentExit({ claimedCount: 1, extractionComplete, canceled }),
        canceled,
        `claimed work with extractionComplete=${extractionComplete} canceled=${canceled}`)
    }
  }
})

test('an empty queue is NOT a reason to stop while extraction is still running', () => {
  // The old loop broke here. With extraction and the agents now concurrent,
  // an empty queue usually just means the extractor has not caught up yet.
  assert.equal(
    shouldAgentExit({ claimedCount: 0, extractionComplete: false, canceled: false }),
    false)
})

test('an empty queue after extraction has finished is the end', () => {
  assert.equal(
    shouldAgentExit({ claimedCount: 0, extractionComplete: true, canceled: false }),
    true)
})

test('cancellation stops an agent immediately', () => {
  for (const claimedCount of [0, 1]) {
    for (const extractionComplete of [true, false]) {
      assert.equal(
        shouldAgentExit({ claimedCount, extractionComplete, canceled: true }),
        true, `canceled with claimedCount=${claimedCount}`)
    }
  }
})

test('extraction that failed still releases the agents', () => {
  // extractionComplete is set in a finally, so a thrown extraction reaches
  // here as true. If it did not, every agent would poll forever and the run
  // would hang with no error surfaced.
  assert.equal(
    shouldAgentExit({ claimedCount: 0, extractionComplete: true, canceled: false }),
    true)
})

test('a queue that empties and refills does not lose the agents', () => {
  // The realistic race: extractor pauses between platforms, agents drain the
  // queue, then more jobs arrive.
  const steps = [
    { claimedCount: 1, extractionComplete: false },  // working
    { claimedCount: 0, extractionComplete: false },  // gap — must NOT exit
    { claimedCount: 0, extractionComplete: false },  // still waiting
    { claimedCount: 1, extractionComplete: false },  // refilled
    { claimedCount: 0, extractionComplete: true },   // genuinely done
  ]
  const exits = steps.map(s => shouldAgentExit({ ...s, canceled: false }))
  assert.deepEqual(exits, [false, false, false, false, true])
})

test('an extraction that produced zero jobs terminates rather than hanging', () => {
  assert.equal(
    shouldAgentExit({ claimedCount: 0, extractionComplete: true, canceled: false }),
    true)
})

test('missing fields default to not exiting, except when canceled', () => {
  // Defensive: an undefined flag must not be read as "extraction finished",
  // which would drain the pool early and silently skip jobs.
  assert.equal(shouldAgentExit({}), false)
  assert.equal(shouldAgentExit({ canceled: true }), true)
})
