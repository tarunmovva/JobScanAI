// What keeps a test run off the user's real browser and Codex account.
//
// The user's own automation Chrome listens on 9222 with their real profile,
// and ~/.codex holds their real Codex sign-in. A test sets
// JOB_AUTOMATOR_CDP_PORT / JOB_AUTOMATOR_CHROME_USER_DATA_DIR / CODEX_HOME to
// scratch values; unset, every default must be exactly what it was before.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')

const unit = path.join(__dirname, '..', '..', 'out', 'unit', 'electron')
const { cdpPort, cdpHost, cdpVersionUrl, chromeProfileDir, chromeLaunchArgs } = require(path.join(unit, 'cdp.js'))
const { codexHome, e2eCodexCommand, E2E_NO_CODEX } = require(path.join(unit, 'codex-home.js'))

test('with nothing set, Chrome is started exactly as before', () => {
  const home = path.join(os.tmpdir(), 'automation-home')
  assert.equal(cdpPort({}), '9222')
  assert.equal(cdpHost({}), '127.0.0.1')
  assert.equal(cdpVersionUrl({}), 'http://127.0.0.1:9222/json/version')
  assert.deepEqual(chromeLaunchArgs(home, {}), [
    '--remote-debugging-port=9222',
    `--user-data-dir=${path.join(home, 'chrome-cdp-profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
  ])
})

test('a test run gets its own port and its own Chrome profile', () => {
  const scratch = path.join(os.tmpdir(), 'jobscan-e2e', 'chrome')
  const env = { JOB_AUTOMATOR_CDP_PORT: '9223', JOB_AUTOMATOR_CHROME_USER_DATA_DIR: scratch }
  assert.equal(cdpVersionUrl(env), 'http://127.0.0.1:9223/json/version')
  assert.equal(chromeProfileDir('ignored', env), path.resolve(scratch))
  assert.equal(chromeLaunchArgs('ignored', env)[0], '--remote-debugging-port=9223')
  assert.equal(chromeLaunchArgs('ignored', env)[1], `--user-data-dir=${path.resolve(scratch)}`)
})

test('blank values count as unset', () => {
  assert.equal(cdpPort({ JOB_AUTOMATOR_CDP_PORT: '  ' }), '9222')
  assert.equal(codexHome({ CODEX_HOME: '' }), path.join(os.homedir(), '.codex'))
})

test('the Codex folder follows CODEX_HOME, as Codex itself does', () => {
  assert.equal(codexHome({}), path.join(os.homedir(), '.codex'))
  const scratch = path.join(os.tmpdir(), 'codex-home')
  assert.equal(codexHome({ CODEX_HOME: scratch }), path.resolve(scratch))
})

test('outside tests the Codex stand-in is ignored', () => {
  assert.equal(e2eCodexCommand({ JOBSCAN_E2E_CODEX_COMMAND: '{"command":"node","args":["x.cjs"]}' }), null)
})

test('under E2E_TEST, Codex runs only as the named stand-in, and otherwise cannot start', () => {
  assert.deepEqual(
    e2eCodexCommand({ E2E_TEST: '1', JOBSCAN_E2E_CODEX_COMMAND: '{"command":"node","args":["fake.cjs"]}' }),
    { command: 'node', args: ['fake.cjs'] })
  for (const raw of [undefined, '', 'not json', '{"args":["x"]}']) {
    assert.deepEqual(e2eCodexCommand({ E2E_TEST: '1', JOBSCAN_E2E_CODEX_COMMAND: raw }),
      { command: E2E_NO_CODEX, args: [] }, String(raw))
  }
})
