/**
 * The jobscan-feed monitor: what JobScan does, as one short line per batch
 * of notices on stdout, which Claude Code hands to the session.
 *
 *   jobscan: state=rating; progress step=rating done=40 total=120; ai_call kind=rating outcome=ok ms=41000
 *
 * It long-polls the endpoint harness.json names, starting from what is new
 * when it connects (history is not replayed). Only cleaned values (numbers
 * and labels) are printed. While JobScan is away it prints nothing and
 * looks again every 10 s; it prints one line when JobScan says it is
 * closing, and one when it connects to a JobScan it had found away.
 *
 * Zero dependencies: Node >= 18 built-ins only. Never reads stdin.
 */
import { call, cleanNotices, handleId, readHandle } from './lib.mjs'

const RETRY_MS = retryMs(process.env.JOBSCAN_FEED_RETRY_MS)   // the variable is for tests
const WAIT_S = 25
const COLLECT_MS = 200   // a long poll ends at the first notice; the rest of a burst follows within this
const MAX_LINE = 300
const FAR = Number.MAX_SAFE_INTEGER   // after=FAR&wait=0 returns just `next`

function retryMs(raw) {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 50 ? Math.min(n, 60_000) : 10_000
}

let stopping = false
let inflight = null
let wake = null

function stop() {
  stopping = true
  inflight?.abort()
  wake?.()
  setTimeout(() => process.exit(0), 1000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('SIGHUP', stop)
process.stdout.on('error', () => process.exit(0))   // nobody is reading any more

function print(line) {
  if (!stopping) process.stdout.write(`${line}\n`)
}

function sleep(ms) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); wake = null; resolve() }
    const timer = setTimeout(done, ms)
    wake = done
  })
}

/** The process that started this one is gone: stop rather than poll for nobody. */
const parent = process.ppid
function orphaned() {
  if (!(parent > 1)) return false   // no parent worth watching
  if (process.ppid !== parent) return true
  try { process.kill(parent, 0); return false } catch (e) { return e?.code !== 'EPERM' }
}

async function events(handle, after, wait) {
  inflight = new AbortController()
  try {
    const raw = await call('GET', `/v1/events?after=${after}&wait=${wait}`, undefined,
      { handle, signal: inflight.signal, timeoutMs: wait * 1000 + 15_000 })
    const out = cleanNotices(raw)
    if (!out) throw new Error('unreadable reply')
    return out
  } finally {
    inflight = null
  }
}

/** One notice as `type key=value ...`; `state=rating` when its only field is named after it. */
function render(n) {
  const fields = Object.entries(n).filter(([k, v]) => k !== 'seq' && k !== 'at' && k !== 'type' && v !== '')
  if (fields.length === 1 && fields[0][0] === n.type) return `${n.type}=${fields[0][1]}`
  return [n.type, ...fields.map(([k, v]) => `${k}=${v}`)].join(' ')
}

/** A batch as one line of at most ~300 characters; only the latest progress per step. */
function batchLine(notices) {
  const parts = []
  const progressAt = new Map()
  for (const n of notices) {
    if (n.type === 'app_quitting') continue
    if (n.type === 'progress' && typeof n.step === 'string') {
      const earlier = progressAt.get(n.step)
      if (earlier !== undefined) parts[earlier] = null
      progressAt.set(n.step, parts.length)
    }
    parts.push(render(n))
  }
  const kept = parts.filter(Boolean)
  if (kept.length === 0) return ''
  const more = count => `; +${count} more`
  let line = `jobscan: ${kept[0]}`
  if (line.length > MAX_LINE - 16) line = `${line.slice(0, MAX_LINE - 19)}...`
  let i = 1
  for (; i < kept.length; i++) {
    const next = `${line}; ${kept[i]}`
    const reserve = i < kept.length - 1 ? more(kept.length - i - 1).length : 0
    if (next.length + reserve > MAX_LINE) break
    line = next
  }
  if (i < kept.length) line += more(kept.length - i)
  return line
}

/** The rest of a burst that began with `first`, so the burst prints as one line. */
async function collectRest(handle, first) {
  await sleep(COLLECT_MS)
  if (stopping) return first
  try {
    const more = await events(handle, first.next, 0)
    if (more.next < first.next) return first
    return { notices: [...first.notices, ...more.notices], next: more.next, missed: first.missed || more.missed }
  } catch {
    return first   // JobScan went away meanwhile: print what there is
  }
}

async function main() {
  let launch = null      // which JobScan launch `after` belongs to
  let after = 0
  let announce = false   // JobScan was seen away: say so when one connects
  while (!stopping) {
    if (orphaned()) break
    const { handle } = readHandle()
    if (!handle) {
      announce = true
      await sleep(RETRY_MS)
      continue
    }
    try {
      const id = handleId(handle)
      if (id !== launch) {
        // A JobScan launch not heard from yet: start from what is new now.
        after = (await events(handle, FAR, 0)).next
        launch = id
        if (announce) print('jobscan: JobScan is connected')
        announce = false
        continue
      }
      let out = await events(handle, after, WAIT_S)
      if (out.next < after) {
        after = out.next
        print('jobscan: missed some notices')
        continue
      }
      if (out.notices.length > 0 && !out.notices.some(n => n.type === 'app_quitting')) {
        out = await collectRest(handle, out)
        if (stopping) break
      }
      if (out.missed) print('jobscan: missed some notices')
      const line = batchLine(out.notices)
      if (line) print(line)
      if (out.notices.some(n => n.type === 'app_quitting')) print('jobscan: JobScan closed')
      after = out.next
    } catch {
      if (stopping) break
      announce = true
      await sleep(RETRY_MS)
    }
  }
}

main().then(() => process.exit(0), () => process.exit(0))
