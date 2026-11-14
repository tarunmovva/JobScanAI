import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import fsPromises from 'fs/promises'
import https from 'https'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import store from './state-store'
import { codexPlatform } from './codex-platform'
import { probeAppServer as probeCodexAppServer, type ProbeResult } from './codex-probe'
import { pickManagedVersion } from './codex-health'
import { warmBinary } from './binary-warmup'

/**
 * Keeps the Codex CLI current instead of frozen at whatever was vendored at
 * build time.
 *
 * The bundled binary is a floor, not the answer: 0.128 could not decode the
 * model list the API now returns (`unknown variant "max"` — a reasoning level
 * added after that release), so it silently served its own compiled-in list and
 * the app's model picker showed five stale models. Pinning harder only moves
 * when that happens next.
 *
 * Flow: read the latest version off the npm registry, download the platform
 * tarball, verify it against the registry's own sha512, extract, and — before
 * anything uses it — prove the new binary on BOTH surfaces the app drives:
 * app-server JSON-RPC (codex-client.ts) and `codex exec` with the recovery flag
 * set (agent_recovery.py). A binary that passes only the first would break form
 * recovery, and only when a fill fails, which is the worst possible time to find
 * out. Only a binary that passes both is promoted.
 */

const REGISTRY = 'https://registry.npmjs.org'
const PACKAGE = '@openai/codex'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const HEALTH_TIMEOUT_MS = 120_000
const KEEP_VERSIONS = 2

export interface CodexUpdateStatus {
  managedVersion: string | null     // version in userData, health-checked
  managedPath: string | null
  bundledPath: string | null
  latestVersion: string | null
  checkedAt: string
  state: 'idle' | 'checking' | 'downloading' | 'verifying' | 'health-checking' | 'up-to-date' | 'updated' | 'failed' | 'skipped'
  message: string
}

let _status: CodexUpdateStatus = {
  managedVersion: null, managedPath: null, bundledPath: null,
  latestVersion: null, checkedAt: '', state: 'idle', message: '',
}
let _inFlight: Promise<CodexUpdateStatus> | null = null

// Injected rather than imported: pipeline.ts -> codex-client.ts -> codex-updater.ts
// would close a cycle. main.ts wires isPipelineActive in on boot.
let _isBusy: (() => boolean) | null = null

export function setBusyCheck(fn: () => boolean): void {
  _isBusy = fn
}

export function getUpdateStatus(): CodexUpdateStatus {
  return {
    ..._status,
    managedVersion: currentManagedVersion(),
    managedPath: resolveManagedBinary(),
    bundledPath: bundledBinaryPath(),
  }
}

/**
 * The build-time binary in resources/bin. Resolved here rather than imported
 * from codex-client to avoid a cycle (codex-client depends on this module).
 */
function bundledBinaryPath(): string | null {
  const name = codexPlatform(process.platform, process.arch)?.bundled
  if (!name) return null
  const resPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    ?? path.join(__dirname, '..', '..', 'resources')
  const candidate = path.join(resPath, 'bin', name)
  try { return fs.existsSync(candidate) ? candidate : null } catch { return null }
}

// ── Platform ─────────────────────────────────────────────────────────────────

// One table with the client (codex-platform.ts): ARM Windows included.

/** npm publishes per-platform builds as version tags: 0.153.4-win32-x64. */
function platformTag(): string | null {
  return codexPlatform(process.platform, process.arch)?.tag ?? null
}

function vendorTriple(): string | null {
  return codexPlatform(process.platform, process.arch)?.triple ?? null
}

const exeName = (): string => codexPlatform(process.platform, process.arch)?.exe ?? (process.platform === 'win32' ? 'codex.exe' : 'codex')

// ── Managed install layout ───────────────────────────────────────────────────
//
//   <userData>/codex/<version>/package/vendor/<triple>/bin/codex[.exe]
//   <userData>/codex/<version>/.verified   ← written only after both probes pass

function managedRoot(): string {
  return path.join(app.getPath('userData'), 'codex')
}

/** The exe inside an extracted tarball. 0.153 moved it from codex/ to bin/. */
function exeInside(versionDir: string): string | null {
  const triple = vendorTriple()
  if (!triple) return null
  for (const sub of ['bin', 'codex']) {
    const candidate = path.join(versionDir, 'package', 'vendor', triple, sub, exeName())
    try { if (fs.existsSync(candidate)) return candidate } catch { /* keep probing */ }
  }
  return null
}

