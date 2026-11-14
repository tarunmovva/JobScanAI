// Finding the user's own Codex CLI now that JobScan ships none.
//
// npm installs a JS launcher plus a native binary in a per-platform package,
// nested under the launcher's package or beside it. The app resolves the
// native binary directly (as codex.js does), never runs npm to find it, and
// never spawns a .cmd shim.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { locateUserCodex, binaryFromPackage } = require(path.join(__dirname, '..', '..', 'out', 'unit', 'electron', 'codex-locate.js'))

const TRIPLE = 'x86_64-pc-windows-msvc'

/** An npm global install of @openai/codex under `prefix`, nested or flat. */
function install(prefix, { layout = 'nested', sub = 'bin', platform = 'win32' } = {}) {
  const nm = platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules')
  const pkg = path.join(nm, '@openai', 'codex')
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.153.4', bin: { codex: 'bin/codex.js' } }))
  fs.writeFileSync(path.join(pkg, 'bin', 'codex.js'), '// launcher')
  const platRoot = layout === 'nested'
    ? path.join(pkg, 'node_modules', '@openai', 'codex-win32-x64')
    : path.join(nm, '@openai', 'codex-win32-x64')
  const exeDir = path.join(platRoot, 'vendor', TRIPLE, sub)
  fs.mkdirSync(exeDir, { recursive: true })
  fs.writeFileSync(path.join(platRoot, 'package.json'), JSON.stringify({ name: '@openai/codex-win32-x64', version: '0.153.4-win32-x64' }))
  fs.writeFileSync(path.join(exeDir, 'codex.exe'), 'MZ')
  if (platform === 'win32') fs.writeFileSync(path.join(prefix, 'codex.cmd'), '@echo off')
  return { pkg, exe: path.join(exeDir, 'codex.exe') }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-locate-'))
const opts = (over) => ({ setting: '', env: {}, platform: 'win32', arch: 'x64', homedir: os.homedir(), ...over })

test('the nested npm layout (this machine) resolves to the native binary', () => {
  const appdata = tmp()
  const { exe } = install(path.join(appdata, 'npm'))
  assert.equal(locateUserCodex(opts({ env: { APPDATA: appdata } })), exe)
})

test('the flat layout, and the older vendor/<triple>/codex/ folder, resolve too', () => {
  const a = tmp()
  assert.equal(locateUserCodex(opts({ env: { APPDATA: a } })), null)
  const { exe } = install(path.join(a, 'npm'), { layout: 'flat' })
  assert.equal(locateUserCodex(opts({ env: { APPDATA: a } })), exe)
  const b = tmp()
  const old = install(path.join(b, 'npm'), { sub: 'codex' })
  assert.equal(locateUserCodex(opts({ env: { APPDATA: b } })), old.exe)
})

test('a prefix found through the codex.cmd shim on PATH, never the shim itself', () => {
  const prefix = path.join(tmp(), 'custom-npm')
  const { exe } = install(prefix)
  assert.equal(locateUserCodex(opts({ env: { PATH: `C:\\nothing;${prefix}` } })), exe)
  fs.rmSync(path.join(prefix, 'node_modules'), { recursive: true })
  assert.equal(locateUserCodex(opts({ env: { PATH: prefix } })), null, 'a shim alone is not a binary')
})

test('a path set in Settings wins; the launcher script maps to its binary', () => {
  const a = tmp()
  const { pkg, exe } = install(path.join(a, 'npm'))
  const other = path.join(tmp(), 'codex.exe')
  fs.writeFileSync(other, 'MZ')
  assert.equal(locateUserCodex(opts({ setting: other, env: { APPDATA: a } })), other)
  assert.equal(locateUserCodex(opts({ setting: path.join(pkg, 'bin', 'codex.js') })), exe)
  assert.equal(locateUserCodex(opts({ env: { JOBSCAN_CODEX_BIN: other } })), other)
})

test('no Codex anywhere: null, so the app can say how to install it', () => {
  assert.equal(locateUserCodex(opts({ env: { APPDATA: tmp(), PATH: tmp() } })), null)
})

test('a platform package without its binary is not a Codex', () => {
  const a = tmp()
  const { pkg, exe } = install(path.join(a, 'npm'))
  fs.rmSync(exe)
  assert.equal(binaryFromPackage(pkg, 'win32', 'x64'), null)
  assert.equal(binaryFromPackage(pkg, 'sunos', 'x64'), null, 'a platform Codex does not build for')
})

test('this machine: a global Codex, when installed, is found', { skip: !process.env.APPDATA || process.platform !== 'win32' }, () => {
  const real = path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'package.json')
  if (!fs.existsSync(real)) return
  const found = locateUserCodex(opts({ env: process.env }))
  assert.ok(found && /codex\.exe$/i.test(found), String(found))
})
