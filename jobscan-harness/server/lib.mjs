/**
 * Shared by the jobscan MCP server (mcp.mjs) and the feed monitor (feed.mjs):
 * where JobScan's harness.json is, how to reach the local endpoint it names,
 * and the cleaning every reply goes through before any of it reaches the
 * session (Claude Code or Codex).
 *
 * JobScan already sends only numbers and fixed labels. Everything is checked
 * again here against the same rule, and anything else is dropped, so even a
 * port that is not JobScan's cannot put text in front of the session.
 *
 * Zero dependencies: Node >= 18 built-ins only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

/** The only strings that pass: short lowercase labels (same rule as notices.ts). */
export const LABEL = /^[a-z][a-z0-9_:-]{0,39}$/

export const NOT_RUNNING = "JobScan is not running, or 'Let Claude Code or Codex drive JobScan' is off in Settings"

const APP_FOLDERS = ['jobscan-app', 'JobScan AI']
const MAX_HANDLE_BYTES = 64 * 1024
const MAX_REPLY_BYTES = 1024 * 1024

/** An error with a fixed code and a message written here (never text from the reply). */
export class HarnessError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** Where JobScan writes harness.json on this platform, in the order to try. */
export function harnessCandidates(env = process.env, platform = process.platform, home = os.homedir()) {
  const P = platform === 'win32' ? path.win32 : path.posix
  let base
  if (platform === 'win32') base = env.APPDATA || P.join(home, 'AppData', 'Roaming')
  else if (platform === 'darwin') base = P.join(home, 'Library', 'Application Support')
  else base = env.XDG_CONFIG_HOME && P.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : P.join(home, '.config')
  return APP_FOLDERS.map(name => P.join(base, name, 'harness.json'))
}

/**
 * JOBSCAN_HARNESS_FILE when set (and then nothing else), otherwise the first
 * candidate that exists; null when there is none.
 */
export function harnessFile(env = process.env, platform = process.platform, home = os.homedir()) {
  const forced = String(env.JOBSCAN_HARNESS_FILE ?? '').trim()
  if (forced) return path.resolve(forced)
  return harnessCandidates(env, platform, home).find(f => fs.existsSync(f)) ?? null
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'   // exists, owned by someone else
  }
}

/**
 * The running JobScan's endpoint, read fresh on every call (the port and
 * token change each launch): { handle, reason }. handle is null, with a
 * human reason, when the file is missing, unreadable, or left over from a
 * JobScan that has quit.
 */
