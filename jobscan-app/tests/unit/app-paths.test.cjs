// Where the app finds the jobscan CLI, the Python automator and Python itself.
//
// The defaults used to be one fixed checkout path (F:\asbylevergreenhouse\
// jobscan\jobscan.exe), so any other clone -- and every Mac -- started with
// paths that did not exist. They now come from wherever this checkout is.
// Both platforms are pinned here: this is the only macOS coverage a Windows
// machine can give.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  findRepoRoot, defaultPaths, planPathFixes, resolvePython, formerDefaults,
} = require('../../out/unit/electron/app-paths.js')

const existing = (...paths) => {
  const set = new Set(paths)
  return p => set.has(p)
}

test('the repo root is the first directory up that holds jobscan/go.mod', () => {
  const W = path.win32
  const exists = existing(W.join('C:\\code\\jobscan-ai', 'jobscan', 'go.mod'))
  assert.equal(findRepoRoot('win32', 'C:\\code\\jobscan-ai\\jobscan-app\\out\\main', exists), 'C:\\code\\jobscan-ai')
  assert.equal(findRepoRoot('win32', 'C:\\elsewhere\\app', exists), null)
  const P = path.posix
  const mac = existing(P.join('/Users/sam/src/jobscan-ai', 'jobscan', 'go.mod'))
  assert.equal(findRepoRoot('darwin', '/Users/sam/src/jobscan-ai/jobscan-app/out/main', mac), '/Users/sam/src/jobscan-ai')
})

test('a Windows checkout uses its own jobscan.exe, automator and home', () => {
  const exists = existing('C:\\code\\jobscan-ai\\jobscan\\go.mod')
  assert.deepEqual(defaultPaths({ platform: 'win32', startDir: 'C:\\code\\jobscan-ai\\jobscan-app\\out\\main', exists, homedir: 'C:\\Users\\sam' }), {
    jobscanExePath: 'C:\\code\\jobscan-ai\\jobscan\\jobscan.exe',
    pythonDir: 'C:\\code\\jobscan-ai\\jobscan',
    jobAutomatorHome: 'C:\\code\\jobscan-ai\\jobscan\\.job-automator',
  })
})

test('a Mac checkout uses its own jobscan binary, with no .exe', () => {
  const exists = existing('/Users/sam/src/jobscan-ai/jobscan/go.mod')
  assert.deepEqual(defaultPaths({ platform: 'darwin', startDir: '/Users/sam/src/jobscan-ai/jobscan-app/out/main', exists, homedir: '/Users/sam' }), {
    jobscanExePath: '/Users/sam/src/jobscan-ai/jobscan/jobscan',
    pythonDir: '/Users/sam/src/jobscan-ai/jobscan',
    jobAutomatorHome: '/Users/sam/src/jobscan-ai/jobscan/.job-automator',
  })
})

test('outside a checkout the defaults fall back to the home directory, never a drive letter', () => {
  const d = defaultPaths({ platform: 'darwin', startDir: '/Applications/JobScan.app/Contents/Resources', exists: () => false, homedir: '/Users/sam' })
  assert.equal(d.jobscanExePath, '/Users/sam/jobscan/jobscan')
  for (const v of Object.values(d)) assert.equal(v.includes('F:'), false)
})

test('Python: the checkout venv once setup finished it, else the platform default name', () => {
  const winVenv = 'C:\\code\\jobscan-ai\\jobscan\\.venv\\Scripts\\python.exe'
  const winStamp = 'C:\\code\\jobscan-ai\\jobscan\\.venv\\.jobscan-requirements.sha256'
  assert.equal(resolvePython('win32', 'C:\\code\\jobscan-ai\\jobscan', existing(winVenv, winStamp)), winVenv)
  // A venv whose packages never finished installing would fail every fill on `import playwright`.
  assert.equal(resolvePython('win32', 'C:\\code\\jobscan-ai\\jobscan', existing(winVenv)), 'python')
  assert.equal(resolvePython('win32', 'C:\\code\\jobscan-ai\\jobscan', () => false), 'python')
  const macVenv = '/Users/sam/src/jobscan-ai/jobscan/.venv/bin/python3'
  const macStamp = '/Users/sam/src/jobscan-ai/jobscan/.venv/.jobscan-requirements.sha256'
  assert.equal(resolvePython('darwin', '/Users/sam/src/jobscan-ai/jobscan', existing(macVenv, macStamp)), macVenv)
  // A Mac has no `python` command at all.
  assert.equal(resolvePython('darwin', '/Users/sam/src/jobscan-ai/jobscan', () => false), 'python3')
})

