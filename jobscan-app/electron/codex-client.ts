import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import readline from 'readline'
import fs from 'fs'
import os from 'os'
import { app } from 'electron'
import store from './state-store'
import { locateUserCodex } from './codex-locate'
import { threadStartParams, turnStartParams } from './codex-requests'
import { CORE_METHODS, isProtocolError, createStartupCrashCounter } from './codex-health'
import { warmBinary } from './binary-warmup'
import { RATE_LIMITS_READ, mapRateLimits, loginStatusFrom } from './codex-account'
import { codexHome, e2eCodexCommand } from './codex-home'
import { EarlyTurnEvents } from './turn-buffer'
import type { CodexModelOption, RateLimitSnapshot } from '../src/types'

// File-probe codex auth so boot routing doesn't spawn a codex.exe just to
// check login. Imperfect (file may be expired) but catches the common
// "user logged out" case cheaply; AuthScreen's auth:status probe self-heals
// false negatives.
export function checkAuth(): boolean {
  try {
    const authPath = path.join(codexHome(), 'auth.json')
    if (!fs.existsSync(authPath)) return false
    const stat = fs.statSync(authPath)
    return stat.size > 0
  } catch { return false }
}

// ── Constants ─────────────────────────────────────────────────────────────────
const RPC_TIMEOUT_MS = 60_000    // 60s per RPC call (initialize may replay WAL on first open)
const TURN_TIMEOUT_MS = 180_000  // 3min per AI turn
const SHUTDOWN_GRACE_MS = 8_000  // wait for codex to checkpoint WAL + exit cleanly

// ── Binary resolution ────────────────────────────────────────────────────────
//
// JobScan no longer ships Codex: it runs the user's own Codex CLI, found by
// codex-locate.ts (the Settings path, then the npm install). The native
// binary is spawned directly, never the codex.js launcher or the Windows
// .cmd shim -- the launcher re-spawns the binary without windowsHide, which
// opens a console window we cannot suppress.

export const CODEX_NOT_FOUND =
  'Codex CLI was not found. Install it with: npm install -g @openai/codex -- or switch to your Claude Code in Settings.'

function resolveCodexNativeBinary(): string | null {
  return locateUserCodex({
    setting: String(store.get('codexPath') ?? ''),
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    homedir: os.homedir(),
  })
}

/**
 * The codex binary this app will actually run, or null when none is
 * installed. Exported so the Go/Python side runs the SAME one via
 * JOB_AUTOMATOR_CODEX_BIN -- form repair on a different Codex than the
 * app-server side would be two versions to keep working.
 */
export function getCodexBinaryPath(): string | null {
  // Under E2E_TEST the Python side must not find a real Codex through us.
  if (e2eCodexCommand()) return null
  return resolveCodexNativeBinary()
}

export function buildSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (process.platform !== 'win32' || !process.env['APPDATA']) return env

  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  const existing = env[pathKey] ?? ''
  const parts = existing.split(';').map((s: string) => s.trim()).filter(Boolean)
  const seen = new Set(parts.map((s: string) => s.toLowerCase()))

  const npmBin = path.join(process.env['APPDATA']!, 'npm')
  if (!seen.has(npmBin.toLowerCase())) parts.unshift(npmBin)

  const nodeBin = path.dirname(process.execPath)
  if (!seen.has(nodeBin.toLowerCase())) parts.unshift(nodeBin)

  const merged = parts.join(';')
  env[pathKey] = env['PATH'] = env['Path'] = merged
  return env
}

export interface CodexSpawnSpec {
  command: string
  args: string[]
  shell: boolean
}

/** How to start Codex with `cliArgs`. Throws CODEX_NOT_FOUND when none is installed. */
export function getCodexSpawnSpec(cliArgs: string[]): CodexSpawnSpec {
  // Tests: a stand-in app-server, or nothing at all — never the user's Codex.
  const e2e = e2eCodexCommand()
  if (e2e) return { command: e2e.command, args: [...e2e.args, ...cliArgs], shell: false }
  const native = resolveCodexNativeBinary()
  if (!native) throw new Error(CODEX_NOT_FOUND)
  return { command: native, args: cliArgs, shell: false }
}

// ── Pending state ─────────────────────────────────────────────────────────────
interface PendingRequest {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timeout: ReturnType<typeof setTimeout>
  method: string
}