export function readHandle(env = process.env) {
  const file = harnessFile(env)
  if (!file) return { handle: null, reason: 'no harness.json found' }
  let info
  try {
    if (fs.statSync(file).size > MAX_HANDLE_BYTES) return { handle: null, reason: 'harness.json is not valid' }
    info = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch (e) {
    return { handle: null, reason: e?.code === 'ENOENT' ? 'no harness.json found' : 'harness.json is not valid' }
  }
  const port = info?.port
  const token = info?.token
  const pid = info?.pid
  if (!Number.isInteger(port) || port < 1 || port > 65535
    || typeof token !== 'string' || !/^[0-9a-f]{32,256}$/.test(token)
    || !Number.isInteger(pid) || pid < 1) {
    return { handle: null, reason: 'harness.json is not valid' }
  }
  if (!alive(pid)) return { handle: null, reason: 'harness.json is left over from a JobScan that has quit' }
  const startedAt = typeof info.startedAt === 'string' ? info.startedAt.slice(0, 64) : ''
  return { handle: { port, token, pid, startedAt, file }, reason: null }
}

/** Which launch of JobScan a handle belongs to. */
export function handleId(h) {
  return `${h.pid}|${h.port}|${h.token}|${h.startedAt}`
}

const GONE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ETIMEDOUT'])

function statusError(status) {
  if (status === 401) return new HarnessError('http_401', 'JobScan refused the token; it may have just restarted. Try again.')
  if (status === 400) return new HarnessError('http_400', 'JobScan could not use that request.')
  if (status === 404) return new HarnessError('http_404', 'This JobScan does not know that request; update JobScan or the plugin.')
  if (status === 413) return new HarnessError('http_413', 'The request was too large for JobScan.')
  return new HarnessError(`http_${status}`, `JobScan answered with an error (HTTP ${status}).`)
}

/**
 * One JSON request to the running JobScan: 127.0.0.1 only, this launch's
 * bearer token, never an Origin header. Resolves to the parsed reply (not
 * yet cleaned); rejects with a HarnessError whose code is 'absent' when
 * JobScan is not there.
 */
export function call(method, urlPath, body, { signal, timeoutMs = 15_000, handle } = {}) {
  return new Promise((resolve, reject) => {
    let h = handle
    if (!h) {
      const r = readHandle()
      if (!r.handle) return reject(new HarnessError('absent', r.reason))
      h = r.handle
    }
    if (signal?.aborted) return reject(new HarnessError('aborted', 'Cancelled.'))

    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = { Host: `127.0.0.1:${h.port}`, Authorization: `Bearer ${h.token}`, Accept: 'application/json' }
    if (data) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(data.length)
    }

    let settled = false
    let timer = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const fail = err => { req.destroy(); finish(reject, err) }
    const onAbort = () => fail(new HarnessError('aborted', 'Cancelled.'))

    // agent: false -- a fresh connection each time, so a kept-alive socket
    // the app has already timed out is never reused.
    const req = http.request({ host: '127.0.0.1', port: h.port, method, path: urlPath, headers, agent: false }, res => {
      const chunks = []
      let size = 0
      res.on('data', c => {
        size += c.length
        if (size > MAX_REPLY_BYTES) fail(new HarnessError('bad_reply', 'JobScan sent a reply that is too large.'))
        else chunks.push(c)
      })
      res.on('end', () => {
        const status = res.statusCode ?? 0
        if (status < 200 || status > 299) return finish(reject, statusError(status))
        let json
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { json = undefined }
        if (json === null || typeof json !== 'object') return finish(reject, new HarnessError('bad_reply', 'JobScan sent a reply that is not JSON.'))
        finish(resolve, json)
      })
      res.on('error', () => finish(reject, new HarnessError('absent', 'JobScan closed the connection')))
      res.on('close', () => { if (!res.complete) finish(reject, new HarnessError('absent', 'JobScan closed the connection')) })
    })
    req.on('error', e => finish(reject, GONE.has(e?.code)
      ? new HarnessError('absent', 'JobScan did not answer')
      : new HarnessError('network', 'Could not reach JobScan.')))
    timer = setTimeout(() => fail(new HarnessError('timeout', 'JobScan did not answer in time.')), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (data) req.write(data)
    req.end()
  })
}

// ── cleaning ────────────────────────────────────────────────────────────────

const MAX_DEPTH = 4
const MAX_ITEMS = 100
const MAX_KEYS = 64
const MAX_NOTICE_FIELDS = 24

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** A notice-style value: a finite number, a boolean, or a label or ''. */
function scalar(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v === '' || LABEL.test(v) ? v : undefined
  return undefined
}

/**
 * Numbers, booleans, labels or '', and objects (label keys) and arrays of
 * those, a few levels deep; null too, since it carries no text. Anything
 * else is dropped: undefined means "drop this".
 */
export function cleanValue(v, depth = 0) {
  if (v === null) return null
  const s = scalar(v)
  if (s !== undefined || typeof v !== 'object') return s
  if (depth >= MAX_DEPTH) return undefined
  if (Array.isArray(v)) {
    const out = []
    for (const item of v.slice(0, MAX_ITEMS)) {
      const c = cleanValue(item, depth + 1)
      if (c !== undefined) out.push(c)
    }
    return out
  }
  const out = {}
  let kept = 0
  for (const [k, item] of Object.entries(v)) {
    if (kept >= MAX_KEYS) break
    if (!LABEL.test(k)) continue
    const c = cleanValue(item, depth + 1)
    if (c === undefined) continue
    out[k] = c
    kept++
  }
  return out
}

/** /v1/status, cleaned: always an object. */
export function cleanStatus(raw) {
  const c = cleanValue(raw)
  return isPlainObject(c) ? c : {}
}

/** One notice, flat like notices.ts makes them; null without a label type and a seq. */
export function cleanNotice(n) {
  if (!isPlainObject(n)) return null
  if (typeof n.type !== 'string' || !LABEL.test(n.type)) return null
  if (typeof n.seq !== 'number' || !Number.isFinite(n.seq)) return null
  const out = {}
  let kept = 0
  for (const [k, v] of Object.entries(n)) {
    if (kept >= MAX_NOTICE_FIELDS) break
    if (!LABEL.test(k)) continue
    const c = scalar(v)
    if (c === undefined) continue
    out[k] = c
    kept++
  }
  return out
}

/**
 * /v1/events, cleaned: { notices, next, missed }, keeping at most `max`
 * of the newest notices (missed is then true). null when the reply has no
 * usable `next`.
 */
export function cleanNotices(raw, { max = 500 } = {}) {
  if (!isPlainObject(raw)) return null
  const next = raw.next
  if (typeof next !== 'number' || !Number.isInteger(next) || next < 0) return null
  const list = Array.isArray(raw.notices) ? raw.notices.slice(-1000) : []
  let notices = []
  for (const n of list) {
    const c = cleanNotice(n)
    if (c) notices.push(c)
  }
  let missed = raw.missed === true
  if (notices.length > max) {
    notices = notices.slice(-max)
    missed = true
  }
  return { notices, next, missed }
}
