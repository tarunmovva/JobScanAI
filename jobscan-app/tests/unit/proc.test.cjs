// A loop round must never hang on one filler. There is no timeout anywhere
// below the app (Go waits on the filler forever), so the app arms one, and it
// has to kill the whole tree: jobscan.exe -> python -> codex/playwright-mcp. A
// plain kill() of the top process leaves the grandchildren driving Chrome.
//
// Real child processes, no mocks.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')
const { armTimeout, killTree, treeSpawnOptions: treeOpts } = require('../../out/unit/electron/proc.js')

const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' })
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms))])

test('armTimeout kills the child when the time runs out, and says so', async () => {
  const child = sleeper()
  const exited = new Promise(r => child.once('exit', r))
  let fired = 0
  const t0 = Date.now()
  armTimeout(child, 300, () => { fired++ })
  await within(exited, 8000, 'child was not killed')
  assert.equal(fired, 1)
  assert.ok(Date.now() - t0 >= 250, 'killed before its time')
})

test('the timeout kills grandchildren too', async () => {
  // The parent prints its child's pid, then both sleep.
  // Spawned as the app spawns jobscan: on macOS/Linux it leads its own group.
  const parent = spawn(process.execPath, ['-e',
    "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});" +
    'console.log(c.pid);setTimeout(()=>{},60000)'], { stdio: ['ignore', 'pipe', 'ignore'], ...treeOpts() })
  const grandPid = await within(new Promise(r => parent.stdout.once('data', d => r(Number(String(d).trim())))), 8000, 'no pid')
  assert.ok(alive(grandPid))
  const exited = new Promise(r => parent.once('exit', r))
  armTimeout(parent, 200, () => {})
  await within(exited, 8000, 'parent was not killed')
  const deadline = Date.now() + 8000
  while (alive(grandPid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
  assert.equal(alive(grandPid), false, 'grandchild survived its parent')
})

test('disarming in time leaves the child alone', async () => {
  const child = sleeper()
  let fired = false
  const disarm = armTimeout(child, 300, () => { fired = true })
  disarm()
  await new Promise(r => setTimeout(r, 700))
  assert.equal(fired, false)
  assert.equal(child.exitCode, null)
  const exited = new Promise(r => child.once('exit', r))
  killTree(child)
  await within(exited, 8000, 'cleanup kill failed')
})

test('a child that finishes on its own never triggers the timeout', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  let fired = false
  armTimeout(child, 400, () => { fired = true })
  await new Promise(r => child.once('exit', r))
  await new Promise(r => setTimeout(r, 700))
  assert.equal(fired, false)
})

// collectChild is how runCli waits on the CLI. On a deadline it must not
// report back until the whole tree is gone: the filler writes into Go's
// stderr, so the pipes closing is the proof that nothing below can still
// click submit -- and only then may the app close the job's tab.
const { collectChild, treeSpawnOptions, stopGently } = require('../../out/unit/electron/proc.js')

// jobscan fetch abandons a rebuild cleanly on SIGTERM (leaving jobs.db as it
// was); a SIGKILL leaves its rebuild file behind. So fetch is asked first,
// and forced only if it is still running after a grace period. Never a
// filler: a grace period would let it click submit.
test('on macOS a child marked to stop gently gets SIGTERM, then SIGKILL if still running', async () => {
  const calls = []
  const child = { pid: 777, exitCode: null, signalCode: null, kill: sig => calls.push(['child.kill', sig]) }
  stopGently(child, 40)
  killTree(child, 'darwin', (pid, sig) => calls.push(['kill', pid, sig]))
  assert.deepEqual(calls, [['kill', -777, 'SIGTERM']])
  await new Promise(r => setTimeout(r, 120))
  assert.deepEqual(calls, [['kill', -777, 'SIGTERM'], ['kill', -777, 'SIGKILL']])
})

test('a gently stopped child that exits in time is not killed again', async () => {
  const calls = []
  const child = { pid: 778, exitCode: null, signalCode: null, kill: sig => calls.push(['child.kill', sig]) }
  stopGently(child, 40)
  killTree(child, 'darwin', (pid, sig) => calls.push(['kill', pid, sig]))
  child.exitCode = 1   // it abandoned its rebuild and exited
  await new Promise(r => setTimeout(r, 120))
  assert.deepEqual(calls, [['kill', -778, 'SIGTERM']])
})

test('stopping gently changes nothing on Windows', () => {
  const calls = []
  const child = { pid: undefined, exitCode: null, signalCode: null, kill: sig => calls.push(['child.kill', sig]) }
  stopGently(child, 40)
  killTree(child, 'win32', () => calls.push(['kill']))
  assert.deepEqual(calls, [['child.kill', undefined]])
})

// macOS / Linux: a plain kill() of jobscan left its python filler running --
// Go does not pass the signal on -- and the filler could still click submit
// after a cancel. Each child now leads its own process group, and the whole
// group is killed. Run on a Mac only through these injected fakes.
test('on macOS each child leads its own process group; on Windows nothing changes', () => {
  assert.deepEqual(treeSpawnOptions('darwin'), { detached: true })
  assert.deepEqual(treeSpawnOptions('linux'), { detached: true })
  assert.deepEqual(treeSpawnOptions('win32'), {})
})

test('on macOS killTree kills the whole process group', () => {
  const calls = []
  const child = { pid: 4242, kill: sig => calls.push(['child.kill', sig]) }
  killTree(child, 'darwin', (pid, sig) => calls.push(['kill', pid, sig]))
  assert.deepEqual(calls, [['kill', -4242, 'SIGKILL']])
})

test('on macOS a child that leads no group is still killed', () => {
  const calls = []
  const child = { pid: 4242, kill: sig => calls.push(['child.kill', sig]) }
  killTree(child, 'darwin', () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) })
  assert.deepEqual(calls, [['child.kill', 'SIGKILL']])
})
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')

