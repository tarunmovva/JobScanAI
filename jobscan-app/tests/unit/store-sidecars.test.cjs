// The bulk of the store lives beside config.json, not in it.
//
// Every store.set rewrites all of config.json, synchronously, on the main
// process. On a real config (15 MB) one write took ~180 ms; without the rated
// pool and the candidate pool (and the other profiles' copies of them),
// ~13 ms. Those now live in side files. These tests pin that it loses
// nothing: the logical store reads back the same before and after, through
// crashes, resets, locked or damaged files, and edits of config.json.
//
// The profile snapshots -- the other profiles' applied history, which
// nothing can rebuild -- stay in config.json. An earlier build kept them in
// a side file; that file is brought back.
//
// Real conf, temp directories. Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Conf = require('conf').default
const { attachReadCache } = require('../../out/unit/electron/store-cache.js')
const { attachSidecars, SIDECAR_GEN_KEY } = require('../../out/unit/electron/store-sidecars.js')

const BULK = { candidates: [], ratedJobs: [], profilePools: {} }
const DATA = {
  appState: 'rating',
  appliedJobIds: ['lever:1', 'greenhouse:2'],
  candidates: [{ platform: 'lever', job_id: '1', description: 'x'.repeat(500) }],
  ratedJobs: [{ platform: 'lever', job_id: '1', rating: 9, reason: 'fit' }],
  profilePools: { p1: { ratedJobs: [{ job_id: '9', rating: 7 }] } },
}
const SIDE = /config\.(candidates|ratedJobs|profilePools)\.json/

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'store-sidecars-')) }
function writeMain(cwd, obj) { fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify(obj, null, '\t')) }
function readMain(cwd) { return JSON.parse(fs.readFileSync(path.join(cwd, 'config.json'), 'utf-8')) }
function open(cwd, defaults = { appState: 'auth', appliedJobIds: [] }) {
  return attachSidecars(attachReadCache(new Conf({ cwd, projectName: 'store-sidecars-test', defaults })), { keys: BULK })
}
const logical = s => ({
  appState: s.get('appState'), appliedJobIds: s.get('appliedJobIds'),
  candidates: s.get('candidates'), ratedJobs: s.get('ratedJobs'), profilePools: s.get('profilePools'),
})
const sideFiles = (cwd, k, tag) => fs.readdirSync(cwd).filter(f => f.startsWith(`config.${k}.json.${tag}`))
/** Make fs[name] fail with `code` on side-file paths, `times` times (default: always). */
function failing(name, code, times = Infinity) {
  const orig = fs[name]
  let left = times
  fs[name] = function (p, ...rest) {
    if (left > 0 && SIDE.test(String(p))) {
      left--
      throw Object.assign(new Error(`${code} (test)`), { code })
    }
    return orig.call(fs, p, ...rest)
  }
  return () => { fs[name] = orig }
}

test('the bulk keys move out of config.json and read back exactly the same', () => {
  const cwd = dir()
  writeMain(cwd, DATA)
  const s = open(cwd)
  assert.deepEqual(logical(s), DATA)
  const main = readMain(cwd)
  for (const k of Object.keys(BULK)) {
    assert.equal(k in main, false, `${k} is still in config.json`)
    assert.ok(fs.existsSync(path.join(cwd, `config.${k}.json`)), `no side file for ${k}`)
  }
  assert.ok(main[SIDECAR_GEN_KEY], 'config.json does not name its side files')
  assert.deepEqual(main.appliedJobIds, DATA.appliedJobIds, 'the rest stays in config.json')
  assert.ok(fs.readdirSync(cwd).some(f => f.startsWith('config.json.bak-')), 'no backup of the original config.json')
})

test('a second start changes nothing', () => {
  const cwd = dir()
  writeMain(cwd, DATA)
  open(cwd).get('ratedJobs')
  const before = fs.readFileSync(path.join(cwd, 'config.json'), 'utf-8')
  const s = open(cwd)
  assert.deepEqual(logical(s), DATA)
  assert.equal(fs.readFileSync(path.join(cwd, 'config.json'), 'utf-8'), before)
})

test('a crash after writing side files but before committing recovers from config.json', () => {
  const cwd = dir()
  // Side files of an interrupted move, and config.json still holding everything, unmarked.
  for (const k of Object.keys(BULK)) {
    fs.writeFileSync(path.join(cwd, `config.${k}.json`), JSON.stringify({ gen: 'interrupted', value: 'partial' }))
  }
  writeMain(cwd, DATA)
  const s = open(cwd)
  assert.deepEqual(logical(s), DATA)
  assert.notEqual(readMain(cwd)[SIDECAR_GEN_KEY], 'interrupted')
})