interface PendingTurn {
  text: string
  resolve: (text: string) => void
  reject: (e: Error) => void
  onToken?: (t: string) => void
  timeout: ReturnType<typeof setTimeout>
}

// Normalize one model/list RPC response into dropdown options. The RPC item
// field is `id` in practice (existing logs read `.id`), but codex's own data
// (~/.codex/models_cache.json) uses `slug`/`display_name` — accept both so a
// shape drift degrades to an empty list instead of breaking. Nothing in the
// turn path depends on this parse succeeding.
function parseModelListResult(result: unknown): CodexModelOption[] {
  const r = result as { models?: unknown; data?: unknown } | null | undefined
  const raw = Array.isArray(r?.models) ? r.models : Array.isArray(r?.data) ? r.data : []
  const out: CodexModelOption[] = []
  for (const item of raw as Array<Record<string, unknown> | null>) {
    const id = String(item?.['id'] ?? item?.['slug'] ?? item?.['model'] ?? '').trim()
    if (!id) continue
    const label = String(item?.['displayName'] ?? item?.['display_name'] ?? item?.['name'] ?? id).trim() || id
    out.push({ id, label })
  }
  return out
}

// ── Client class ──────────────────────────────────────────────────────────────
class CodexAppServerClient {
  private child: ChildProcess | null = null
  private reader: readline.Interface | null = null
  private nextId = 1
  private pendingRequests: Map<number, PendingRequest> = new Map()
  private pendingTurns: Map<string, PendingTurn> = new Map()
  private earlyTurnEvents = new EarlyTurnEvents()
  private closed = true
  /** The binary this client started (named when it fails the protocol check). */
  private command = ''
  private answeredInit = false
  /** Shut down (cancel, quit, sign-out): this client starts nothing again. */
  private disposed = false

  /** Why this client refuses to start anything, or '' when it may. */
  private refusal(): string {
    if (this.disposed) return 'Codex was shut down'
    return ''
  }

  private startProcess(): void {
    const spec = getCodexSpawnSpec(['app-server'])
    this.command = spec.command
    this.answeredInit = false
    const child = spawn(spec.command, spec.args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: spec.shell,
      env: buildSpawnEnv(),
    })
    this.child = child
    this.closed = false

