// The extractors disagree on option shape: greenhouse and ashby emit
// {text, value}, lever emits plain strings. payload-builder read `.text`
// unconditionally, so on every lever posting the option list came out empty —
// validateDropdownAnswers then found no match for ANY dropdown answer and
// blanked them all, and none of the EEO/visa/clearance fallbacks could match.
// The model had answered correctly; only this file lost it.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs')
const Module = require('module')

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-builder-test-'))
const origLoad = Module._load
Module._load = function (request) {
  if (request.endsWith('state-store')) {
    return { __esModule: true, default: { get: k => (k === 'jobAutomatorHome' ? HOME : ''), set: () => {} } }
  }
  return origLoad.apply(this, arguments)
}
const { buildAndWritePayload } = require('../../out/unit/electron/payload-builder.js')

const PROFILE = {
  visaSituation: 'authorized', sponsorshipNeed: 'no-sponsorship', clearance: 'no-ineligible',
  eeoGender: 'Female', eeoRace: 'Hispanic or Latino',
  eeoVeteran: 'I am not a protected veteran',
  eeoDisability: 'No, I do not have a disability and have not had one in the past',
}

// Real wording, taken from a live Lever posting — strings, not objects.
const LEVER_STRING_OPTIONS = [
  'Select ...',
  'I identify as one or more of the classifications of protected veteran listed above',
  'I am not a protected veteran',
  'I decline to self-identify for protected veteran status',
]

function job(fields) {
  return {
    application_id: 0, job_id: 'j1', platform: 'lever', company_slug: 'acme',
    job_title: 'Engineer', apply_url: 'https://x/y', claim_token: '',
    extracted_fields: { fields },
  }
}

test('a lever string-option answer that IS on the list survives', async () => {
  const fields = [{ id: 'eeo[veteran]', type: 'dropdown', required: false,
                    label: 'eeo[veteran]', options: LEVER_STRING_OPTIONS }]
  const built = await buildAndWritePayload(job(fields),
    { 'eeo[veteran]': 'I am not a protected veteran' }, PROFILE)
  assert.equal(built.answers['eeo[veteran]'], 'I am not a protected veteran',
    'this exact string is in the options list and was being dropped as "off-list"')
})

test('the same answer still survives in the {text,value} shape', async () => {
  const fields = [{ id: 'eeo[veteran]', type: 'dropdown', required: false, label: 'eeo[veteran]',
                    options: LEVER_STRING_OPTIONS.map(t => ({ text: t, value: t })) }]
  const built = await buildAndWritePayload(job(fields),
    { 'eeo[veteran]': 'I am not a protected veteran' }, PROFILE)
  assert.equal(built.answers['eeo[veteran]'], 'I am not a protected veteran')
})

test('an off-list answer is still repaired to a unique containment match', async () => {
  const fields = [{ id: 'discipline', type: 'dropdown', required: false, label: 'Discipline',
                    options: ['Computer Science', 'Engineering', 'Mathematics'] }]
  const built = await buildAndWritePayload(job(fields), { discipline: 'Software Engineering' }, PROFILE)
  assert.equal(built.answers['discipline'], 'Engineering',
    'the repair path must keep working for string options too')
})

test('an off-list answer with no match is still blanked', async () => {
  const fields = [{ id: 'discipline', type: 'dropdown', required: false, label: 'Discipline',
                    options: ['Biology', 'Chemistry'] }]
  const built = await buildAndWritePayload(job(fields), { discipline: 'Astrophysics' }, PROFILE)
  assert.equal(built.answers['discipline'], '', 'unfillable answers must not reach the filler')
})

test('EEO injection matches string options', async () => {
  const fields = [{ id: 'eeo[disability]', type: 'dropdown', required: false,
                    label: 'Disability Status',
                    options: ['Yes, I have a disability, or have had one in the past',
                              'No, I do not have a disability and have not had one in the past',
                              'I do not want to answer'] }]
  const built = await buildAndWritePayload(job(fields), {}, PROFILE)
  assert.equal(built.answers['eeo[disability]'],
    'No, I do not have a disability and have not had one in the past',
    'the profile fallback could never match a string option before')
})

test('sponsorship fallback matches string options', async () => {
  const fields = [{ id: 'sponsor', type: 'dropdown', required: true,
                    label: 'Will you now or in the future require sponsorship for employment visa status?',
                    options: ['Yes', 'No'] }]
  const built = await buildAndWritePayload(job(fields), {}, PROFILE)
  assert.equal(built.answers['sponsor'], 'No',
    'no-sponsorship profile -> No; this injection was dead for every lever posting')
})

test('work-authorization fallback matches string options', async () => {
  const fields = [{ id: 'authorized', type: 'dropdown', required: true,
                    label: 'Are you legally authorized to work in the country for which you are applying?',
                    options: ['Yes', 'No'] }]
  const built = await buildAndWritePayload(job(fields), {}, PROFILE)
  assert.equal(built.answers['authorized'], 'Yes')
})

test('truncated typeahead answers are never blanked, either shape', async () => {
  const fields = [{ id: 'school', type: 'dropdown', required: true, label: 'School',
                    options: ['Aalborg University', 'Aalto University'], options_truncated: true }]
  const built = await buildAndWritePayload(job(fields), { school: 'Northbridge University' }, PROFILE)
  assert.equal(built.answers['school'], 'Northbridge University')
})
