// Which Codex build this machine runs: npm package, version tag, Rust target
// triple inside the package, executable name.
//
// Windows used to be pinned to x86_64-pc-windows-msvc, so an ARM Windows
// machine looked for the x64 binary inside the ARM package and found
// nothing. The triples below are read off the real 0.153.4 tarballs
// (package/vendor/<triple>/bin/codex[.exe]).
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const { codexPlatform } = require('../../out/unit/electron/codex-platform.js')

test('each supported platform and architecture maps to its own build', () => {
  assert.deepEqual(codexPlatform('win32', 'x64'),
    { tag: 'win32-x64', pkg: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc', exe: 'codex.exe', bundled: 'codex-win-x64.exe' })
  assert.deepEqual(codexPlatform('win32', 'arm64'),
    { tag: 'win32-arm64', pkg: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc', exe: 'codex.exe', bundled: 'codex-win-arm64.exe' })
  assert.deepEqual(codexPlatform('darwin', 'arm64'),
    { tag: 'darwin-arm64', pkg: 'codex-darwin-arm64', triple: 'aarch64-apple-darwin', exe: 'codex', bundled: 'codex-mac-arm64' })
  assert.deepEqual(codexPlatform('darwin', 'x64'),
    { tag: 'darwin-x64', pkg: 'codex-darwin-x64', triple: 'x86_64-apple-darwin', exe: 'codex', bundled: 'codex-mac-x64' })
  assert.deepEqual(codexPlatform('linux', 'x64'),
    { tag: 'linux-x64', pkg: 'codex-linux-x64', triple: 'x86_64-unknown-linux-gnu', exe: 'codex', bundled: 'codex-linux-x64' })
  assert.deepEqual(codexPlatform('linux', 'arm64'),
    { tag: 'linux-arm64', pkg: 'codex-linux-arm64', triple: 'aarch64-unknown-linux-gnu', exe: 'codex', bundled: 'codex-linux-arm64' })
})

test('a platform Codex does not build for has none', () => {
  assert.equal(codexPlatform('win32', 'ia32'), null)
  assert.equal(codexPlatform('freebsd', 'x64'), null)
})
