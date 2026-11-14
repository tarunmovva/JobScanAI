// A sponsorship question is answered from the profile, not by the model.
//
// One run, one candidate: five postings got the profile's answer and two got
// the opposite one -- one of them was submitted. The profile only filled the
// field when the model left it blank, so the model's answer won. The labels
// below are the wording of two real questions.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')

const origLoad = Module._load
Module._load = function (request) {
  if (request.endsWith('state-store')) return { __esModule: true, default: { get: () => '', set: () => {} } }
  return origLoad.apply(this, arguments)
}
const { enforceSponsorshipNeed } = require('../../out/unit/electron/payload-builder.js')
Module._load = origLoad

const YES_NO = [{ text: 'Yes' }, { text: 'No' }]
const field = (id, label, options = YES_NO, type = 'dropdown') => ({ id, label, options, type })

test('the two real mis-answered questions are answered from the profile', () => {
  const fields = [
    field('q1', 'Will you now or in the future require employment sponsorship?'),
    field('q2', 'Do you now, or will you in the future, require immigration sponsorship to work at the company?'),
  ]
  const answers = { q1: 'Yes', q2: 'Yes' }
  enforceSponsorshipNeed(fields, answers, 'no-sponsorship')
  assert.deepEqual(answers, { q1: 'No', q2: 'No' })
})

test('a candidate who needs sponsorship says so', () => {
  const fields = [field('q', 'Do you currently require sponsorship to work in the US?')]
  const answers = { q: 'No' }
  enforceSponsorshipNeed(fields, answers, 'need-sponsorship')
  assert.equal(answers.q, 'Yes')
})

test('the inverted "authorized WITHOUT sponsorship" question is never touched', () => {
  // Here "No" would mean "I am not authorized" -- the opposite of the profile.
  const fields = [
    field('a', 'Are you authorized to work in the U.S. without the need for current or future visa sponsorship?'),
    field('b', 'Are you legally authorized to work in Singapore WITHOUT sponsorship or an employment pass?'),
  ]
  const answers = { a: 'Yes', b: 'Yes' }
  enforceSponsorshipNeed(fields, answers, 'no-sponsorship')
  assert.deepEqual(answers, { a: 'Yes', b: 'Yes' })
})

test('a label asking two questions at once is left to the model', () => {
  const fields = [field('q', 'Are you eligible to work in the United States? Do you now or in the future require visa sponsorship?')]
  const answers = { q: 'Yes' }
  enforceSponsorshipNeed(fields, answers, 'no-sponsorship')
  assert.equal(answers.q, 'Yes')
})

test('"may need it in the future" stays with the model, which reads now vs future', () => {
  const fields = [field('q', 'Do you currently require sponsorship?')]
  const answers = { q: 'No' }
  enforceSponsorshipNeed(fields, answers, 'future-sponsorship')
  assert.equal(answers.q, 'No')
})

test('long option texts are matched by their leading yes/no', () => {
  const opts = [{ text: 'Yes, I will require sponsorship' }, { text: 'No, I do not require sponsorship' }]
  const fields = [field('q', 'Will you require visa sponsorship now or in the future?', opts, 'radio')]
  const answers = { q: 'Yes, I will require sponsorship' }
  enforceSponsorshipNeed(fields, answers, 'no-sponsorship')
  assert.equal(answers.q, 'No, I do not require sponsorship')
})

test('no profile answer, no change', () => {
  const fields = [field('q', 'Will you now or in the future require employment sponsorship?')]
  const answers = { q: 'Yes' }
  enforceSponsorshipNeed(fields, answers, '')
  assert.equal(answers.q, 'Yes')
})
