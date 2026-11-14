// The store must not re-read its whole file on every access.
//
// conf re-parsed config.json on every get. At 17.5 MB that was ~85 ms a read,
// on the main process -- 3.7 s of the 4.2 s after Apply -- and the board never
// got painted. These tests pin the cache and the semantics it must not break.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Conf = require('conf').default
const { attachReadCache } = require('../../out/unit/electron/store-cache.js')

function fresh(defaults = { cards: {}, list: [] }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'store-cache-'))
  return attachReadCache(new Conf({ cwd, projectName: 'store-cache-test', defaults }))
}

function countReads(file, fn) {
  const orig = fs.readFileSync
  let n = 0
  fs.readFileSync = function (p, ...rest) { if (String(p) === file) n++; return orig.call(fs, p, ...rest) }
  try { fn() } finally { fs.readFileSync = orig }
  return n
}

test('a hundred gets parse the file once, not a hundred times', () => {
  const s = fresh()
  s.set('cards', { a: { column: 'todo' } })
  const reads = countReads(s.path, () => { for (let i = 0; i < 100; i++) s.get('cards') })
  assert.ok(reads <= 1, `read the file ${reads} times`)
})

test('an edit made to the file from outside is picked up', () => {
  // The e2e specs seed the file and reload; any outside writer must still work.
  const s = fresh()
  s.set('list', [1])
  const disk = JSON.parse(fs.readFileSync(s.path, 'utf8'))
  disk.list = [1, 2, 3, 'changed outside']
  fs.writeFileSync(s.path, JSON.stringify(disk))
  assert.deepEqual(s.get('list'), [1, 2, 3, 'changed outside'])
})

test('mutating what get returned does not change the store', () => {
  const s = fresh()
  s.set('cards', { a: { column: 'todo' } })
  const got = s.get('cards')
  got.a.column = 'done'
  got.b = { column: 'todo' }
  assert.deepEqual(s.get('cards'), { a: { column: 'todo' } })
})

test('mutating a value after set does not change the store', () => {
  const s = fresh()
  const value = ['first']
  s.set('list', value)
  value.push('added later, never set')
  assert.deepEqual(s.get('list'), ['first'])
})

test('every set is on disk immediately', () => {
  // Applied job ids are written the moment a submit is detected; they must
  // survive a crash one instruction later.
  const s = fresh()
  s.set('list', ['gh:acme:1234567'])
  assert.deepEqual(JSON.parse(fs.readFileSync(s.path, 'utf8')).list, ['gh:acme:1234567'])
  s.set({ list: ['x'], cards: { k: 1 } })
  const disk = JSON.parse(fs.readFileSync(s.path, 'utf8'))
  assert.deepEqual([disk.list, disk.cards], [['x'], { k: 1 }])
})

test('delete and defaults still behave', () => {
  const s = fresh({ cards: {}, list: [], n: 5 })
  assert.equal(s.get('n'), 5)
  s.set('n', 7)
  s.delete('n')
  assert.equal(s.get('n'), undefined)
  assert.equal(s.get('missing', 'fallback'), 'fallback')
})
