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
 * An earlier JobScan kept its own Codex up to date in <userData>/codex
 * (downloaded and health-checked, marked `.verified`). That copy is never
 * updated again, but it is not thrown away either: when it is newer than the
 * user's own Codex -- or the user has none -- it stays in use, so upgrading
 * JobScan never moves anyone to an older Codex or leaves them with none.
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
  /** <userData>/codex: the copies an earlier JobScan downloaded and verified. */
  legacyRoot?: string
  /** Versions that earlier JobScan found broken (its codexRejectedVersions). */
  legacyRejected?: readonly string[]
}

export interface LocatedCodex {
  path: string
  /** e.g. "0.153.4"; null when it cannot be read (a Homebrew build, a custom path). */
  version: string | null
  /** setting / env: chosen by the user; own: their install; legacy: an earlier JobScan's copy. */
  source: 'setting' | 'env' | 'own' | 'legacy'
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

/** Numeric-segment compare: "0.153.4" sorts above "0.99.0". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(n => (/^\d+$/.test(n) ? Number(n) : n))
  const pb = b.split(/[.-]/).map(n => (/^\d+$/.test(n) ? Number(n) : n))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

/**
 * The Codex version a binary belongs to, read from the nearest npm
 * package.json above it ("0.153.4-win32-x64" -> "0.153.4"), or null.
 */
export function codexVersionOf(binary: string): string | null {
  let dir = path.dirname(binary)
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (/^@openai\/codex(-|$)/.test(String(pkg.name ?? '')) && pkg.version) return String(pkg.version).replace(/-[a-z].*$/i, '')
    } catch { /* not here */ }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

/**
 * The newest copy an earlier JobScan downloaded and verified:
 * <root>/<version>/package/vendor/<triple>/{bin,codex}/codex[.exe], used only
 * with <version>/.verified present and neither a .rejected marker nor the
 * version on the rejected list. The same choice that JobScan made.
 */
export function legacyManagedCodex(root: string, platform: string, arch: string, rejected: readonly string[] = []): { path: string; version: string } | null {
  const plat = codexPlatform(platform, arch)
  if (!plat) return null
  let names: string[] = []
  try { names = fs.readdirSync(root) } catch { return null }
  const usable = names
    .filter(v => isFile(path.join(root, v, '.verified')) && !isFile(path.join(root, v, '.rejected')) && !rejected.includes(v))
    .sort(compareVersions)
    .reverse()
  for (const version of usable) {
    for (const sub of ['bin', 'codex']) {
      const exe = path.join(root, version, 'package', 'vendor', plat.triple, sub, plat.exe)
      if (isFile(exe)) return { path: exe, version }
    }
  }
  return null
}

const pkgUnder = (prefix: string, platform: string): string =>
  platform === 'win32'
    ? path.join(prefix, 'node_modules', '@openai', 'codex')
    : path.join(prefix, 'lib', 'node_modules', '@openai', 'codex')

/** The Codex to run, with where it came from; null when there is none. */
export function locateCodex(o: LocateOptions): LocatedCodex | null {
  const asBinary = (file: string): string | null => {
    if (!isFile(file)) return null
    const pkg = packageOfLauncher(file)
    if (pkg) return binaryFromPackage(pkg, o.platform, o.arch)
    if (/\.(cmd|ps1|bat)$/i.test(file)) return null
    return file
  }

  // A path the user gave wins outright.
  const given: Array<[string, 'setting' | 'env']> = [[o.setting.trim(), 'setting'], [(o.env['JOBSCAN_CODEX_BIN'] ?? '').trim(), 'env']]
  for (const [file, source] of given) {
    if (!file) continue
    const b = asBinary(file)
    if (b) return { path: b, version: codexVersionOf(b), source }
  }

  const own = findOwnCodex(o, asBinary)
  const legacy = o.legacyRoot ? legacyManagedCodex(o.legacyRoot, o.platform, o.arch, o.legacyRejected ?? []) : null
  const ownVersion = own ? codexVersionOf(own) : null
  if (own && legacy && ownVersion && compareVersions(legacy.version, ownVersion) > 0) {
    return { path: legacy.path, version: legacy.version, source: 'legacy' }
  }
  if (own) return { path: own, version: ownVersion, source: 'own' }
  if (legacy) return { path: legacy.path, version: legacy.version, source: 'legacy' }
  return null
}

/** The path of the Codex to run, or null (see locateCodex). */
export function locateUserCodex(o: LocateOptions): string | null {
  return locateCodex(o)?.path ?? null
}

/** The user's own install: npm's global packages, then a `codex` on PATH. */
function findOwnCodex(o: LocateOptions, asBinary: (file: string) => string | null): string | null {
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