function verifiedVersions(): string[] {
  try {
    return fs.readdirSync(managedRoot())
      .filter(name => {
        try { return fs.existsSync(path.join(managedRoot(), name, '.verified')) } catch { return false }
      })
      .sort(compareVersions)
      .reverse()
  } catch { return [] }
}

/** Numeric-segment compare — "0.153.4" must sort above "0.99.0". */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(n => (/^\d+$/.test(n) ? Number(n) : n))
  const pb = b.split(/[.-]/).map(n => (/^\d+$/.test(n) ? Number(n) : n))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

/**
 * Versions found broken for this app -- a protocol failure before promotion
 * or after it (rollback). Never used or downloaded again; a newer release
 * replaces them. Kept in the store, so pruning a version's directory does
 * not forget it.
 */
function rejectedVersions(): string[] {
  const v = store.get('codexRejectedVersions') as unknown
  return Array.isArray(v) ? v.map(String) : []
}

function rejectVersion(version: string, detail: string): void {
  const all = rejectedVersions()
  if (!all.includes(version)) store.set('codexRejectedVersions', [...all, version].slice(-20) as never)
  try {
    fs.writeFileSync(path.join(managedRoot(), version, '.rejected'),
      JSON.stringify({ version, detail, at: new Date().toISOString() }), 'utf-8')
  } catch { /* the store remembers it */ }
}

/** The managed versions that may be used, newest first. */
function usableVersions(): string[] {
  const no = rejectedVersions()
  return verifiedVersions().filter(v => !no.includes(v))
}

export function currentManagedVersion(): string | null {
  return pickManagedVersion(verifiedVersions(), rejectedVersions())
}

/**
 * Path to the managed binary, or null. Checked ahead of the bundled one by
 * codex-client.ts — it is only ever populated by a health-checked install.
 */
export function resolveManagedBinary(): string | null {
  for (const version of usableVersions()) {
    const exe = exeInside(path.join(managedRoot(), version))
    if (exe) return exe
  }
  return null
}

// ── Registry ─────────────────────────────────────────────────────────────────

function getJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { accept: 'application/json' } }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return getJson(res.headers.location).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`registry ${res.statusCode} for ${url}`)) }
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c as Buffer))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) }
        catch (e) { reject(new Error(`registry JSON parse failed: ${String(e)}`)) }
      })
    })
    req.setTimeout(30_000, () => req.destroy(new Error('registry request timed out')))
    req.on('error', reject)
  })
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const req = https.get(url, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); file.close()
        return download(res.headers.location, dest).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download ${res.statusCode} for ${url}`)) }
      res.pipe(file)
      file.on('finish', () => file.close(err => (err ? reject(err) : resolve())))
    })
    req.setTimeout(600_000, () => req.destroy(new Error('download timed out')))
    req.on('error', err => { file.close(); reject(err) })
  })
}

async function sha512Base64(file: string): Promise<string> {
  const hash = crypto.createHash('sha512')
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on('data', d => hash.update(d)).on('end', resolve).on('error', reject)
  })
  return hash.digest('base64')
}

/**
 * Extract via the system tar. Windows has bsdtar in System32 since 1803 and
 * macOS/Linux always have one — cheaper than pulling a tar implementation into
 * the bundle. GNU tar on Windows reads "C:" as a remote host, so prefer the
 * System32 binary explicitly there.
 */
function extractTarball(tgz: string, dest: string): Promise<void> {
  const tarBin = process.platform === 'win32'
    ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
  return new Promise((resolve, reject) => {
    const child = spawn(tarBin, ['-xzf', tgz, '-C', dest], { windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', b => { stderr += String(b) })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.slice(0, 200)}`))))
  })
}

// ── Health probes ────────────────────────────────────────────────────────────

/**
 * Surface 1: app-server JSON-RPC, every call codex-client.ts makes
 * (codex-probe.ts): initialize, model/list and -- with `turn` -- the usage
 * limits and one tiny real turn, sent exactly as real runs send it. The new
 * binary is first started once off the main thread: its antivirus scan
 * froze the window for 11 s when this thread started it cold.
 */