test('a bulk key written into config.json again wins, and is moved out', () => {
  const cwd = dir()
  writeMain(cwd, DATA)
  open(cwd).get('ratedJobs')
  const seeded = [{ platform: 'ashby', job_id: 'new', rating: 10, reason: 'seeded' }]
  writeMain(cwd, { ...readMain(cwd), ratedJobs: seeded })
  const s = open(cwd)
  assert.deepEqual(s.get('ratedJobs'), seeded)
  assert.equal('ratedJobs' in readMain(cwd), false)
  assert.deepEqual(open(cwd).get('ratedJobs'), seeded)
})

test('a fresh config.json never inherits the side files of an old one', () => {
  const cwd = dir()
  writeMain(cwd, DATA)
  open(cwd).get('ratedJobs')
  fs.unlinkSync(path.join(cwd, 'config.json'))
  const s = open(cwd)
  assert.deepEqual(s.get('ratedJobs'), [])
  assert.deepEqual(s.get('profilePools'), {})
  assert.ok(fs.existsSync(path.join(cwd, 'config.ratedJobs.json')), 'nothing here deletes data')
})

test('set, get and delete route the bulk keys to side files and leave the rest alone', () => {
  const cwd = dir()
  const s = open(cwd)
  s.set('candidates', [{ job_id: 'c' }])
  s.set('appState', 'board')
  const main = readMain(cwd)
  assert.equal('candidates' in main, false)
  assert.equal(main.appState, 'board')
  assert.deepEqual(open(cwd).get('candidates'), [{ job_id: 'c' }])
  s.delete('candidates')
  assert.deepEqual(s.get('candidates'), [])
  assert.deepEqual(open(cwd).get('candidates'), [])
})

test('values handed out and taken in are copies', () => {
  const cwd = dir()
  const s = open(cwd)
  const v = [{ job_id: 'a' }]
  s.set('ratedJobs', v)
  v.push({ job_id: 'mutated after set' })
  const got = s.get('ratedJobs')
  got.push({ job_id: 'mutated after get' })
  assert.deepEqual(s.get('ratedJobs'), [{ job_id: 'a' }])
})

test('an empty value in config.json wins too, and the side data it replaces is kept', () => {
  // An empty pool there is a real value: a profile switched to an empty
  // pool while its side file could not be written. The old pool coming
  // back would be another persona's. It is kept beside, never deleted.
  const cwd = dir()
  writeMain(cwd, DATA)
  open(cwd).get('candidates')
  writeMain(cwd, { ...readMain(cwd), candidates: [] })
  const s = open(cwd)
  assert.deepEqual(s.get('candidates'), [])
  assert.equal('candidates' in readMain(cwd), false)
  const prev = sideFiles(cwd, 'candidates', 'prev')
  assert.equal(prev.length, 1, 'the replaced side file was not kept')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, prev[0]), 'utf-8')).value, DATA.candidates)
})

test('a value kept in config.json after a failed side write still wins at the next start', () => {
  const cwd = dir()
  writeMain(cwd, DATA)
  open(cwd).get('ratedJobs')
  const s = open(cwd)
  const restore = failing('openSync', 'EACCES')
  try { s.set('ratedJobs', []) } finally { restore() }
  assert.deepEqual(readMain(cwd).ratedJobs, [], 'the write was not kept in config.json')
  assert.deepEqual(open(cwd).get('ratedJobs'), [], 'the old pool came back')
})

test('a side file that cannot be read is never read as empty', () => {
  const cwd = dir()
  writeMain(cwd, DATA)
  open(cwd).get('ratedJobs')
  const restore = failing('readFileSync', 'EBUSY')
  try {
    assert.throws(() => open(cwd).get('ratedJobs'), /EBUSY/)
  } finally { restore() }
  assert.deepEqual(open(cwd).get('ratedJobs'), DATA.ratedJobs, 'the data did not survive')
})

test('a side file locked for a moment is read once it frees', () => {
  const cwd = dir()
  writeMain(cwd, DATA)
  open(cwd).get('ratedJobs')
  const restore = failing('readFileSync', 'EBUSY', 2)
  try {
    assert.deepEqual(open(cwd).get('ratedJobs'), DATA.ratedJobs)
  } finally { restore() }
})

