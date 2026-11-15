/**
 * The jobscan MCP server: the four tools a Claude Code or Codex session
 * uses to drive JobScan AI through its local endpoint (see lib.mjs). Claude
 * Code starts it from .mcp.json, Codex from .codex-mcp.json.
 *
 * stdio, newline-delimited JSON-RPC. stdout carries protocol messages only;
 * diagnostics go to stderr. Each tools/call runs on its own, so replies can
 * finish out of order, and notifications/cancelled aborts the matching call
 * (no reply is sent for it, as the MCP spec asks). With JobScan away, the
 * tools say so and the server keeps running: harness.json is read again on
 * every call, so the app can come and go.
 *
 * Zero dependencies: Node >= 18 built-ins only.
 */
import readline from 'node:readline'
import {
  HarnessError, NOT_RUNNING, call, cleanNotices, cleanStatus, cleanValue, handleId, readHandle,
} from './lib.mjs'

const VERSION = '1.0.0'
const FALLBACK_PROTOCOL = '2025-06-18'
const ACTIONS = ['rebuild_db', 'cancel_rebuild', 'find_jobs', 'find_more', 'rate_jobs', 'stop_loop']
const STOP_MODES = ['after-round', 'now']
const TEXT_MAX = 500
const WAIT_MAX_S = 50
const WAIT_DEFAULT_S = 25
const SERVER_WAIT_MAX_S = 25
const WAIT_MAX_NOTICES = 100
const FAR = Number.MAX_SAFE_INTEGER   // after=FAR&wait=0 returns just `next`

const ALWAYS = { 'anthropic/alwaysLoad': true }

const TOOLS = [
  {
    name: 'jobscan_status',
    description: "Read JobScan's current status as JSON: the screen (state), busy, AI engine, rebuild status, "
      + 'counts of searches, job pool and rated jobs, the auto-apply loop, and the actions it accepts. '
      + 'Numbers and labels only. Call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'JobScan status', readOnlyHint: true, openWorldHint: false },
    _meta: ALWAYS,
  },
  {
    name: 'jobscan_action',
    description: "Start one of JobScan's six steps, exactly as its button would. "
      + 'rebuild_db, find_jobs: Resume screen. cancel_rebuild: while a rebuild runs. '
      + 'find_more (args.ask) and rate_jobs: searches screen, after find_jobs. stop_loop (args.mode): while the loop is on. '
      + 'Returns {"ok":true} once the step starts (how it goes arrives as notices), '
      + 'or {"ok":false,"reason":...} when JobScan refuses.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ACTIONS, description: 'Which step to start.' },
        args: {
          type: 'object',
          properties: {
            ask: { type: 'string', maxLength: TEXT_MAX, description: "find_more only: what to look for, in the user's words." },
            mode: { type: 'string', enum: STOP_MODES, description: 'stop_loop only: after-round (default) or now.' },
          },
          additionalProperties: false,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { title: 'Start a JobScan step', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: ALWAYS,
  },
  {
    name: 'jobscan_note',
    description: "Show a short plain-text note (at most 500 characters) to the user in JobScan's window, marked as coming from you.",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: TEXT_MAX, description: 'The note.' } },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { title: 'Note in JobScan', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: ALWAYS,
  },
  {
    name: 'jobscan_wait',
    description: 'Wait for JobScan notices. Use it in Codex, or when lines from the jobscan feed are not arriving. '
      + 'Returns {notices, next, missed}: notices newer than `after` (omit it to start from now), '
      + 'waiting up to `seconds` (default 25, max 50) for the first. Pass `next` back as `after`. '
      + 'At most 100 notices per call; missed=true means some were skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        after: { type: 'integer', minimum: 0, description: 'The `next` from the previous call. Omit to start from now.' },
        seconds: { type: 'integer', minimum: 0, maximum: WAIT_MAX_S, description: 'How long to wait for a notice (default 25).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Wait for JobScan notices', readOnlyHint: true, openWorldHint: false },
    _meta: ALWAYS,
  },
]

// ── tools ───────────────────────────────────────────────────────────────────

const text = t => ({ content: [{ type: 'text', text: t }] })
const json = v => text(JSON.stringify(v))
const refuse = t => ({ content: [{ type: 'text', text: t }], isError: true })

function wholeNumber(v, { min, max, fallback }) {
  if (v === undefined || v === null) return { value: fallback }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || (max !== undefined && v > max)) return { error: true }
  return { value: v }
}

/** `next` right now: where "from now on" starts. */
async function currentNext(handle, signal) {
  const base = cleanNotices(await call('GET', `/v1/events?after=${FAR}&wait=0`, undefined, { handle, signal, timeoutMs: 10_000 }))
  if (!base) throw new HarnessError('bad_reply', 'JobScan sent a reply this plugin cannot read.')
  return base.next
}