async function probeAppServer(exe: string, turn: boolean): Promise<ProbeResult> {
  await warmBinary(exe)
  return probeCodexAppServer({ command: exe, args: ['app-server'], loginStatus: { command: exe, args: ['login', 'status'] } }, {
    turn,
    savedModel: String(store.get('codexModel') ?? '').trim(),
    cwd: app.getAppPath(),
    timeoutMs: HEALTH_TIMEOUT_MS,
  })
}

/**
 * Surface 2: `codex exec` with the exact flags agent_recovery.py passes. This is
 * the probe that matters most — 0.125 kept app-server working while moving MCP
 * tools behind a tool_search step, which broke recovery silently.
 */
async function probeExec(exe: string): Promise<{ ok: boolean; error?: string }> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'codex-probe-'))
  try {
    const schemaPath = path.join(dir, 'schema.json')
    const outPath = path.join(dir, 'verdict.json')
    await fsPromises.writeFile(schemaPath, JSON.stringify({
      type: 'object',
      properties: { outcome: { type: 'string' } },
      required: ['outcome'],
      additionalProperties: false,
    }), 'utf-8')
    const args = [
      'exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--json',
      '--sandbox', 'read-only', '-C', dir,
      '-c', 'features.tool_search=false',
      '-c', 'model_reasoning_effort="medium"',
      '--output-schema', schemaPath, '-o', outPath, '-',
    ]
    const code = await new Promise<number | null>(resolve => {
      const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const timer = setTimeout(() => { try { child.kill() } catch { /* best effort */ } }, HEALTH_TIMEOUT_MS)
      child.stdout?.resume()
      child.stderr?.resume()
      child.on('error', () => { clearTimeout(timer); resolve(-1) })
      child.on('close', c => { clearTimeout(timer); resolve(c) })
      try {
        child.stdin!.write('Return JSON matching the schema with outcome set to "ok". Do not use any tools.')
        child.stdin!.end()
      } catch { /* closed */ }
    })
    try {
      const verdict = JSON.parse(await fsPromises.readFile(outPath, 'utf-8'))
      if (verdict && typeof verdict === 'object') return { ok: true }
      return { ok: false, error: `exec wrote an unusable verdict (exit ${code})` }
    } catch {
      return { ok: false, error: `exec wrote no verdict file (exit ${code})` }
    }
  } finally {
    fsPromises.rm(dir, { recursive: true, force: true }).catch(() => { /* temp dir */ })
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────

async function pruneOldVersions(keep: string[]): Promise<void> {
  try {
    for (const name of await fsPromises.readdir(managedRoot())) {
      if (keep.includes(name)) continue
      await fsPromises.rm(path.join(managedRoot(), name), { recursive: true, force: true })
    }
  } catch { /* nothing to prune */ }
}

/**
 * A saved model that the API no longer offers is not a cosmetic problem: every
 * turn fails with `400 The '<id>' model is not supported`, which takes the whole
 * pipeline down. Model ids come and go, so reset to Auto rather than leave the
 * app wedged. Returns the id that was cleared, or null.
 */
export function reconcileSavedModel(availableIds: string[]): string | null {
  const saved = String(store.get('codexModel') ?? '').trim()
  if (!saved || availableIds.length === 0 || availableIds.includes(saved)) return null
  store.set('codexModel', '' as never)
  console.warn(`[codex-update] saved model "${saved}" is no longer offered — reset to Auto`)
  return saved
}

/**
 * A promoted version turned out not to speak this app's protocol at run time
 * (codex-health.ts decides what counts): reject it, so the previous verified
 * version -- else the bundled one -- is used from the next call on. Nothing
 * is deleted: a filler may still be running the binary. True when `exe` was
 * a managed version and is now rolled back.
 */
export function reportCodexProtocolFailure(exe: string, detail: string): boolean {
  const root = path.resolve(managedRoot()) + path.sep
  const full = path.resolve(exe)
  if (!full.toLowerCase().startsWith(root.toLowerCase())) return false   // the bundled one: nothing older to go back to
  const version = full.slice(root.length).split(path.sep)[0]
  if (!version || rejectedVersions().includes(version)) return false
  rejectVersion(version, detail)
  const now = currentManagedVersion()
  console.warn(`[codex-update] ${version} rolled back after a protocol error (${detail}); now using ${now ?? 'the bundled Codex'}`)
  setStatus({ state: 'failed', message: `Codex ${version} rolled back after a protocol error; now using ${now ?? 'the bundled Codex'}` })
  return true
}

function setStatus(patch: Partial<CodexUpdateStatus>): void {
  _status = { ..._status, ...patch }
}

/**
 * Check the registry and, when a newer version exists, install and promote it.
 *
 * `force` bypasses the once-a-day throttle (the Settings button). Never runs
 * while a pipeline is active: a swap mid-run would split that run across two
 * binaries, and the app submits real applications.
 */
export async function ensureLatestCodex(opts: { force?: boolean } = {}): Promise<CodexUpdateStatus> {
  if (_inFlight) return _inFlight
  _inFlight = (async (): Promise<CodexUpdateStatus> => {
    const tag = platformTag()
    if (!tag) {
      setStatus({ state: 'skipped', message: `no codex build for ${process.platform}/${process.arch}` })
      return getUpdateStatus()
    }
    if (!opts.force && store.get('codexAutoUpdate') === false) {
      setStatus({ state: 'skipped', message: 'auto-update disabled in Settings' })
      return getUpdateStatus()
    }
    if (_isBusy?.()) {
      // A swap mid-run would split one pipeline across two binaries, and this
      // app submits real job applications. Wait for the next check.
      setStatus({ state: 'skipped', message: 'pipeline running — deferred' })
      return getUpdateStatus()
    }
    const lastChecked = Date.parse((store.get('codexUpdateCheckedAt') as string) || '') || 0
    if (!opts.force && Date.now() - lastChecked < CHECK_INTERVAL_MS) {
      setStatus({ state: 'up-to-date', message: 'checked recently' })
      return getUpdateStatus()
    }

    try {
      setStatus({ state: 'checking', message: 'checking npm for a newer Codex' })
      const meta = await getJson(`${REGISTRY}/${encodeURIComponent(PACKAGE)}/latest`)
      const latest = String(meta['version'] ?? '').trim()
      if (!latest) throw new Error('registry returned no version')
      store.set('codexUpdateCheckedAt', new Date().toISOString() as never)
      setStatus({ latestVersion: latest, checkedAt: new Date().toISOString() })

      if (currentManagedVersion() === latest) {
        setStatus({ state: 'up-to-date', message: `Codex ${latest} already installed` })
        return getUpdateStatus()
      }
      if (rejectedVersions().includes(latest)) {
        setStatus({ state: 'skipped', message: `Codex ${latest} does not work with this app; waiting for a newer release` })
        return getUpdateStatus()
      }

      const platformMeta = await getJson(`${REGISTRY}/${encodeURIComponent(PACKAGE)}/${latest}-${tag}`)
      const dist = platformMeta['dist'] as { tarball?: string; integrity?: string } | undefined
      if (!dist?.tarball) throw new Error(`no tarball for ${latest}-${tag}`)

      const workRoot = managedRoot()
      await fsPromises.mkdir(workRoot, { recursive: true })
      const tgz = path.join(workRoot, `${latest}-${tag}.tgz`)
      setStatus({ state: 'downloading', message: `downloading Codex ${latest}` })
      await download(dist.tarball, tgz)

      if (dist.integrity?.startsWith('sha512-')) {
        setStatus({ state: 'verifying', message: 'verifying download' })
        const actual = await sha512Base64(tgz)
        if (`sha512-${actual}` !== dist.integrity) {
          await fsPromises.rm(tgz, { force: true })
          throw new Error('integrity mismatch — download discarded')
        }
      }

      const versionDir = path.join(workRoot, latest)
      await fsPromises.rm(versionDir, { recursive: true, force: true })
      await fsPromises.mkdir(versionDir, { recursive: true })
      await extractTarball(tgz, versionDir)
      await fsPromises.rm(tgz, { force: true })

      const exe = exeInside(versionDir)
      if (!exe) throw new Error('extracted tarball has no codex binary in vendor/<triple>/{bin,codex}')
      if (process.platform !== 'win32') await fsPromises.chmod(exe, 0o755)

      setStatus({ state: 'health-checking', message: `verifying Codex ${latest}` })
      const rpc = await probeAppServer(exe, true)
      if (rpc.verdict.kind === 'protocol') {
        // It does not speak this app's protocol: never use it, never fetch it again.
        rejectVersion(latest, rpc.verdict.detail)
        console.warn(`[codex-update] ${latest} rejected: ${rpc.verdict.detail}`)
        setStatus({ state: 'failed', message: `Codex ${latest} does not work with this app (${rpc.verdict.detail}); keeping the current version` })
        return getUpdateStatus()
      }
      if (rpc.verdict.kind === 'inconclusive') {
        // Signed out, a usage limit, the network: nothing known about the version. Try again later.
        setStatus({ state: 'skipped', message: `Codex ${latest} downloaded; its check is deferred: ${rpc.verdict.detail}` })
        return getUpdateStatus()
      }
      const exec = await probeExec(exe)
      if (!exec.ok) throw new Error(`codex exec probe failed: ${exec.error}`)

      // Re-check: the download and probes take ~15s, long enough for a run to
      // have started. Promoting now would swap the binary underneath it.
      if (_isBusy?.()) {
        setStatus({ state: 'skipped', message: `Codex ${latest} downloaded — promoting after the current run` })
        return getUpdateStatus()
      }

      // Only now is it allowed to be picked up.
      await fsPromises.writeFile(path.join(versionDir, '.verified'),
        JSON.stringify({ version: latest, models: rpc.ids.length, at: new Date().toISOString() }), 'utf-8')
      store.set('codexManagedVersion', latest as never)
      await pruneOldVersions(usableVersions().slice(0, KEEP_VERSIONS))

      const cleared = reconcileSavedModel(rpc.ids)
      setStatus({
        state: 'updated',
        message: `Codex ${latest} installed (${rpc.ids.length} models`
          + (rpc.turnChecked ? '' : '; the test turn was skipped: no usage limits to read') + ')'
          + (cleared ? ` — saved model "${cleared}" is no longer offered, switched to Auto` : ''),
      })
      console.log(`[codex-update] promoted ${latest} — ${rpc.ids.length} models`)
      return getUpdateStatus()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.warn('[codex-update] failed:', message)
      setStatus({ state: 'failed', message })
      return getUpdateStatus()
    }
  })().finally(() => { _inFlight = null })
  return _inFlight
}

/**
 * Fire-and-forget check on boot. Deliberately does not block startup or throw:
 * a failed update leaves the bundled binary in place, which is exactly the
 * behaviour before this module existed.
 */
export function scheduleCodexUpdateCheck(delayMs = 5_000): void {
  // The e2e suite launches the app once per test; without this every launch
  // would hit the registry and could start a ~140 MB download.
  if (process.env['E2E_TEST'] === '1') {
    setStatus({ state: 'skipped', message: 'disabled in e2e' })
    return
  }
  setTimeout(() => {
    ensureLatestCodex()
      .then(() => verifySavedModelStillOffered())
      .catch(() => { /* status carries the reason */ })
  }, delayMs).unref?.()
}

/**
 * A model can be withdrawn server-side without any change to the Codex binary.
 * `ensureLatestCodex` only reconciles after it PROMOTES a new version, so a
 * withdrawn model survived indefinitely on an up-to-date install: every turn
 * then failed with `400 ... model is not supported`, which surfaces as the
 * whole pipeline stalling rather than as anything about a model.
 *
 * Observed for real: a model disappeared from model/list while it was still
 * the saved model.
 */
export async function verifySavedModelStillOffered(): Promise<string | null> {
  if (!String(store.get('codexModel') ?? '').trim()) return null
  // Probing spawns an app-server; never do that while a run is submitting.
  if (_isBusy?.()) return null
  try {
    // Resolved locally: importing codex-client here would close the cycle
    // pipeline -> codex-client -> codex-updater.
    const exe = resolveManagedBinary() ?? bundledBinaryPath()
    if (!exe) return null
    const rpc = await probeAppServer(exe, false)
    if (rpc.verdict.kind !== 'ok' || rpc.ids.length === 0) return null
    return reconcileSavedModel(rpc.ids)
  } catch {
    return null
  }
}
