// History records link to the files that were actually sent. The path round-
// trips through the renderer, so it is untrusted on return and re-checked in
// the main process before anything opens.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { isOpenableRecordFile } = require(
  path.join(__dirname, '..', '..', 'out', 'unit', 'electron', 'record-files.js'))

const HOME = path.resolve('/work/jobscan/.job-automator')
const RESUME = path.resolve('/home/user/Downloads/resume.pdf')

test('a generated cover letter inside the home is openable', () => {
  const target = path.join(HOME, 'applications', 'greenhouse', '123', 'cover_letter.pdf')
  assert.ok(isOpenableRecordFile(HOME, RESUME, target))
})

test('the configured resume is openable even though it sits outside the home', () => {
  assert.ok(isOpenableRecordFile(HOME, RESUME, RESUME))
})

test('a sibling of the resume is NOT openable', () => {
  // Allowing the resume's directory would open the whole Downloads folder.
  const sibling = path.join('D:', 'Downloads', 'tax-return.pdf')
  assert.ok(!isOpenableRecordFile(HOME, RESUME, sibling))
})

test('traversal out of the home is rejected', () => {
  const escape = path.join(HOME, '..', '..', '..', 'Windows', 'System32', 'config', 'SAM')
  assert.ok(!isOpenableRecordFile(HOME, RESUME, escape))
})

test('a path that merely shares a prefix with the home is rejected', () => {
  // "...\.job-automator-evil" must not pass a startsWith check.
  assert.ok(!isOpenableRecordFile(HOME, RESUME, HOME + '-evil' + path.sep + 'x.pdf'))
})

test('empty and missing inputs are rejected', () => {
  assert.ok(!isOpenableRecordFile(HOME, RESUME, ''))
  assert.ok(!isOpenableRecordFile(HOME, RESUME, '   '))
  assert.ok(!isOpenableRecordFile('', '', path.join(HOME, 'x.pdf')))
})

test('with no resume configured, nothing outside the home is openable', () => {
  assert.ok(!isOpenableRecordFile(HOME, '', RESUME))
})

test('the home directory itself is allowed, its parent is not', () => {
  assert.ok(isOpenableRecordFile(HOME, RESUME, HOME))
  assert.ok(!isOpenableRecordFile(HOME, RESUME, path.dirname(HOME)))
})
