// What an application record's header claims.
//
// Every record opened "Applied: <date>" over "Questions & Answers", whatever
// happened. Seven jobs in one run never loaded a page (navigation timeouts),
// and each record read as an application sent that day, with answers that
// never reached a form.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const { recordHeader } = require('../../out/unit/electron/record-header.js')

test('a submitted application is "Applied"', () => {
  const h = recordHeader('submitted', { filled: [{ id: 'first_name' }], submission: { status: 'submitted' } })
  assert.equal(h.whenLabel, 'Applied')
  assert.equal(h.answersHeading, 'Questions & Answers')
})

test('a page that never loaded says so, and is not "Applied"', () => {
  // The shape the fillers write for a navigation timeout.
  const h = recordHeader('failed', { filled: [], submission: { status: 'nav_failed', reason: 'navigate: Page.goto: Timeout 25000ms exceeded.' } })
  assert.equal(h.whenLabel, 'Attempted')
  assert.match(h.answersHeading, /never entered/)
  assert.match(h.answersHeading, /did not load/)
})

test('a fatal error before any field was entered is "never entered" too', () => {
  const h = recordHeader('failed', { filled: [], submission: { status: 'error' } })
  assert.match(h.answersHeading, /never entered/)
  assert.match(h.answersHeading, /never filled/)
})

test('a failed but partly filled form keeps its answers as answers', () => {
  const h = recordHeader('failed', { filled: [{ id: 'first_name' }], submission: { status: 'validation_errors' } })
  assert.equal(h.whenLabel, 'Attempted')
  assert.equal(h.answersHeading, 'Questions & Answers')
})

test('a lever form filled and then stopped by a CAPTCHA keeps its answers', () => {
  // The real shape: 12 fields entered, then the challenge.
  const h = recordHeader('failed', {
    platform: 'lever', filled: Array.from({ length: 12 }, (_, i) => ({ id: `f${i}` })),
    submission: { status: 'blocked_captcha_puzzle' }, tab_left_open: true,
  })
  assert.equal(h.whenLabel, 'Attempted')
  assert.equal(h.answersHeading, 'Questions & Answers')
})

test('a result without a filled list makes no claim', () => {
  const h = recordHeader('failed', { submission: { status: 'error' } })
  assert.equal(h.answersHeading, 'Questions & Answers')
})

test('no result file makes no claim about what was entered', () => {
  const h = recordHeader('failed', null)
  assert.equal(h.whenLabel, 'Attempted')
  assert.equal(h.answersHeading, 'Questions & Answers')
})
