#!/usr/bin/env node
/**
 * Get a fresh clone ready to run: build the jobscan CLI from its Go source,
 * and make the Python form filler's virtual environment.
 *
 * Runs before every `npm run dev` (predev) and on its own as `npm run setup`.
 * Quick when nothing changed: the CLI is rebuilt only when a Go source is
 * newer than the binary, the venv's packages are reinstalled only when
 * requirements.txt changed, and a program is started for the first time
 * (see firstStarts) only once per file.
 *
 *   node scripts/setup.mjs            report each step
 *   node scripts/setup.mjs --quiet    report only work done and problems
 *   JOBSCAN_SKIP_SETUP=1              skip it all (you manage the CLI and Python yourself)
 *
 * Plain Node on purpose: npm runs scripts under cmd.exe on Windows and sh on
 * macOS, so a .sh or .ps1 would only work on one of them.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WIN = process.platform === 'win32'
const QUIET = process.argv.includes('--quiet')
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JOBSCAN = path.resolve(APP, '..', 'jobscan')
const BIN = path.join(JOBSCAN, WIN ? 'jobscan.exe' : 'jobscan')
const VENV = path.join(JOBSCAN, '.venv')
const VENV_PY = WIN ? path.join(VENV, 'Scripts', 'python.exe') : path.join(VENV, 'bin', 'python3')
const REQUIREMENTS = path.join(JOBSCAN, 'requirements.txt')
const REQ_STAMP = path.join(VENV, '.jobscan-requirements.sha256')
const WARM_STAMP = path.join(APP, 'node_modules', '.cache', 'jobscan-first-starts.json')
const MIN_GO = [1, 24]
const MIN_PY = [3, 10]

const say = msg => { if (!QUIET) console.log(`[setup] ${msg}`) }
const did = msg => console.log(`[setup] ${msg}`)
const warn = msg => console.warn(`[setup] warning: ${msg}`)
function fail(msg) {
  console.error(`\n[setup] ${msg}\n`)
  process.exit(1)
}
const atLeast = (v, min) => v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1])

// ── 1. the jobscan CLI ──────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '.job-automator', '__pycache__', 'data', 'apply_runs', 'reports'])

/** The newest mtime of anything that goes into the binary. */
function newestGoSource(dir) {
  let newest = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) newest = Math.max(newest, newestGoSource(path.join(dir, e.name)))
    } else if (e.name.endsWith('.go') || e.name === 'go.mod' || e.name === 'go.sum') {
      newest = Math.max(newest, fs.statSync(path.join(dir, e.name)).mtimeMs)
    }
  }
  return newest
}

function buildCli() {
  if (!fs.existsSync(path.join(JOBSCAN, 'go.mod'))) fail(`jobscan/go.mod not found at ${JOBSCAN} -- run this from a clone of the whole repo.`)
  const binTime = fs.existsSync(BIN) ? fs.statSync(BIN).mtimeMs : 0
  if (binTime > 0 && binTime >= newestGoSource(JOBSCAN)) {
    say(`jobscan CLI is up to date (${path.relative(APP, BIN)})`)
    return
  }
  const go = spawnSync('go', ['version'], { encoding: 'utf-8' })
  const m = /go(\d+)\.(\d+)/.exec(go.stdout ?? '')
  if (go.error || go.status !== 0 || !m) {
    fail(`Go ${MIN_GO.join('.')}+ is needed to build the jobscan CLI, and \`go\` was not found.\n`
      + '        Install it from https://go.dev/dl/ (macOS: `brew install go`), open a new terminal, and run this again.')
  }
  if (!atLeast([Number(m[1]), Number(m[2])], MIN_GO)) {
    fail(`Go ${MIN_GO.join('.')}+ is needed to build the jobscan CLI; found go${m[1]}.${m[2]}. Update it from https://go.dev/dl/.`)
  }
  did(binTime ? 'Go sources changed: rebuilding the jobscan CLI…' : 'building the jobscan CLI from source…')
  const b = spawnSync('go', ['build', '-o', path.basename(BIN), '.'], { cwd: JOBSCAN, stdio: 'inherit' })
  if (b.status !== 0) fail('`go build` failed (see above).')
  did(`built ${path.relative(APP, BIN)}`)
}

// ── 2. Python for the form filler ───────────────────────────────────────────

