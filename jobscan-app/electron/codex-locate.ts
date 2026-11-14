/**
 * Finding the user's own Codex CLI, now that JobScan no longer ships one.
 *
 * npm installs Codex as a small JS launcher (`@openai/codex`, bin/codex.js)
 * plus a native binary in a per-platform package, nested under it or beside
 * it depending on npm's layout:
 *   <prefix>/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/<triple>/bin/codex.exe
 * The launcher re-spawns that binary without windowsHide (a console window
 * flashes on Windows), and on Windows the PATH entry is a .cmd shim that
 * needs a shell -- so the native binary is resolved directly, the way
 * codex.js itself does it (require.resolve from the launcher's package),
 * and npm is never run to ask where its prefix is.
 *
 * Order: the Settings path (codexPath), JOBSCAN_CODEX_BIN, then the npm
 * install found from known prefixes and from a `codex` on PATH; a native
 * `codex` on PATH that is not npm's launcher (Homebrew) is used as is.
 *
 * Pure Node (no Electron): unit-tested with fixture folders.
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { codexPlatform } from './codex-platform'

type Env = Record<string, string | undefined>

export interface LocateOptions {
  setting: string
  env: Env
  platform: string
  arch: string
  homedir: string
}

const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory() } catch { return false } }

/** The native binary inside an `@openai/codex` package, nested or beside it. */
export function binaryFromPackage(pkgRoot: string, platform: string, arch: string): string | null {
  const plat = codexPlatform(platform, arch)
  const manifest = path.join(pkgRoot, 'package.json')
  if (!plat || !isFile(manifest)) return null
  let platDir: string | null = null
  try {
    platDir = path.dirname(createRequire(manifest).resolve(`@openai/${plat.pkg}/package.json`))
  } catch {
    return null
  }
  for (const sub of ['bin', 'codex']) {
    const exe = path.join(platDir, 'vendor', plat.triple, sub, plat.exe)
    if (isFile(exe)) return exe
  }
  return null
}

/** The `@openai/codex` package a launcher script belongs to, if any. */
function packageOfLauncher(file: string): string | null {
  let real = file
  try { real = fs.realpathSync(file) } catch { /* as given */ }
  if (!/\.(c|m)?js$/i.test(real)) return null
  const root = path.dirname(path.dirname(real))           // <pkg>/bin/codex.js
  try {
    const name = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: string }).name
    return name === '@openai/codex' ? root : null
  } catch { return null }
}

function npmPrefixes(o: LocateOptions): string[] {
  const out: string[] = []
  if (o.platform === 'win32') {
    if (o.env['APPDATA']) out.push(path.join(o.env['APPDATA'], 'npm'))
    if (o.env['LOCALAPPDATA']) out.push(path.join(o.env['LOCALAPPDATA'], 'npm'))
  } else {
    out.push('/opt/homebrew', '/usr/local', path.join(o.homedir, '.npm-global'), path.join(o.homedir, '.local'))
  }
  return out
}

const pkgUnder = (prefix: string, platform: string): string =>
  platform === 'win32'
    ? path.join(prefix, 'node_modules', '@openai', 'codex')
    : path.join(prefix, 'lib', 'node_modules', '@openai', 'codex')

export function locateUserCodex(o: LocateOptions): string | null {
  const asBinary = (file: string): string | null => {
    if (!isFile(file)) return null
    const pkg = packageOfLauncher(file)
    if (pkg) return binaryFromPackage(pkg, o.platform, o.arch)
    if (/\.(cmd|ps1|bat)$/i.test(file)) return null
    return file
  }

  for (const given of [o.setting.trim(), (o.env['JOBSCAN_CODEX_BIN'] ?? '').trim()]) {
    if (given) { const b = asBinary(given); if (b) return b }
  }

  for (const prefix of npmPrefixes(o)) {
    const pkg = pkgUnder(prefix, o.platform)
    if (isDir(pkg)) { const b = binaryFromPackage(pkg, o.platform, o.arch); if (b) return b }
  }

  const pathVar = o.env['PATH'] ?? o.env['Path'] ?? ''
  for (const dir of pathVar.split(o.platform === 'win32' ? ';' : ':').map(s => s.trim()).filter(Boolean)) {
    if (o.platform === 'win32') {
      // npm's shims sit in the prefix itself: <prefix>\codex.cmd + <prefix>\node_modules\@openai\codex
      if (isFile(path.join(dir, 'codex.cmd')) || isFile(path.join(dir, 'codex.ps1'))) {
        const pkg = pkgUnder(dir, 'win32')
        if (isDir(pkg)) { const b = binaryFromPackage(pkg, o.platform, o.arch); if (b) return b }
      }
      const exe = path.join(dir, 'codex.exe')
      if (isFile(exe)) return exe
    } else {
      const b = asBinary(path.join(dir, 'codex'))
      if (b) return b
    }
  }
  return null
}
