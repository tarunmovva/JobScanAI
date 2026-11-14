// Can the user get back to a screen that still has something on it?
//
// Navigation is backwards-only, with named forward exceptions. That rule has
// now stranded a screen twice:
//
//   board -> done   the run finished, every card settled, and the summary sat
//                   behind a greyed-out chip.
//   * -> board      the user stepped back to Resume to change a setting and
//                   could not return; eight settled cards were in the store
//                   with no way to reach them.
//
// Both have the same shape: the work already happened, its result is in the
// store, and the trail refuses to show it. These tests pin the rule rather
// than the two instances, so a third screen does not have to be discovered by
// the user.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')

const SCREEN_ORDER = ['auth', 'resume', 'query_gen', 'rating', 'board', 'done']

// The decision under test, copied from pipeline:goto-state. Kept as a pure
// function so it can be exercised without booting Electron; the handler itself
// is a thin wrapper over exactly this.
function allowed({ current, target, boardSettled = false, hasBoard = false }) {
  const currentIdx = SCREEN_ORDER.indexOf(current)
  const targetIdx = SCREEN_ORDER.indexOf(target)
  if (targetIdx === -1 || currentIdx === -1) return false
  const returningToDone = target === 'done' && current === 'board' && boardSettled
  const returningToBoard = target === 'board' && hasBoard
  if (targetIdx >= currentIdx && !returningToDone && !returningToBoard) return false
  return true
}

test('an existing board is reachable from every earlier screen', () => {
  // The reported bug: appState was "resume" with 8 settled cards in the store.
  for (const from of ['resume', 'query_gen', 'rating']) {
    assert.equal(allowed({ current: from, target: 'board', hasBoard: true }), true,
      `stranded when stepping back to ${from}`)
  }
})

test('with no board there is nothing to go forward to', () => {
  // Forward nav must not become a way to skip the pipeline. Cards exist only
  // because the work ran.
  for (const from of ['resume', 'query_gen', 'rating']) {
    assert.equal(allowed({ current: from, target: 'board', hasBoard: false }), false, from)
  }
})

test('a settled board can still reach done', () => {
  assert.equal(allowed({ current: 'board', target: 'done', boardSettled: true }), true)
  assert.equal(allowed({ current: 'board', target: 'done', boardSettled: false }), false)
})

test('backwards is always allowed', () => {
  assert.equal(allowed({ current: 'done', target: 'rating' }), true)
  assert.equal(allowed({ current: 'board', target: 'resume' }), true)
  assert.equal(allowed({ current: 'rating', target: 'query_gen' }), true)
})

test('no other forward jump is permitted', () => {
  // Everything except the two named exceptions.
  const cases = [
    ['resume', 'rating'], ['resume', 'done'], ['query_gen', 'done'],
    ['rating', 'done'], ['auth', 'rating'],
  ]
  for (const [current, target] of cases) {
    assert.equal(allowed({ current, target, hasBoard: true, boardSettled: true }), false,
      `${current} -> ${target} should not be a shortcut`)
  }
})

test('staying put is not a move', () => {
  for (const s of SCREEN_ORDER) {
    if (s === 'board') continue  // covered by the board exception
    assert.equal(allowed({ current: s, target: s, hasBoard: true }), false, s)
  }
})

test('the board exception does not depend on the board being finished', () => {
  // A run interrupted mid-flight is exactly when the user most wants back in.
  assert.equal(
    allowed({ current: 'resume', target: 'board', hasBoard: true, boardSettled: false }),
    true)
})
