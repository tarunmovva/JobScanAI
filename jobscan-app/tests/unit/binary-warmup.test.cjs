// A binary's first start, moved off the app's main thread.
//
// Starting a program the antivirus has not seen waits for its scan, and
// Node's spawn() waits on the calling thread: a new codex.exe froze the
// window for 11 s on its first start (measured: 606 ms cold here, 6 ms after
// a warm-up in a worker). warmBinary starts it once in a worker thread first.
// It must never fail and never be repeated for the same file.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { warmBinary } = require('../../out/unit/electron/binary-warmup.js')

test('a binary is started once in a worker and the promise resolves', async () => {
  await warmBinary(process.execPath, ['--version'])
})

test('the same file is warmed only once', () => {
  assert.equal(warmBinary(process.execPath, ['--version']), warmBinary(process.execPath, ['--version']))
})

test('a binary that cannot start never fails the caller', async () => {
  await warmBinary(path.join(__dirname, 'no-such-program.exe'), ['--version'])
})

test('a binary that never exits is given up on', async () => {
  const t0 = Date.now()
  await warmBinary(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], 300)
  assert.ok(Date.now() - t0 < 5000, 'waited for it')
})
