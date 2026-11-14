// Off-list dropdown answers, and the "Other" escape hatch.
//
// A live run failed on a "College Name" dropdown: about a hundred colleges, the last one
// "Others", and the next field asking for the college's name when "Others"
// was chosen. The payload answered "Ridgeview
// Institute of Technology", which is not an option. The extractor had wrongly
// flagged the list as a truncated typeahead, so the guard that keeps answers on
// the list skipped it.
//
// That is fixed in the extractor. These tests pin the guard itself, which had a
// second gap: even when it ran, its only remedy for an off-list answer was to
// blank it -- and a blank required field fails the application just the same.
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
const { validateDropdownAnswers, isGenericOther } = require('../../out/unit/electron/payload-builder.js')
Module._load = origLoad

const college = (extra = {}) => [
  { id: 'college', type: 'dropdown', label: 'College Name',
    options: [{ text: 'Northfield College' }, { text: 'Eastport University' }, { text: 'Others' }], ...extra },
  { id: 'college_other', type: 'text',
    label: "If you chose 'Others' above, please enter the name of your college." },
]

test('an off-list name becomes "Others", with the real name carried to the follow-up', () => {
  const answers = { college: 'Ridgeview Institute of Technology', college_other: '' }
  validateDropdownAnswers(college(), answers)
  assert.equal(answers.college, 'Others')
  assert.equal(answers.college_other, 'Ridgeview Institute of Technology')
})

test('a follow-up the model already filled is not overwritten', () => {
  const answers = { college: 'Ridgeview Institute of Technology', college_other: 'Ridgeview Tech, Springfield' }
  validateDropdownAnswers(college(), answers)
  assert.equal(answers.college, 'Others')
  assert.equal(answers.college_other, 'Ridgeview Tech, Springfield')
})

test('the value only travels to a field that asks for it', () => {
  // The next field being any text box is not enough -- it must be the one
  // that exists to hold the "Other" answer.
  const fields = [
    { id: 'college', type: 'dropdown', options: [{ text: 'Eastport University' }, { text: 'Others' }] },
    { id: 'linkedin', type: 'text', label: 'LinkedIn profile' },
  ]
  const answers = { college: 'Ridgeview Institute of Technology', linkedin: '' }
  validateDropdownAnswers(fields, answers)
  assert.equal(answers.college, 'Others')
  assert.equal(answers.linkedin, '', 'must not write a college name into LinkedIn')
})

test('an ethnicity like "Other Asian" is never treated as an escape hatch', () => {
  // Treating it as one would silently assert an identity the candidate did
  // not state.
  assert.equal(isGenericOther('Other Asian'), false)
  assert.equal(isGenericOther('Other Hispanic'), false)
  assert.equal(isGenericOther('Others'), true)
  assert.equal(isGenericOther('Other'), true)
  assert.equal(isGenericOther('Other (please specify)'), true)
  assert.equal(isGenericOther('Other - please specify'), true)
  const fields = [{ id: 'race', type: 'dropdown',
    options: [{ text: 'Native Hawaiian' }, { text: 'Other Asian' }, { text: 'White' }] }]
  const answers = { race: 'Martian' }
  validateDropdownAnswers(fields, answers)
  assert.equal(answers.race, '', 'no generic Other exists, so it is blanked rather than guessed')
})

test('a unique near-match is still repaired, not sent to Other', () => {
  const fields = [{ id: 'school', type: 'dropdown',
    options: [{ text: 'Northbridge University - Main Campus' }, { text: 'Others' }] }]
  const answers = { school: 'Northbridge University' }
  validateDropdownAnswers(fields, answers)
  assert.equal(answers.school, 'Northbridge University - Main Campus')
})

test('with no Other option an off-list answer is blanked, not guessed', () => {
  const fields = [{ id: 'college', type: 'dropdown', options: [{ text: 'Northfield College' }, { text: 'Eastport University' }] }]
  const answers = { college: 'Ridgeview Institute of Technology' }
  validateDropdownAnswers(fields, answers)
  assert.equal(answers.college, '')
})

test('a truncated typeahead list is left alone', () => {
  // An answer missing from a sample is not missing from the list.
  const answers = { college: 'Ridgeview Institute of Technology', college_other: '' }
  validateDropdownAnswers(college({ options_truncated: true }), answers)
  assert.equal(answers.college, 'Ridgeview Institute of Technology')
  assert.equal(answers.college_other, '')
})

test('an answer already on the list is untouched', () => {
  const answers = { college: 'Eastport University', college_other: '' }
  validateDropdownAnswers(college(), answers)
  assert.equal(answers.college, 'Eastport University')
  assert.equal(answers.college_other, '')
})
