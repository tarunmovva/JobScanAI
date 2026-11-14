/**
 * The check a downloaded Codex must pass before the app switches to it: the
 * app-server answers every call the app makes. Not only `initialize` and
 * `model/list` -- also the usage limits, `thread/start`, `turn/start`, the
 * streamed reply and `turn/completed`, with one tiny real turn sent exactly
 * as real runs send it (codex-requests.ts). The limits are read first: when
 * one has run out, no turn is spent and the check is only deferred; when
 * there are none to read (an API-key account), no turn is spent either and
 * the version is judged on the rest. Signed out, nothing is judged at all:
 * Codex answers a signed-out client with errors that say nothing about it.
 *
 * Pure Node (no Electron), so it runs against a fake app-server in tests.
 */
import { spawn } from 'child_process'
import readline from 'readline'
import { RATE_LIMITS_READ, mapRateLimits, loginStatusFrom } from './codex-account'
import { exhaustedWindow } from './loop-policy'
import { threadStartParams, turnStartParams, PROBE_TEXT } from './codex-requests'
import { isProtocolError, type Verdict } from './codex-health'

export interface ProbeSpec {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  /** `codex login status` for the same binary: asked first when the turn is checked. */
  loginStatus?: { command: string; args: string[] }
}

export interface ProbeOptions {
  /** Also read the usage limits and run one tiny real turn. */
  turn: boolean
  /** The model saved in Settings ('' = Auto). */
  savedModel: string
  cwd: string
  /** For the whole check. */
  timeoutMs: number
}

export interface ProbeResult {
  verdict: Verdict
  /** The models it lists. */
  ids: string[]
  /** The model the turn used: the saved one when offered, else the first listed (Auto). */
  model: string | null
  /** The real turn was run. False when it was not asked for, or there were no usage limits to read. */
  turnChecked: boolean
}

type Outcome = ProbeResult & { exitedBeforeInit: boolean }

const LOGIN_STATUS_TIMEOUT_MS = 30_000

/** `codex login status`: true, false, or null when it cannot tell. */
function signedIn(cmd: { command: string; args: string[] }, env: NodeJS.ProcessEnv | undefined): Promise<boolean | null> {
  return new Promise(resolve => {
    let out = ''
    let done = false
    const finish = (v: boolean | null): void => { if (!done) { done = true; clearTimeout(t); resolve(v) } }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd.command, cmd.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: env ?? process.env })
    } catch { resolve(null); return }
    const t = setTimeout(() => { try { child.kill() } catch { /* gone */ } finish(null) }, LOGIN_STATUS_TIMEOUT_MS)
    child.stdout?.on('data', d => { out += String(d) })
    child.stderr?.on('data', d => { out += String(d) })
    child.on('error', () => finish(null))
    child.on('close', code => finish(loginStatusFrom(code, out)))
  })
}

/**
 * One retry when the app-server exits, or cannot start, before answering
 * initialize: a first start can be cut short (an antivirus scan).
 */
export async function probeAppServer(spec: ProbeSpec, opts: ProbeOptions): Promise<ProbeResult> {
  if (opts.turn && spec.loginStatus && (await signedIn(spec.loginStatus, spec.env)) === false) {
    return {
      verdict: { kind: 'inconclusive', detail: 'signed out: the check waits for a sign-in' },
      ids: [], model: null, turnChecked: false,
    }
  }
  let r = await probeOnce(spec, opts)
  if (r.exitedBeforeInit) r = await probeOnce(spec, opts)
  const { exitedBeforeInit: _, ...result } = r
  return result
}

function modelIds(result: unknown): string[] {
  const r = result as { models?: unknown; data?: unknown } | null | undefined
  const list = Array.isArray(r?.models) ? r!.models as unknown[] : Array.isArray(r?.data) ? r!.data as unknown[] : []
  return list
    .map(m => String((m as Record<string, unknown>)?.['id'] ?? (m as Record<string, unknown>)?.['slug'] ?? '').trim())
    .filter(Boolean)
}