test('collectChild gathers both streams and the exit code', async () => {
  const child = spawn(process.execPath, ['-e', "console.log('out');console.error('err');process.exitCode=3"])
  const lines = []
  const r = await within(collectChild(child, { onLine: l => lines.push(l) }), 8000, 'never settled')
  assert.deepEqual(r, { stdout: 'out\n', stderr: 'err\n', exitCode: 3, timedOut: false })
  assert.deepEqual(lines, ['out'])
})

test('collectChild on a deadline kills the tree, waits for it, and reports the timeout', async () => {
  const child = spawn(process.execPath, ['-e', "console.log('started');setTimeout(()=>{},60000)"])
  const r = await within(collectChild(child, { timeoutMs: 300 }), 8000, 'never settled')
  assert.equal(r.timedOut, true)
  assert.equal(r.exitCode, -2)
  assert.equal(r.stdout, 'started\n')
  assert.equal(alive(child.pid), false, 'reported back while the child was still running')
})

test('collectChild stops waiting after the grace period if the pipes never close', async () => {
  // A stand-in whose streams never end: what a survivor holding the pipe looks like.
  const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: () => true })
  const t0 = Date.now()
  const r = await within(collectChild(fake, { timeoutMs: 50, graceMs: 100 }), 4000, 'waited forever')
  assert.equal(r.timedOut, true)
  assert.equal(r.exitCode, -2)
  assert.ok(Date.now() - t0 >= 140, 'gave up before the grace period')
})

test('collectChild with no deadline never times out', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},500)'])
  const r = await within(collectChild(child), 8000, 'never settled')
  assert.deepEqual(r, { stdout: '', stderr: '', exitCode: 0, timedOut: false })
})

test('collectChild hands over whole lines, however the output is cut', async () => {
  // A JSON line split across two chunks reached onLine as two broken halves,
  // and a character split across chunks came out mangled.
  const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: () => true })
  const lines = []
  const done = collectChild(fake, { onLine: l => lines.push(l) })
  const text = Buffer.from('{"job_id":"a","title":"Café"}\r\n{"job_id":"b"}\nlast')
  const cut = text.indexOf('é') + 1              // inside the two bytes of é
  fake.stdout.write(text.subarray(0, 9))
  fake.stdout.write(text.subarray(9, cut))
  fake.stdout.write(text.subarray(cut))
  await new Promise(r => setImmediate(r))
  fake.emit('close', 0)
  const r = await within(done, 4000, 'never settled')
  assert.deepEqual(lines, ['{"job_id":"a","title":"Café"}', '{"job_id":"b"}', 'last'])
  assert.equal(r.stdout, text.toString())
})

test('collectChild settles even when the last line makes onLine throw', async () => {
  const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: () => true })
  const done = collectChild(fake, { onLine: () => { throw new Error('consumer broke') } })
  fake.stdout.write('no newline at the end')
  await new Promise(r => setImmediate(r))
  fake.emit('close', 0)
  const r = await within(done, 2000, 'never settled')
  assert.equal(r.exitCode, 0)
})

test('collectChild hands over nothing once it has settled', async () => {
  const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: () => true })
  const lines = []
  const r = await within(collectChild(fake, { onLine: l => lines.push(l), timeoutMs: 30, graceMs: 30 }), 4000, 'never settled')
  assert.equal(r.timedOut, true)
  fake.stdout.write('late line\n')
  await new Promise(res => setImmediate(res))
  assert.deepEqual(lines, [])
})

test('collectChild rejects when the program cannot start', async () => {
  const child = spawn('definitely-not-a-real-program-xyz', [])
  await assert.rejects(within(collectChild(child), 8000, 'never settled'), /ENOENT/)
})