    // Every handler answers for its own process only: a process this client
    // has moved on from must not fail, or count against, the one after it.
    const reader = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity })
    this.reader = reader
    reader.on('line', (line: string) => { if (this.child === child) this.handleLine(line) })

    child.stderr?.on('data', (chunk: Buffer) => {
      console.error('[codex-server]', chunk.toString().trim())
    })

    child.on('error', (err: Error) => {
      if (this.child === child) this.handleCrash(new Error(`Codex spawn failed: ${err.message}`))
    })

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child !== child || this.closed) return
      this.handleCrash(new Error(`Codex exited (code=${code ?? 'null'} signal=${signal ?? 'none'})`))
      // Dying before it answers, twice in a row, is the version (codex-health.ts).
      if (!this.answeredInit && startupCrashesFor(this.command).crashed()) {
        this.protocolFailure(`app-server exits (code ${code ?? 'null'}) before it answers initialize`)
      }
    })
  }

  private handleCrash(err: Error): void {
    this.closed = true
    for (const [, req] of this.pendingRequests) { clearTimeout(req.timeout); req.reject(err) }
    for (const [, turn] of this.pendingTurns) { clearTimeout(turn.timeout); turn.reject(err) }
    this.pendingRequests.clear()
    this.pendingTurns.clear()
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(line) as Record<string, unknown> } catch { return }

    if ('id' in msg) {
      const req = this.pendingRequests.get(msg['id'] as number)
      if (req) {
        clearTimeout(req.timeout)
        this.pendingRequests.delete(msg['id'] as number)
        if (msg['error']) {
          if (CORE_METHODS.has(req.method) && isProtocolError(msg['error'])) {
            this.protocolFailure(`${req.method}: ${JSON.stringify(msg['error']).slice(0, 200)}`)
          }
          req.reject(new Error(JSON.stringify(msg['error'])))
        } else req.resolve(msg['result'])
      }
      return
    }

    if (typeof msg['method'] === 'string') {
      this.handleNotification(msg['method'], (msg['params'] ?? {}) as Record<string, unknown>)
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'item/agentMessage/delta') {
      const turnId = String(params['turnId'] ?? '')
      const delta = String(params['delta'] ?? '')
      const turn = this.pendingTurns.get(turnId)
      // Not registered yet: it may have come in the same chunk as the
      // turn/start reply. runTurn claims it as soon as it learns the id.
      if (!turn) { if (turnId) this.earlyTurnEvents.delta(turnId, delta); return }
      turn.text += delta
      turn.onToken?.(delta)
    }

    if (method === 'turn/completed') {
      // turn/completed uses nested: params.turn.id and params.turn.status
      const turnObj = params['turn'] as Record<string, unknown> | undefined
      const turnId = turnObj?.['id'] as string | undefined
      if (!turnId) return
      const status = String(turnObj?.['status'] ?? '')
      const errObj = turnObj?.['error'] as Record<string, unknown> | undefined
      const turn = this.pendingTurns.get(turnId)
      if (!turn) { this.earlyTurnEvents.completed(turnId, { status, error: errObj }); return }
      clearTimeout(turn.timeout)
      this.pendingTurns.delete(turnId)
      this.settleTurn(turn, status, errObj)
    }
  }

  private settleTurn(
    turn: Pick<PendingTurn, 'text' | 'resolve' | 'reject'>,
    status: string,
    errObj: Record<string, unknown> | undefined,
  ): void {
    if (status === 'failed') {
      // Capture actual error from params.turn.error (same as testapp does)
      const errMsg = String(errObj?.['message'] ?? 'Codex turn failed with no message')
      const errCode = errObj?.['code'] ?? ''
      console.error('[codex] turn failed:', errMsg, errCode ? `(code: ${errCode})` : '')
      turn.reject(new Error(`Codex: ${errMsg}`))
    } else {
      // 'completed', 'interrupted', or any other status → resolve with text accumulated
      turn.resolve(turn.text)
    }
  }

  private sendRequest(method: string, params?: unknown, restarted = false): Promise<unknown> {
    // A call already in flight when its client was shut down must not start
    // a process of its own: nothing would own it.
    const no = this.refusal()
    if (no) return Promise.reject(new Error(no))
    if (!this.child || this.closed) {
      // A crashed process is replaced through initialize, never raw (a raw
      // one answers "Not initialized") -- and only once per call.
      if (method !== 'initialize') {
        if (restarted) return Promise.reject(new Error(`Codex exited again before ${method}`))
        return this.ensureInitialized().then(() => this.sendRequest(method, params, true))
      }
      this.startProcess()
    }
    const id = this.nextId++
    const payload = params !== undefined
      ? { jsonrpc: '2.0', id, method, params }
      : { jsonrpc: '2.0', id, method }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Codex RPC timeout: ${method}`))
      }, RPC_TIMEOUT_MS)

      this.pendingRequests.set(id, { resolve, reject, timeout, method })

      try {
        this.child!.stdin!.write(JSON.stringify(payload) + '\n')
      } catch (err) {
        clearTimeout(timeout)
        this.pendingRequests.delete(id)
        reject(new Error(`Failed to write to Codex stdin (${method}): ${String(err)}`))
      }
    })
  }

  private sendNotification(method: string, params?: unknown): void {
    const payload = params !== undefined
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', method }
    try { this.child!.stdin!.write(JSON.stringify(payload) + '\n') } catch { /* best effort */ }
  }

  private resolvedModel: string | null = null
  /** The model "Auto" resolved to (the first the account lists); null before init. */
  get autoModel(): string | null { return this.resolvedModel }
  private availableModels: CodexModelOption[] = []
  private initPromise: Promise<void> | null = null

  // Single-flight init. initialize() unconditionally spawns a fresh process,
  // and an orphaned old child's close handler would fire handleCrash and
  // reject the NEW child's pending requests — so concurrent triggers (first
  // pipeline turn racing a Settings model-list fetch) must join one init.
  private ensureInitialized(): Promise<void> {
    const no = this.refusal()
    if (no) return Promise.reject(new Error(no))
    if (this.initPromise) return this.initPromise   // join in-flight init (check FIRST)
    if (this.child && !this.closed) return Promise.resolve()
    this.initPromise = this.initialize().finally(() => { this.initPromise = null })
    return this.initPromise
  }

  async initialize(): Promise<void> {
    const no = this.refusal()
    if (no) throw new Error(no)
    // A binary's first start waits for its antivirus scan on THIS thread,
    // which draws the window: start it once in a worker first.
    await warmCodex()
    this.startProcess()
    await this.sendRequest('initialize', {
      clientInfo: { name: 'jobscan-app', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    })
    this.answeredInit = true
    startupCrashesFor(this.command).started()
    this.sendNotification('initialized')

    // Discover available models exactly like testapp (model/list)
    try {
      const result = await this.sendRequest('model/list', { limit: 100 })
      this.availableModels = parseModelListResult(result)
      if (this.availableModels.length > 0) {
        // Pick first available model as the Auto default
        this.resolvedModel = this.availableModels[0].id
        console.log('[codex] available models:', this.availableModels.map(m => m.id).join(', '))
        console.log('[codex] using model:', this.resolvedModel)
      } else {
        console.log('[codex] no models in model/list response, using server default')
      }
    } catch (e) {
      console.warn('[codex] model/list failed, using server default:', String(e))
    }
  }

  // Models discovered at init; retries the RPC once if init-time model/list
  // failed (e.g. user ran `codex login` after the app booted).
  async listModels(): Promise<CodexModelOption[]> {
    await this.ensureInitialized()
    if (this.availableModels.length === 0) {
      const result = await this.sendRequest('model/list', { limit: 100 })
      this.availableModels = parseModelListResult(result)
    }
    return this.availableModels
  }

  /** The account's usage windows. Reads only; spends nothing. */
  async readRateLimits(): Promise<unknown> {
    await this.ensureInitialized()
    return this.sendRequest(RATE_LIMITS_READ)
  }

  async runTurn(
    systemPrompt: string,
    userMessage: string,
    onToken?: (t: string) => void
  ): Promise<string> {
    await this.ensureInitialized()

    // Resolve the model ONCE per call: user-configured (Settings) wins, else
    // the auto-picked first-listed model. Reading the store here (not caching
    // on the client) is what makes a Settings save apply to the next turn
    // without restarting the long-lived app-server or killing in-flight work.
    const configured = String(store.get('codexModel') ?? '').trim()
    const model = configured || this.resolvedModel
    if (configured && configured !== this.resolvedModel) {
      console.log('[codex] using store-configured model:', configured)
    }

    // Fresh ephemeral thread per turn so system prompt context is isolated
    // per task. The same requests the update check sends (codex-requests.ts).
    const threadResult = await this.sendRequest('thread/start',
      threadStartParams({ cwd: app.getAppPath(), model })) as { thread?: { id?: string } }

    const threadId = threadResult?.thread?.id
    if (!threadId) {
      this.protocolFailure('thread/start returned no thread id')
      throw new Error('Codex did not return thread id')
    }

    const turnResult = await this.sendRequest('turn/start', turnStartParams({
      threadId, model, text: `${systemPrompt}\n\n---\n\n${userMessage}`,
    })) as { turn?: { id?: string } }

    const turnId = turnResult?.turn?.id
    if (!turnId) {
      this.protocolFailure('turn/start returned no turn id')
      throw new Error('Codex did not return turn id')
    }

    // Claim anything that arrived before this point, then register -- with
    // no await in between, so no line can slip through the gap.
    const early = this.earlyTurnEvents.take(turnId)
    return new Promise<string>((resolve, reject) => {
      if (early.text) onToken?.(early.text)
      if (early.completion) {
        this.settleTurn({ text: early.text, resolve, reject }, early.completion.status, early.completion.error)
        return
      }
      const timeout = setTimeout(() => {
        this.pendingTurns.delete(turnId)
        reject(new Error('Codex turn timed out after 3 minutes'))
      }, TURN_TIMEOUT_MS)

      this.pendingTurns.set(turnId, { text: early.text, resolve, reject, onToken, timeout })
    })
  }

  /**
   * This Codex does not speak the app's protocol (codex-health.ts decides).
   * It is the user's own install, so there is no older verified copy to fall
   * back to -- as with the bundled binary before, the failing call reports
   * it, and updating Codex is the fix.
   */
  private protocolFailure(detail: string): void {
    console.error(`[codex] ${this.command} does not speak JobScan's protocol (update it with npm install -g @openai/codex): ${detail}`)
  }

  async shutdown(): Promise<void> {
    this.disposed = true
    const child = this.child
    this.closed = true
    if (!child) { this.reader = null; return }

    // Graceful path: tell codex to shut down, close stdin so it exits its read loop,
    // then wait for the process to exit. This lets SQLite checkpoint the WAL and
    // truncate it — preventing the WAL bloat that causes "Codex RPC timeout: initialize".
    let exited = false
    const exitPromise = new Promise<void>(resolve => {
      child.once('close', () => { exited = true; resolve() })
    })

    try { this.sendNotification('shutdown') } catch { /* best effort */ }
    try { child.stdin?.end() } catch { /* best effort */ }

    await Promise.race([
      exitPromise,
      new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
    ])

    if (!exited) {
      try { child.kill() } catch { /* best effort */ }
    }

    this.child = null
    this.reader = null
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
let _client: CodexAppServerClient | null = null

/**
 * App-server deaths before `initialize` is answered, in a row, per binary
 * (codex-health.ts): a Codex the user swaps in (Settings path, reinstall)
 * starts with a clean count.
 */
const startupCrashes = new Map<string, ReturnType<typeof createStartupCrashCounter>>()
function startupCrashesFor(command: string): ReturnType<typeof createStartupCrashCounter> {
  let c = startupCrashes.get(command)
  if (!c) { c = createStartupCrashCounter(2); startupCrashes.set(command, c) }
  return c
}

/**
 * Start the Codex binary once off the main thread (binary-warmup.ts), before
 * anything here starts it: a never-seen binary's antivirus scan otherwise
 * freezes the window. Never fails.
 */
export function warmCodex(): Promise<void> {
  const native = resolveCodexNativeBinary()
  return native ? warmBinary(native) : Promise.resolve()
}

function getClient(): CodexAppServerClient {
  if (!_client) _client = new CodexAppServerClient()
  return _client
}

/** Settings' model, else the one "Auto" resolved to this session; '' when not known yet. */
export function activeCodexModel(): string {
  const configured = String(store.get('codexModel') ?? '').trim()
  return configured || (_client?.autoModel ?? '')
}

export async function clearCodexClient(): Promise<void> {
  const c = _client
  _client = null
  if (c) await c.shutdown()
}

// ── Public interface (signature unchanged — pipeline.ts not affected) ──────────
export async function runCodexThread(
  systemPrompt: string,
  userMessage: string,
  onToken?: (t: string) => void
): Promise<string> {
  return getClient().runTurn(systemPrompt, userMessage, onToken)
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
  console.warn(`[codex] saved model "${saved}" is no longer offered — reset to Auto`)
  return saved
}

export async function listCodexModels(): Promise<CodexModelOption[]> {
  return getClient().listModels()
}

/**
 * The Codex account's 5-hour and weekly usage windows, or null when they
 * cannot be read (an older Codex, no network, signed out). Never under e2e:
 * those runs must not spawn codex.
 */
export async function readRateLimits(): Promise<RateLimitSnapshot | null> {
  if (process.env['E2E_TEST'] === '1') return null
  try {
    return mapRateLimits(await getClient().readRateLimits())
  } catch (e) {
    console.warn('[codex] rate limits unavailable:', String(e).slice(0, 200))
    return null
  }
}

const LOGIN_STATUS_TIMEOUT_MS = 30_000

/**
 * Is Codex signed in? Asks `codex login status`: true or false from its
 * answer, null when it cannot run or says neither -- the caller decides what
 * unknown means. False under e2e, which must never spawn codex.
 */
export async function codexLoginStatus(): Promise<boolean | null> {
  if (process.env['E2E_TEST'] === '1') return false
  await warmCodex()
  return new Promise(resolve => {
    let settled = false
    const done = (v: boolean | null): void => { if (!settled) { settled = true; resolve(v) } }
    try {
      const spec = getCodexSpawnSpec(['login', 'status'])
      const child = spawn(spec.command, spec.args, {
        windowsHide: true,
        shell: spec.shell,
        env: buildSpawnEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout?.on('data', (c: Buffer) => { output += c.toString() })
      child.stderr?.on('data', (c: Buffer) => { output += c.toString() })
      const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } done(null) }, LOGIN_STATUS_TIMEOUT_MS)
      child.on('close', (code: number | null) => { clearTimeout(timer); done(loginStatusFrom(code, output)) })
      child.on('error', () => { clearTimeout(timer); done(null) })
    } catch {
      done(null)
    }
  })
}

// Prompts and the reply parser live in prompts.ts (shared by every engine).
export {
  parseJsonResponse, QUERY_GEN_DONE_ACK, QUERY_GEN_PROMPT_REV, RATING_DESCRIPTION_CHARS,
  RATING_PROMPT_REV, PAYLOAD_PROMPT_REV, QUERY_GEN_SYSTEM, RATING_SYSTEM, payloadSystem,
} from './prompts'