function probeOnce(spec: ProbeSpec, opts: ProbeOptions): Promise<Outcome> {
  return new Promise(resolve => {
    let settled = false
    let initialized = false
    let ids: string[] = []
    let model: string | null = null
    const child = spawn(spec.command, spec.args, {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: spec.env ?? process.env,
    })
    const finish = (verdict: Verdict, exitedBeforeInit = false, turnChecked = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* gone */ }
      resolve({ verdict, ids, model, exitedBeforeInit, turnChecked })
    }
    const protocol = (detail: string): void => finish({ kind: 'protocol', detail })
    const inconclusive = (detail: string): void => finish({ kind: 'inconclusive', detail })
    let waitingFor = 'initialize'
    const timer = setTimeout(() => inconclusive(`timed out waiting for ${waitingFor}`), opts.timeoutMs)

    const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: unknown) => void }>()
    // The streamed text and the completion are kept by turn id, not matched
    // against the turn being waited for: they can arrive in the same chunk as
    // the turn/start reply, and readline hands over every line of a chunk
    // before `await call('turn/start')` resumes and learns that id. Matching
    // then dropped both, and the check waited out its whole timeout.
    const replies = new Map<string, string>()
    const completions = new Map<string, { status: string; error: string }>()
    let turnId = ''
    let turnDone: ((status: string, error: string) => void) | null = null
    let nextId = 1

    readline.createInterface({ input: child.stdout!, crlfDelay: Infinity }).on('line', line => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(line) } catch { return }
      if (typeof msg['id'] === 'number' && pending.has(msg['id'] as number)) {
        const p = pending.get(msg['id'] as number)!
        pending.delete(msg['id'] as number)
        if (msg['error']) p.reject(msg['error'])
        else p.resolve(msg['result'])
        return
      }
      const params = (msg['params'] ?? {}) as Record<string, unknown>
      if (msg['method'] === 'item/agentMessage/delta') {
        const id = String(params['turnId'] ?? '')
        replies.set(id, (replies.get(id) ?? '') + String(params['delta'] ?? ''))
      }
      if (msg['method'] === 'turn/completed') {
        const t = params['turn'] as Record<string, unknown> | undefined
        const id = String(t?.['id'] ?? '')
        const e = t?.['error'] as Record<string, unknown> | undefined
        const done = { status: String(t?.['status'] ?? ''), error: String(e?.['message'] ?? '') }
        completions.set(id, done)
        if (turnId && id === turnId) turnDone?.(done.status, done.error)
      }
    })
    child.stderr?.resume()
    // Could not start at all (missing, quarantined): nothing known about the version.
    child.on('error', err => finish({ kind: 'inconclusive', detail: `app-server could not start: ${err.message}` }, true))
    child.on('close', code => {
      if (initialized) inconclusive(`app-server exited (code ${code}) while waiting for ${waitingFor}`)
      else finish({ kind: 'protocol', detail: `app-server exits (code ${code}) before it answers initialize` }, true)
    })

    const call = (method: string, params: unknown): Promise<unknown> => new Promise((res, rej) => {
      waitingFor = method
      const id = nextId++
      pending.set(id, { resolve: res, reject: rej })
      try { child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') } catch (e) { rej(e) }
    })
    /** A failed call: a protocol error rejects the version, anything else defers. */
    const failed = (method: string, err: unknown): void => {
      const text = typeof err === 'object' && err ? JSON.stringify(err) : String(err)
      if (isProtocolError(err)) protocol(`${method}: ${text.slice(0, 200)}`)
      else inconclusive(`${method}: ${text.slice(0, 200)}`)
    }

    ;(async () => {
      try {
        await call('initialize', { clientInfo: { name: 'jobscan-app', version: '1.0.0' }, capabilities: { experimentalApi: true } })
      } catch (e) { return failed('initialize', e) }
      initialized = true
      try { child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n') } catch { /* closed */ }

      try {
        ids = modelIds(await call('model/list', { limit: 100 }))
      } catch (e) { return failed('model/list', e) }
      if (ids.length === 0) return inconclusive('model/list returned no models (signed out?)')
      model = opts.savedModel && ids.includes(opts.savedModel) ? opts.savedModel : ids[0]
      if (!opts.turn) return finish({ kind: 'ok' })

      // The limits first: never spend a turn on a window that has run out --
      // nor on one that cannot be read (an API-key account has none): the
      // version is then judged on the rest, as before this check existed.
      let limits: ReturnType<typeof mapRateLimits>
      try {
        limits = mapRateLimits(await call(RATE_LIMITS_READ, undefined))
      } catch (e) {
        if (isProtocolError(e)) return failed(RATE_LIMITS_READ, e)
        return finish({ kind: 'ok' })
      }
      if (!limits) return finish({ kind: 'ok' })
      const out = exhaustedWindow(limits)
      if (out) return inconclusive(`the ${out.window} usage limit has run out; the turn check waits for it`)

      let threadId = ''
      try {
        const r = await call('thread/start', threadStartParams({ cwd: opts.cwd, model })) as { thread?: { id?: string } }
        threadId = String(r?.thread?.id ?? '')
      } catch (e) { return failed('thread/start', e) }
      if (!threadId) return protocol('thread/start: Codex did not return thread id')

      try {
        const r = await call('turn/start', turnStartParams({ threadId, text: PROBE_TEXT, model })) as { turn?: { id?: string } }
        turnId = String(r?.turn?.id ?? '')
      } catch (e) { return failed('turn/start', e) }
      if (!turnId) return protocol('turn/start: Codex did not return turn id')

      waitingFor = 'turn/completed'
      // No await between learning the id and taking a completion that already
      // came, or registering for one: no line can slip in between.
      const done = completions.get(turnId) ?? await new Promise<{ status: string; error: string }>(res => {
        turnDone = (status, error) => res({ status, error })
      })
      if (done.status === 'failed') return inconclusive(`the turn failed: ${done.error.slice(0, 200)}`)
      if (!(replies.get(turnId) ?? '').trim()) return inconclusive('the turn completed with an empty reply')
      finish({ kind: 'ok' }, false, true)
    })().catch(e => inconclusive(String(e).slice(0, 200)))
  })
}