const NEW = {
  jobscanExePath: 'C:\\code\\jobscan-ai\\jobscan\\jobscan.exe',
  pythonDir: 'C:\\code\\jobscan-ai\\jobscan',
  jobAutomatorHome: 'C:\\code\\jobscan-ai\\jobscan\\.job-automator',
}

const onlyNew = p => Object.values(NEW).includes(p)

test('an old built-in default that does not exist on this machine is replaced', () => {
  const former = formerDefaults('win32', 'C:\\Users\\sam')
  const plan = planPathFixes({
    stored: { jobscanExePath: 'F:\\asbylevergreenhouse\\jobscan\\jobscan.exe', pythonDir: 'F:\\asbylevergreenhouse\\jobscan', jobAutomatorHome: 'F:\\asbylevergreenhouse\\jobscan\\.job-automator' },
    auto: {}, defaults: NEW, former, exists: onlyNew,
  })
  assert.deepEqual(plan.set, NEW)
  assert.deepEqual(plan.auto, NEW)
})

test('an old built-in default that DOES exist is kept: that checkout is really there', () => {
  const stored = { jobscanExePath: 'F:\\asbylevergreenhouse\\jobscan\\jobscan.exe', pythonDir: 'F:\\asbylevergreenhouse\\jobscan', jobAutomatorHome: 'F:\\asbylevergreenhouse\\jobscan\\.job-automator' }
  const plan = planPathFixes({ stored, auto: {}, defaults: NEW, former: formerDefaults('win32', 'C:\\Users\\sam'), exists: () => true })
  assert.deepEqual(plan.set, {})
})

test('a path you chose in Settings is never replaced, even when it is missing', () => {
  // jobAutomatorHome holds the OTP and IMAP secrets: an unplugged drive must not move it.
  const stored = { ...NEW, jobAutomatorHome: 'E:\\secrets\\automator' }
  const plan = planPathFixes({ stored, auto: { ...NEW }, defaults: NEW, former: formerDefaults('win32', 'C:\\Users\\sam'), exists: () => false })
  assert.deepEqual(plan.set, {})
})

test('a default this app filled in follows the checkout when it moves', () => {
  const old = { jobscanExePath: 'C:\\old\\jobscan\\jobscan.exe', pythonDir: 'C:\\old\\jobscan', jobAutomatorHome: 'C:\\old\\jobscan\\.job-automator' }
  const plan = planPathFixes({ stored: old, auto: old, defaults: NEW, former: [], exists: onlyNew })
  assert.deepEqual(plan.set, NEW)
  assert.deepEqual(plan.auto, NEW)
})

test('a missing path is never pointed at a default that is missing too', () => {
  // Found in review: the drive holding the checkout and its secrets is
  // unplugged, and the app starts from somewhere else. Pointing the home at
  // a directory that does not exist would strand the OTP and IMAP secrets
  // -- and stick once that directory is created.
  const old = { jobscanExePath: 'F:\\work\\jobscan\\jobscan.exe', pythonDir: 'F:\\work\\jobscan', jobAutomatorHome: 'F:\\work\\jobscan\\.job-automator' }
  const plan = planPathFixes({ stored: old, auto: old, defaults: NEW, former: [], exists: () => false })
  assert.deepEqual(plan.set, {})
})

test('a value equal to the default is remembered as filled in by the app', () => {
  const plan = planPathFixes({ stored: NEW, auto: {}, defaults: NEW, former: [], exists: () => true })
  assert.deepEqual(plan.set, {})
  assert.deepEqual(plan.auto, NEW)
})

test('the Mac literals an earlier build wrote count as old defaults too', () => {
  const former = formerDefaults('darwin', '/Users/sam')
  assert.ok(former.includes('/Users/sam/jobscan/jobscan'))
  assert.ok(former.includes('F:/asbylevergreenhouse/jobscan'))
  assert.ok(former.includes('F:/asbylevergreenhouse/jobscan/.job-automator'))
})
