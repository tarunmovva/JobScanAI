// "Finish it" has to raise the tab the application was FILLED in. Opening the
// apply URL again hands the user a blank form and throws away every answer —
// which is the whole thing the left-open tab exists to preserve.
//
// The matching is the hard part: by the time the user clicks, the tab has moved
// on. Query strings get rewritten, greenhouse redirects boards.greenhouse.io to
// job-boards.greenhouse.io, and the same posting also appears on the company's
// own careers domain with nothing but ?gh_jid=. An exact URL comparison finds
// nothing.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')

const { __testing } = require('../../out/unit/electron/chrome-tabs.js')
const { identity } = __testing

const same = (a, b) => identity(a) === identity(b)

test('greenhouse: the same posting matches across all three URL shapes', () => {
  const canonical = 'https://job-boards.greenhouse.io/contoso/jobs/4000000003'
  assert.ok(same('https://boards.greenhouse.io/contoso/jobs/4000000003?gh_jid=4000000003', canonical),
    'boards.greenhouse.io 301-redirects to job-boards and drops the query')
  assert.ok(same('https://careers.example.com/job/?gh_jid=4000000003',
                 'https://job-boards.greenhouse.io/fabrikam/jobs/4000000003'),
    'a company careers domain carries only gh_jid — 20% of greenhouse postings')
})

test('greenhouse: an embedded application form identifies its own posting', () => {
  // Every embed shares the same path, /embed/job_app; without the token they
  // would all look like one job, and closing one job's tabs would close them all.
  assert.ok(same('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1234567',
                 'https://www.acme.example.com/jobs/1234567?gh_jid=1234567'))
  assert.ok(!same('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1234567',
                  'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=4444444'))
})

test('lever and ashby: the apply/application suffix is not identity', () => {
  assert.ok(same('https://jobs.lever.co/acme/abc/apply', 'https://jobs.lever.co/acme/abc'))
  assert.ok(same('https://jobs.ashbyhq.com/openai/xyz/application', 'https://jobs.ashbyhq.com/openai/xyz'))
})

test('different postings never collide', () => {
  assert.ok(!same('https://job-boards.greenhouse.io/x/jobs/111', 'https://job-boards.greenhouse.io/x/jobs/222'))
  assert.ok(!same('https://jobs.lever.co/a/1/apply', 'https://jobs.lever.co/a/2/apply'))
  assert.ok(!same('https://jobs.ashbyhq.com/a/1/application', 'https://jobs.ashbyhq.com/b/1/application'))
})

test('a gh_jid on a non-greenhouse host still identifies the posting', () => {
  assert.equal(identity('https://careers.acme.com/openings?gh_jid=42'), 'gh:42')
})

test('trailing slashes and case do not split a match', () => {
  assert.ok(same('https://jobs.lever.co/Acme/abc/apply/', 'https://jobs.lever.co/acme/abc'))
})

test('a malformed url degrades instead of throwing', () => {
  assert.doesNotThrow(() => identity('not a url at all'))
  assert.equal(identity('not a url at all'), 'not a url at all')
})
