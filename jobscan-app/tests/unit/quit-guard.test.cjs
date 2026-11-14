// Quitting while a manual run is in progress asks first.
//
// The run's fillers used to outlive the app: on Windows and macOS alike they
// kept filling -- and could submit -- with no app left to record what they
// did. Loop rounds were already stopped on quit; manual runs now ask, once,
// whether to stop the run and quit or keep the app open.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuitGuard } = require('../../out/unit/electron/quit-guard.js')

function guard({ running = true, looping = false, answers = [] } = {}) {
  const asked = []
  const g = createQuitGuard({
    runActive: () => running,
    looping: () => looping,
    ask: async () => { asked.push(true); return answers.shift() ?? 'stay' },
  })
  return { g, asked }
}

test('with nothing running, quitting goes ahead without asking', async () => {
  const { g, asked } = guard({ running: false })
  assert.equal(await g.mayQuit(), true)
  assert.equal(asked.length, 0)
})

test('loop rounds are stopped on quit as before, without asking', async () => {
  const { g, asked } = guard({ looping: true })
  assert.equal(await g.mayQuit(), true)
  assert.equal(asked.length, 0)
})

test('a manual run asks; "keep the app open" keeps it, and the next quit asks again', async () => {
  const { g, asked } = guard({ answers: ['stay', 'stop'] })
  assert.equal(await g.mayQuit(), false)
  assert.equal(g.confirmed, false)
  assert.equal(await g.mayQuit(), true)
  assert.equal(asked.length, 2)
  assert.equal(g.confirmed, true)
})

test('once you chose to stop and quit, nothing asks again', async () => {
  const { g, asked } = guard({ answers: ['stop'] })
  assert.equal(await g.mayQuit(), true)
  assert.equal(await g.mayQuit(), true)
  assert.equal(asked.length, 1)
})

test('the window closing and the app quitting at once show one question', async () => {
  // Windows: closing the last window quits the app, and both ask.
  const { g, asked } = guard({ answers: ['stop'] })
  const [a, b] = await Promise.all([g.mayQuit(), g.mayQuit()])
  assert.deepEqual([a, b], [true, true])
  assert.equal(asked.length, 1)
})

test('a terminal Ctrl+C quits without asking', async () => {
  const { g, asked } = guard()
  g.skipAsking()
  assert.equal(await g.mayQuit(), true)
  assert.equal(asked.length, 0)
})
