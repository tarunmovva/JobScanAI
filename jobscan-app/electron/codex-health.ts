/**
 * When a Codex version is broken for this app, and which one to use instead.
 *
 * Only a protocol failure -- Codex no longer speaks what this app speaks --
 * may reject a version, and a rejected version is never used again (until a
 * newer release replaces it): a request Codex could not even parse on a call
 * the app depends on, a thread or turn started without an id, or an
 * app-server that exits before it answers `initialize` twice in a row.
 *
 * Codex reports nearly every error as -32600 (invalid request), so the code
 * alone says little. Read off a real 0.153.4: a request it could not parse
 * -- an unknown method, a parameter of the wrong type -- is -32600 with a
 * message starting "Invalid request:". Signed out ("codex account
 * authentication required to read rate limits"), "Not initialized",
 * "thread not found", a broken config: -32600 too, without that prefix.
 * Those, a usage limit, a withdrawn model, the network or a timeout say
 * nothing about the version: they defer, never reject.
 */
import { RATE_LIMITS_READ } from './codex-account'

export type Verdict =
  | { kind: 'ok' }
  /** The version does not speak this app's protocol: never use it. */
  | { kind: 'protocol'; detail: string }
  /** Could not tell (signed out, usage limit, network, timeout): ask again later. */
  | { kind: 'inconclusive'; detail: string }


/** The calls every rating, form answer and loop round depends on. */
export const CORE_METHODS: ReadonlySet<string> = new Set([
  'initialize', 'model/list', 'thread/start', 'turn/start', RATE_LIMITS_READ,
])

const MISSING_ID = /did not return (thread|turn) id/i
/** How Codex words a request it could not parse (serde): the one -32600 that is about the protocol. */
const UNPARSEABLE = /^\s*Invalid request:/i

interface RpcError { code: number; message: string; data?: unknown }

function asRpcError(o: unknown): RpcError | null {
  if (!o || typeof o !== 'object' || typeof (o as { code?: unknown }).code !== 'number') return null
  const e = o as { code: number; message?: unknown; data?: unknown }
  return { code: e.code, message: String(e.message ?? ''), data: e.data }
}

/** The JSON-RPC error in what the client rejects with (an Error holding the error object as JSON), or null. */
function rpcError(err: unknown): RpcError | null {
  const direct = asRpcError(err)
  if (direct) return direct
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  try {
    const parsed = asRpcError(JSON.parse(msg))
    if (parsed) return parsed
  } catch { /* not JSON */ }
  const m = /"code"\s*:\s*(-?\d+)/.exec(msg)
  return m ? { code: Number(m[1]), message: msg } : null
}

export function rpcErrorCode(err: unknown): number | null {
  return rpcError(err)?.code ?? null
}

export function isProtocolError(err: unknown): boolean {
  const e = rpcError(err)
  if (e) {
    if (e.code === -32601 || e.code === -32700) return true      // method not found, parse error
    if (e.code === -32600) return UNPARSEABLE.test(e.message)    // only "Invalid request: ..."
    if (e.code === -32602) {                                      // invalid params -- but not an input too large
      const d = (e.data ?? {}) as Record<string, unknown>
      return d['input_error_code'] !== 'input_too_large' && d['inputErrorCode'] !== 'input_too_large'
    }
    return false
  }
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return MISSING_ID.test(msg)
}

/** The newest version verified and never rejected; null = the bundled one. */
export function pickManagedVersion(verifiedNewestFirst: string[], rejected: string[]): string | null {
  const no = new Set(rejected ?? [])
  return (verifiedNewestFirst ?? []).find(v => !no.has(v)) ?? null
}

/**
 * App-server exits before it answers `initialize`: once can be the machine
 * (an antivirus scan, a busy disk), the `threshold`-th time in a row is the
 * version. `started()` -- it answered -- starts the count over.
 */
export function createStartupCrashCounter(threshold = 2): { crashed: () => boolean; started: () => void } {
  let inARow = 0
  return {
    crashed: () => ++inARow >= threshold,
    started: () => { inARow = 0 },
  }
}