test('a damaged side file is set aside, never deleted, and reads as empty', () => {
  const cwd = dir()
  writeMain(cwd, DATA)
  open(cwd).get('ratedJobs')
  const damaged = '{"gen":"x","value":[{"job_'
  fs.writeFileSync(path.join(cwd, 'config.ratedJobs.json'), damaged)
  const s = open(cwd)
  assert.deepEqual(s.get('ratedJobs'), [])
  const aside = sideFiles(cwd, 'ratedJobs', 'corrupt-')
  assert.equal(aside.length, 1, 'the damaged file was not kept')
  assert.equal(fs.readFileSync(path.join(cwd, aside[0]), 'utf-8'), damaged)
  assert.deepEqual(s.get('candidates'), DATA.candidates, 'the other keys were touched')
})

test('a side write reaches the disk before it replaces the old file', () => {
  const cwd = dir()
  const s = open(cwd)
  const events = []
  const { fsyncSync, renameSync } = fs
  fs.fsyncSync = function (fd) { events.push('fsync'); return fsyncSync.call(fs, fd) }
  fs.renameSync = function (a, b) { if (SIDE.test(String(b))) events.push('rename'); return renameSync.call(fs, a, b) }
  try { s.set('ratedJobs', [{ job_id: 'a' }]) } finally { fs.fsyncSync = fsyncSync; fs.renameSync = renameSync }
  assert.deepEqual(events, ['fsync', 'rename'])
})

test('the side file of another config is kept when this one first writes its own', () => {
  const cwd = dir()
  fs.writeFileSync(path.join(cwd, 'config.ratedJobs.json'), JSON.stringify({ gen: 'another', value: [{ job_id: 'theirs' }] }))
  const s = open(cwd)
  s.set('ratedJobs', [{ job_id: 'mine' }])
  assert.deepEqual(open(cwd).get('ratedJobs'), [{ job_id: 'mine' }])
  const prev = sideFiles(cwd, 'ratedJobs', 'prev')
  assert.equal(prev.length, 1, "the other config's data was overwritten")
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, prev[0]), 'utf-8')).value, [{ job_id: 'theirs' }])
})

test('temp files left by a crash are cleared at start', () => {
  const cwd = dir()
  fs.writeFileSync(path.join(cwd, 'config.ratedJobs.json.99999.tmp'), 'half')
  open(cwd).get('ratedJobs')
  assert.equal(fs.existsSync(path.join(cwd, 'config.ratedJobs.json.99999.tmp')), false)
})

test('changing a bulk key does not rewrite config.json', () => {
  const cwd = dir()
  writeMain(cwd, DATA)
  const s = open(cwd)
  s.get('ratedJobs')
  const before = fs.statSync(path.join(cwd, 'config.json')).mtimeMs
  s.set('ratedJobs', [{ job_id: 'changed' }])
  assert.equal(fs.statSync(path.join(cwd, 'config.json')).mtimeMs, before)
})

test('if a side file cannot be written, the data stays in config.json', () => {
  const cwd = dir()
  writeMain(cwd, DATA)
  const restore = failing('openSync', 'EACCES')
  try {
    const s = open(cwd)
    assert.deepEqual(logical(s), DATA)
    const main = readMain(cwd)
    assert.deepEqual(main.ratedJobs, DATA.ratedJobs, 'moved away despite the failure')
    s.set('ratedJobs', [{ job_id: 'still inline' }])
    assert.deepEqual(readMain(cwd).ratedJobs, [{ job_id: 'still inline' }])
    assert.deepEqual(fs.readdirSync(cwd).filter(f => f.endsWith('.tmp')), [], 'a temp file was left behind')
  } finally {
    restore()
  }
})

// Counting or scanning a pool must not copy it: every copy of a 3.3 MB pool
// is garbage the main process has to collect, and one collection froze the
// window for 1.1 s in a live run.
test('peek reads without copying, and sees what get sees', () => {
  const cwd = dir()
  writeMain(cwd, DATA)
  const s = open(cwd)
  assert.equal(s.peek('ratedJobs'), s.peek('ratedJobs'), 'peek copied the pool')
  assert.deepEqual(s.peek('ratedJobs'), s.get('ratedJobs'))
  assert.deepEqual(s.peek('appliedJobIds'), DATA.appliedJobIds)
  assert.deepEqual(s.peek('candidates'), DATA.candidates)
  s.set('ratedJobs', [{ job_id: 'new' }])
  assert.deepEqual(s.peek('ratedJobs'), [{ job_id: 'new' }])
  assert.equal(s.peek('nothing'), undefined)
})

test('a key kept out of memory still reads and writes like the rest', () => {
  const cwd = dir()
  writeMain(cwd, DATA)
  const s = attachSidecars(attachReadCache(new Conf({ cwd, projectName: 'store-sidecars-test', defaults: { appState: 'auth' } })),
    { keys: BULK, uncached: ['profilePools'] })
  assert.deepEqual(s.get('profilePools'), DATA.profilePools)
  assert.notEqual(s.peek('profilePools'), s.peek('profilePools'), 'it was kept in memory')
  s.set('profilePools', { p2: { ratedJobs: [] } })
  assert.deepEqual(s.get('profilePools'), { p2: { ratedJobs: [] } })
  assert.deepEqual(open(cwd).get('profilePools'), { p2: { ratedJobs: [] } })
})