/** A Python 3.10+ to make the venv with. Each candidate is run: the Windows Store `python` stub fails here. */
function basePython() {
  const candidates = WIN ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']]
  const seen = []
  for (const [cmd, ...pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf-8' })
    const m = /^(\d+)\.(\d+)/.exec((r.stdout ?? '').trim())
    if (r.status !== 0 || !m) continue
    const v = [Number(m[1]), Number(m[2])]
    if (atLeast(v, MIN_PY)) return { cmd, pre }
    seen.push(`${[cmd, ...pre].join(' ')} is ${v.join('.')}`)
  }
  fail(`Python ${MIN_PY.join('.')}+ is needed for the form filler${seen.length ? ` (${seen.join('; ')})` : ', and none was found'}.\n`
    + '        Install it from https://www.python.org/downloads/ (macOS: `brew install python`), open a new terminal, and run this again.')
}

function setupPython() {
  if (!fs.existsSync(VENV_PY)) {
    const py = basePython()
    did(`creating the form filler's Python environment (${path.relative(APP, VENV)})…`)
    const v = spawnSync(py.cmd, [...py.pre, '-m', 'venv', VENV], { stdio: 'inherit' })
    if (v.status !== 0 || !fs.existsSync(VENV_PY)) fail('could not create the virtual environment (see above).')
  }
  const want = createHash('sha256').update(fs.readFileSync(REQUIREMENTS)).digest('hex')
  const have = fs.existsSync(REQ_STAMP) ? fs.readFileSync(REQ_STAMP, 'utf-8').trim() : ''
  if (have === want) {
    say('Python packages are up to date')
    return
  }
  did('installing the form filler\'s Python packages…')
  const pip = spawnSync(VENV_PY, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', REQUIREMENTS], { stdio: 'inherit' })
  if (pip.status !== 0) fail('`pip install -r jobscan/requirements.txt` failed (see above).')
  fs.writeFileSync(REQ_STAMP, want + '\n')
  did('Python packages installed')
}

// ── 3. first starts, here rather than in the app ───────────────────────────
//
// A program the antivirus has not seen waits for its scan the first time it
// starts, and the app starts these on the thread that draws its window: a
// new codex.exe froze it for 11 s. Each is started once here instead, once
// per file (size and time recorded in node_modules/.cache).

/** The Codex binary npm installed for this platform, if any. */
function bundledCodex() {
  const root = path.join(APP, 'node_modules', '@openai')
  let pkgs = []
  try { pkgs = fs.readdirSync(root).filter(n => n.startsWith('codex-')) } catch { return null }
  for (const pkg of pkgs) {
    const vendor = path.join(root, pkg, 'vendor')
    let triples = []
    try { triples = fs.readdirSync(vendor) } catch { continue }
    for (const triple of triples) {
      for (const sub of ['bin', 'codex']) {
        const exe = path.join(vendor, triple, sub, WIN ? 'codex.exe' : 'codex')
        if (fs.existsSync(exe)) return exe
      }
    }
  }
  return null
}

function firstStarts() {
  let stamp = {}
  try { stamp = JSON.parse(fs.readFileSync(WARM_STAMP, 'utf-8')) } catch { /* none yet */ }
  const targets = [[BIN, ['--help']], [VENV_PY, ['--version']], [bundledCodex(), ['--version']]]
  let changed = false
  for (const [exe, args] of targets) {
    if (!exe || !fs.existsSync(exe)) continue
    const st = fs.statSync(exe)
    const key = `${st.size}:${st.mtimeMs}`
    if (stamp[exe] === key) continue
    const t0 = Date.now()
    spawnSync(exe, args, { stdio: 'ignore', windowsHide: true, timeout: 120_000 })
    const secs = (Date.now() - t0) / 1000
    if (secs > 1) did(`first start of ${path.relative(APP, exe)} took ${secs.toFixed(1)} s (antivirus scan) -- done here so the app does not wait for it`)
    stamp[exe] = key
    changed = true
  }
  if (changed) {
    fs.mkdirSync(path.dirname(WARM_STAMP), { recursive: true })
    fs.writeFileSync(WARM_STAMP, JSON.stringify(stamp, null, 1))
  }
  say('first starts done')
}

// ── 4. Chrome (only checked: the filler drives your own Chrome) ────────────

function checkChrome() {
  const home = os.homedir()
  const candidates = [
    process.env.JOB_AUTOMATOR_CHROME_PATH,
    ...(WIN
      ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
        .filter(Boolean).map(base => path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')]),
  ].filter(Boolean)
  if (candidates.some(p => fs.existsSync(p))) {
    say('Google Chrome found')
    return
  }
  warn('Google Chrome was not found. Applying needs it: install Chrome, or set JOB_AUTOMATOR_CHROME_PATH to its executable.')
}

if (process.env.JOBSCAN_SKIP_SETUP === '1') {
  say('skipped (JOBSCAN_SKIP_SETUP=1)')
} else {
  buildCli()
  setupPython()
  firstStarts()
  checkChrome()
}
