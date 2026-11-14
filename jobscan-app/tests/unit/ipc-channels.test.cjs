// Every IPC channel the renderer calls must be in the preload whitelist, and
// must have a handler in the main process.
//
// applied-jobs:open-file shipped with a handler and a button but no whitelist
// entry. The preload rejected it with "IPC channel not allowed", the promise
// rejected, and the UI reported "file missing" -- pointing the diagnosis at the
// file, which was present and readable the whole time.
//
// This is a source scan, not a runtime test: it catches the mismatch at the only
// point where all three lists are visible at once.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')

function readAll(dir, ext, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') readAll(p, ext, acc) }
    else if (ext.some(x => e.name.endsWith(x))) acc.push(p)
  }
  return acc
}

const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.ts'), 'utf-8')
const allowedBlock = preload.slice(
  preload.indexOf('ALLOWED_INVOKE'), preload.indexOf('ALLOWED_EVENTS'))
const allowed = new Set([...allowedBlock.matchAll(/'([^']+)'/g)].map(m => m[1]))

const mainSrc = readAll(path.join(ROOT, 'electron'), ['.ts'])
  .map(f => fs.readFileSync(f, 'utf-8')).join('\n')
// lockedWhileLooping registers an ipcMain.handle that refuses while loop mode is on.
const handlers = new Set(
  [...mainSrc.matchAll(/(?:ipcMain\.handle|lockedWhileLooping)\(\s*'([^']+)'/g)].map(m => m[1]))

// Orphaned components: present in the tree but imported by nothing, so their
// channels never run. Listed explicitly rather than skipped silently, because
// a stale channel name in dead code is a trap for whoever revives it.
//   SelectionScreen.tsx -- superseded by RatingScreen, which does the same
//   flow correctly (selection:confirm then pipeline:start-extract). The dead
//   copy still calls 'pipeline:start-fill', which has no handler at all.
const ORPHANED = new Set(['SelectionScreen.tsx'])

const rendererSrc = readAll(path.join(ROOT, 'src'), ['.ts', '.tsx'])
  .filter(f => !ORPHANED.has(path.basename(f)))
  .map(f => fs.readFileSync(f, 'utf-8')).join('\n')
const invoked = new Set(
  [...rendererSrc.matchAll(/ipc\.invoke(?:<[^>]*>)?\(\s*'([^']+)'/g)].map(m => m[1]))

test('every channel the renderer invokes is whitelisted in preload', () => {
  const missing = [...invoked].filter(c => !allowed.has(c))
  assert.deepEqual(missing, [],
    `preload ALLOWED_INVOKE is missing: ${missing.join(', ')} — these reject at runtime`)
})

test('every channel the renderer invokes has a main-process handler', () => {
  const missing = [...invoked].filter(c => !handlers.has(c))
  assert.deepEqual(missing, [],
    `no ipcMain.handle for: ${missing.join(', ')}`)
})

test('the scan actually found channels', () => {
  // A broken regex would make both tests above pass vacuously.
  assert.ok(invoked.size > 10, `only found ${invoked.size} invoked channels`)
  assert.ok(allowed.size > 10, `only found ${allowed.size} allowed channels`)
  assert.ok(handlers.size > 10, `only found ${handlers.size} handlers`)
  assert.ok(invoked.has('applied-jobs:open-file'), 'expected the file-open channel')
})

test('the orphan exemption is still justified', () => {
  // If SelectionScreen is imported again, this exemption must go and its
  // stale channel must be fixed first.
  const all = readAll(path.join(ROOT, 'src'), ['.ts', '.tsx'])
  for (const orphan of ORPHANED) {
    const name = orphan.replace(/\.tsx?$/, '')
    const importers = all
      .filter(f => path.basename(f) !== orphan)
      .filter(f => fs.readFileSync(f, 'utf-8').includes(name))
    assert.deepEqual(importers, [],
      `${orphan} is referenced again — remove the exemption and fix its channels`)
  }
})