// An earlier build kept the profile snapshots beside config.json. They hold
// the other profiles' applied history: they come back into config.json.
const SNAPS = { p1: { appliedJobIds: ['lever:7'], resumeText: 'r' } }
function openRetiring(cwd) {
  return attachSidecars(attachReadCache(new Conf({
    cwd, projectName: 'store-sidecars-test', defaults: { appState: 'auth', profileSnapshots: {} },
  })), { keys: BULK, retired: { profileSnapshots: {} } })
}

test('profile snapshots an earlier build kept beside config.json come back into it', () => {
  const cwd = dir()
  writeMain(cwd, { appState: 'board', [SIDECAR_GEN_KEY]: 'g1' })
  fs.writeFileSync(path.join(cwd, 'config.profileSnapshots.json'), JSON.stringify({ gen: 'g1', value: SNAPS }))
  const s = openRetiring(cwd)
  assert.deepEqual(s.get('profileSnapshots'), SNAPS)
  assert.deepEqual(readMain(cwd).profileSnapshots, SNAPS)
  assert.equal(fs.existsSync(path.join(cwd, 'config.profileSnapshots.json')), false, 'it would be restored again')
  assert.equal(sideFiles(cwd, 'profileSnapshots', 'restored-').length, 1, 'the old file was not kept')
  assert.deepEqual(openRetiring(cwd).get('profileSnapshots'), SNAPS)
})

test('restored snapshots never replace snapshots config.json already holds', () => {
  const cwd = dir()
  const newer = { p1: { appliedJobIds: ['lever:7', 'lever:8'] } }
  writeMain(cwd, { appState: 'board', [SIDECAR_GEN_KEY]: 'g1', profileSnapshots: newer })
  fs.writeFileSync(path.join(cwd, 'config.profileSnapshots.json'), JSON.stringify({ gen: 'g1', value: SNAPS }))
  assert.deepEqual(openRetiring(cwd).get('profileSnapshots'), newer)
  assert.equal(sideFiles(cwd, 'profileSnapshots', 'superseded-').length, 1, 'the old file was not kept')
})

test('snapshots that could not be read at one start come back at the next, beside those written since', () => {
  // Found in review: the restore failed (file locked), the boot then wrote
  // the active profile's snapshot, and the next start took that one entry
  // for "newer" and set the file aside: every other profile's history gone.
  const cwd = dir()
  const both = { A: { appliedJobIds: ['lever:1'] }, B: { appliedJobIds: ['lever:2', 'lever:3'] } }
  writeMain(cwd, { appState: 'board', [SIDECAR_GEN_KEY]: 'g1' })
  const f = path.join(cwd, 'config.profileSnapshots.json')
  fs.writeFileSync(f, JSON.stringify({ gen: 'g1', value: both }))
  const orig = fs.readFileSync
  fs.readFileSync = function (p, ...rest) {
    if (String(p) === f) throw Object.assign(new Error('EBUSY (test)'), { code: 'EBUSY' })
    return orig.call(fs, p, ...rest)
  }
  let first
  try { first = openRetiring(cwd) } finally { fs.readFileSync = orig }
  assert.deepEqual(first.get('profileSnapshots'), {})
  assert.ok(fs.existsSync(f), 'the file was given up on')
  first.set('profileSnapshots', { A: { appliedJobIds: ['lever:1', 'lever:9'] } })   // the boot's own sync
  const s = openRetiring(cwd)
  assert.deepEqual(s.get('profileSnapshots'), {
    A: { appliedJobIds: ['lever:1', 'lever:9'] },           // the newer one, written since
    B: { appliedJobIds: ['lever:2', 'lever:3'] },           // and the one only the file had
  })
  assert.equal(fs.existsSync(f), false)
})

test("another config's snapshot file is left alone", () => {
  const cwd = dir()
  writeMain(cwd, { appState: 'board', [SIDECAR_GEN_KEY]: 'g2' })
  fs.writeFileSync(path.join(cwd, 'config.profileSnapshots.json'), JSON.stringify({ gen: 'g1', value: SNAPS }))
  assert.deepEqual(openRetiring(cwd).get('profileSnapshots'), {})
  assert.ok(fs.existsSync(path.join(cwd, 'config.profileSnapshots.json')))
})
