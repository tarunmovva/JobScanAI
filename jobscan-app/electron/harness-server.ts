/**
 * The local endpoint the jobscan harness (an MCP server inside the user's
 * Claude Code or Codex) talks to, so that session can drive JobScan's safe
 * steps and hear what happens.
 *
 * Only this computer, only the holder of this launch's token:
 *  - listens on 127.0.0.1 on a port the OS picks;
 *  - every request needs `Authorization: Bearer <token>`; the token is new
 *    each launch and lives in harness.json in the app's data folder;
 *  - any request with an Origin header is refused: browsers send one, so a
 *    web page open in the automation Chrome cannot reach this endpoint;
 *  - Host must be exactly 127.0.0.1:<port> (no DNS rebinding);
 *  - bodies are capped at 64 KB; slow requests time out.
 * What it serves is status and notices made of numbers and fixed labels,
 * and six actions that cannot submit anything (agent-actions.ts).
 *
 * Pure Node (no Electron): unit-tested over real HTTP.
 */
import http from 'http'
import fs from 'fs'
import path from 'path'
import { randomBytes, timingSafeEqual } from 'crypto'
import type { NoticeFeed } from './notices'

export interface HarnessDeps {
  version: string
  status(): Record<string, unknown>
  action(name: string, args: unknown): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string }
  note(text: string): void
  feed: NoticeFeed
}

export interface HarnessHandle { port: number; token: string; file: string; close(): Promise<void> }

const MAX_BODY = 64 * 1024
const MAX_WAIT_MS = 25_000
const NOTE_MAX = 500

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    ...(code === 413 ? { Connection: 'close' } : {}),
  })
  res.end(text)
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tooLarge = (): Error => Object.assign(new Error('too large'), { code: 413 })
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { req.resume(); reject(tooLarge()); return }
    let size = 0
    let over = false
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { over = true; return }   // drained, never kept
      chunks.push(c)
    })
    req.on('end', () => {
      if (over) return reject(tooLarge())
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch { reject(Object.assign(new Error('bad json'), { code: 400 })) }
    })
    req.on('error', reject)
  })
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer ([0-9a-f]+)$/.exec(String(header ?? ''))
  if (!m) return false
  const given = Buffer.from(m[1]!, 'utf8')
  const want = Buffer.from(token, 'utf8')
  return given.length === want.length && timingSafeEqual(given, want)
}

/** Plain text for the window: no control characters, at most 500 chars. */
export function cleanNote(text: unknown): string {
  return String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, NOTE_MAX)
}

function writeHandleFile(file: string, info: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600) } catch { /* best effort */ } }
}

export function startHarnessServer(deps: HarnessDeps, file: string): Promise<HarnessHandle> {
  const token = randomBytes(32).toString('hex')
  let port = 0

  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.headers.origin !== undefined) return send(res, 403, { error: 'origin' })
      if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 421, { error: 'host' })
      if (!tokenMatches(req.headers.authorization, token)) return send(res, 401, { error: 'token' })
      // Any call from the driver shows it is there. A Codex session (no feed
      // monitor) may only ever call status, actions and notes.
      deps.feed.lastPollAt = Date.now()
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      try {
        if (req.method === 'GET' && url.pathname === '/v1/status') {
          return send(res, 200, { app: 'jobscan', version: deps.version, ...deps.status() })
        }
        if (req.method === 'GET' && url.pathname === '/v1/events') {
          deps.feed.lastPollAt = Date.now()
          const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0)
          const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, (Number(url.searchParams.get('wait') ?? 0) || 0) * 1000))
          const out = await deps.feed.wait(after, waitMs)
          deps.feed.lastPollAt = Date.now()
          if (res.destroyed) return
          return send(res, 200, out)
        }
        const action = /^\/v1\/actions\/([a-z_]{1,40})$/.exec(url.pathname)
        if (req.method === 'POST' && action) {
          const body = await readBody(req) as { args?: unknown }
          return send(res, 200, await deps.action(action[1]!, body?.args))
        }
        if (req.method === 'POST' && url.pathname === '/v1/notes') {
          const body = await readBody(req) as { text?: unknown }
          const text = cleanNote(body?.text)
          if (!text) return send(res, 400, { error: 'empty' })
          deps.note(text)
          return send(res, 200, { ok: true })
        }
        return send(res, 404, { error: 'not found' })
      } catch (e) {
        const code = (e as { code?: number }).code
        return send(res, typeof code === 'number' ? code : 500, { error: code === 413 ? 'too large' : code === 400 ? 'bad json' : 'error' })
      }
    })()
  })
  server.headersTimeout = 10_000
  server.requestTimeout = MAX_WAIT_MS + 15_000
  server.keepAliveTimeout = 5_000

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port
      writeHandleFile(file, { port, token, pid: process.pid, version: deps.version, startedAt: new Date().toISOString() })
      resolve({
        port, token, file,
        close: () => new Promise<void>(done => {
          try { fs.rmSync(file, { force: true }) } catch { /* gone */ }
          server.closeAllConnections?.()
          server.close(() => done())
        }),
      })
    })
  })
}