const HANDLERS = {
  async jobscan_status(_args, signal) {
    return json(cleanStatus(await call('GET', '/v1/status', undefined, { signal, timeoutMs: 10_000 })))
  },

  async jobscan_action(args, signal) {
    const name = args.name
    if (!ACTIONS.includes(name)) return refuse(`name must be one of: ${ACTIONS.join(', ')}.`)
    const given = args.args !== null && typeof args.args === 'object' ? args.args : {}
    const a = {}
    if (typeof given.ask === 'string') a.ask = given.ask.slice(0, TEXT_MAX)
    if (STOP_MODES.includes(given.mode)) a.mode = given.mode
    const result = cleanValue(await call('POST', `/v1/actions/${name}`, { args: a }, { signal, timeoutMs: 15_000 }))
    return json(result && typeof result === 'object' ? result : {})
  },

  async jobscan_note(args, signal) {
    const note = typeof args.text === 'string' ? args.text.trim() : ''
    if (!note) return refuse('text is empty.')
    if (note.length > TEXT_MAX) return refuse(`text is longer than ${TEXT_MAX} characters; shorten it.`)
    try {
      await call('POST', '/v1/notes', { text: note }, { signal, timeoutMs: 10_000 })
    } catch (e) {
      if (e?.code === 'http_400') return refuse('JobScan refused the note: it is empty once control characters are removed.')
      throw e
    }
    return json({ ok: true })
  },

  async jobscan_wait(args, signal) {
    const seconds = wholeNumber(args.seconds, { min: 0, max: WAIT_MAX_S, fallback: WAIT_DEFAULT_S })
    if (seconds.error) return refuse(`seconds must be a whole number from 0 to ${WAIT_MAX_S}.`)
    const given = wholeNumber(args.after, { min: 0, fallback: null })
    if (given.error) return refuse('after must be a whole number, 0 or more (the `next` of the previous call).')

    const first = readHandle()
    if (!first.handle) throw new HarnessError('absent', first.reason)
    const launch = handleId(first.handle)
    let after = given.value ?? await currentNext(first.handle, signal)
    const deadline = Date.now() + seconds.value * 1000

    for (;;) {
      const now = readHandle()
      if (!now.handle) throw new HarnessError('absent', now.reason)
      // JobScan restarted: its notices start again from 1. Say so, and where to go on from.
      if (handleId(now.handle) !== launch) return json({ notices: [], next: await currentNext(now.handle, signal), missed: true })
      const wait = Math.max(0, Math.min(SERVER_WAIT_MAX_S, Math.ceil((deadline - Date.now()) / 1000)))
      const out = cleanNotices(
        await call('GET', `/v1/events?after=${after}&wait=${wait}`, undefined, { handle: now.handle, signal, timeoutMs: wait * 1000 + 10_000 }),
        { max: WAIT_MAX_NOTICES })
      if (!out) throw new HarnessError('bad_reply', 'JobScan sent a reply this plugin cannot read.')
      if (out.next < after) return json({ notices: [], next: out.next, missed: true })
      if (out.notices.length > 0 || out.missed || deadline - Date.now() < 1000) return json(out)
      after = out.next
    }
  },
}

function failure(e) {
  if (e instanceof HarnessError) {
    if (e.code === 'absent') return refuse(`${NOT_RUNNING} (${e.message}).`)
    return refuse(e.message)
  }
  log(`unexpected error: ${e?.stack ?? e}`)
  return refuse('The jobscan plugin hit an unexpected error.')
}

// ── protocol ────────────────────────────────────────────────────────────────

const inflight = new Map()   // request id -> AbortController

function log(message) {
  try { process.stderr.write(`[jobscan-harness] ${message}\n`) } catch { /* nowhere to report */ }
}

function send(message) {
  try { process.stdout.write(`${JSON.stringify(message)}\n`) } catch (e) { log(`write failed: ${e?.message ?? e}`) }
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function callTool(id, params) {
  const name = params?.name
  const handler = typeof name === 'string' && Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : null
  if (!handler) return replyError(id, -32602, `Unknown tool: ${String(name).slice(0, 64)}`)
  const args = params?.arguments !== null && typeof params?.arguments === 'object' ? params.arguments : {}
  const ctl = new AbortController()
  inflight.set(id, ctl)
  let result
  try {
    result = await handler(args, ctl.signal)
  } catch (e) {
    result = failure(e)
  }
  if (inflight.get(id) === ctl) inflight.delete(id)
  if (ctl.signal.aborted) return   // cancelled: the client expects no reply
  reply(id, result)
}

function onMessage(m) {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return
  const isRequest = typeof m.method === 'string' && (typeof m.id === 'string' || typeof m.id === 'number')
  if (!isRequest) {
    if (m.method === 'notifications/cancelled') {
      const id = m.params?.requestId
      const ctl = inflight.get(id)
      if (ctl) {
        inflight.delete(id)
        ctl.abort()
      }
    }
    return   // other notifications (initialized, ...) and stray responses need nothing
  }
  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.protocolVersion
      return reply(m.id, {
        protocolVersion: typeof asked === 'string' && asked ? asked : FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'jobscan', version: VERSION },
      })
    }
    case 'ping': return reply(m.id, {})
    case 'tools/list': return reply(m.id, { tools: TOOLS })
    case 'tools/call': return void callTool(m.id, m.params)
    default: return replyError(m.id, -32601, `Method not found: ${m.method.slice(0, 64)}`)
  }
}

function shutdown() {
  for (const ctl of inflight.values()) ctl.abort()
  inflight.clear()
  process.exit(0)
}

process.on('uncaughtException', e => log(`uncaught: ${e?.stack ?? e}`))
process.on('unhandledRejection', e => log(`unhandled: ${e?.stack ?? e}`))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.stdout.on('error', shutdown)   // the client is gone

readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', line => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      log('ignored a line that is not JSON')
      return
    }
    for (const m of Array.isArray(message) ? message : [message]) onMessage(m)
  })
  .on('close', shutdown)
