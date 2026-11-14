/**
 * Claude mode end to end: the app's AI calls answered by a stand-in Claude
 * Code (unit/fixtures/fake-claude.cjs), the real jobscan CLI searching a
 * tiny offline database (fixtures/tiny-db.cjs), and a driver using the
 * harness endpoint the way the jobscan MCP server does.
 *
 * And parity: the same database and the same answers (fixtures/ai-oracle.cjs)
 * through the Codex engine (a stand-in app-server) and the Claude engine
 * must send identical prompts and leave identical searches and ratings.
 *
 * Everything runs in scratch folders: never the user's settings, database,
 * Chrome or ~/.codex. Needs the jobscan binary (`npm run setup` builds it).
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'

/* eslint-disable @typescript-eslint/no-var-requires */
const { buildTinyDb, rows } = require('./fixtures/tiny-db.cjs') as { buildTinyDb: (exe: string, dir: string) => string; rows: () => Array<{ title: string; company: string; jobId: string }> }
const { scoreFor, QUERIES } = require('./fixtures/ai-oracle.cjs') as { scoreFor: (id: string) => number; QUERIES: Array<{ name: string; flags: string }> }

const APP = path.resolve(__dirname, '..')
const REPO = path.resolve(APP, '..')
const JOBSCAN = process.env['JOBSCAN_E2E_EXE'] ?? path.join(REPO, 'jobscan', process.platform === 'win32' ? 'jobscan.exe' : 'jobscan')
const FAKE_CLAUDE = path.join(APP, 'tests', 'unit', 'fixtures', 'fake-claude.cjs')
const FAKE_CODEX = path.join(APP, 'tests', 'unit', 'fixtures', 'fake-app-server.cjs')
const ORACLE = path.join(APP, 'tests', 'fixtures', 'ai-oracle.cjs')
const TRIPWIRE = path.join(APP, 'tests', 'fixtures', 'codex-tripwire.cjs')
const NODE = process.execPath
const QUERY_MARK = 'You generate jobscan CLI search queries'
const RATING_MARK = 'senior technical recruiter'

test.skip(!fs.existsSync(JOBSCAN), `needs the jobscan binary at ${JOBSCAN} (npm run setup)`)
test.setTimeout(240_000)

interface Run { app: ElectronApplication; page: Page; root: string; userData: string; files: Record<string, string> }

async function start(engine: 'claude' | 'codex', extra: Record<string, unknown> = {}): Promise<Run> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `jobscan-e2e-${engine}-`))
  const exe = buildTinyDb(JOBSCAN, root)
  const userData = path.join(root, 'userdata')
  const codexHome = path.join(root, 'codex-home')
  for (const d of [userData, codexHome, path.join(root, 'home'), path.join(root, 'chrome')]) fs.mkdirSync(d, { recursive: true })
  const files = {
    claudeLog: path.join(root, 'claude-calls.jsonl'),
    codexLog: path.join(root, 'codex-prompts.jsonl'),
    tripwire: path.join(root, 'codex-started.marker'),
    codexHome,
  }
  if (engine === 'codex') fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"fixture":true}')
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    aiEngine: engine,
    jobscanExePath: exe,
    jobAutomatorHome: path.join(root, 'home'),
    pythonDir: path.join(REPO, 'jobscan'),
    ratingAgents: 3,
    payloadAgents: 2,
    lastFetchAt: new Date().toISOString(),
    resumeText: 'Alex Rivera, backend engineer: Python, Go, Kafka, Kubernetes.',
    profileTargetLocations: 'Remote US or New York',
    profileSponsorshipNeed: 'no-sponsorship',
    ...extra,
  }, null, 2))
  const codexCommand = engine === 'codex'
    ? { command: NODE, args: [FAKE_CODEX] }
    : { command: NODE, args: [TRIPWIRE] }
  const app = await electron.launch({
    args: [path.join(APP, 'out', 'main', 'main.js')],
    cwd: APP,
    env: {
      ...process.env,
      E2E_TEST: '1',
      JOBSCAN_USER_DATA_DIR: userData,
      JOBSCAN_E2E_CODEX_COMMAND: JSON.stringify(codexCommand),
      CODEX_TRIPWIRE: files.tripwire,
      FAKE_MODE: 'oracle', FAKE_ORACLE: ORACLE, FAKE_PROMPT_LOG: files.codexLog,
      JOBSCAN_CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_CLAUDE_MODE: 'oracle', FAKE_CLAUDE_ORACLE: ORACLE, FAKE_CLAUDE_LOG: files.claudeLog, FAKE_CLAUDE_LOGGED_IN: '1',
      JOB_AUTOMATOR_SUBMIT: '0', JOB_AUTOMATOR_AI_RECOVERY: '0',
      JOB_AUTOMATOR_CDP_PORT: '9223', JOB_AUTOMATOR_CDP_URL: 'http://127.0.0.1:9223',
      JOB_AUTOMATOR_CHROME_USER_DATA_DIR: path.join(root, 'chrome'),
      CODEX_HOME: codexHome,
    },
    timeout: 60_000,
  })
  const page = await app.firstWindow({ timeout: 30_000 })
  await page.waitForLoadState('domcontentloaded')
  return { app, page, root, userData, files }
}

async function finish(r: Run): Promise<void> {
  await r.app.close().catch(() => { /* gone */ })
  fs.rmSync(r.root, { recursive: true, force: true })
}

const invoke = <T>(page: Page, channel: string, arg?: unknown): Promise<T> =>
  page.evaluate(([c, a]) => (window as unknown as { api: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).api.invoke(c as string, a), [channel, arg] as const) as Promise<T>

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 120_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 300))
  }
}

function harnessCall(info: { port: number; token: string }, method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1', port: info.port, method, path: p,
      headers: { authorization: `Bearer ${info.token}`, ...(data ? { 'content-type': 'application/json' } : {}) },
    }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const lines = (file: string): Array<Record<string, unknown>> =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []

test('Claude mode: a driver finds and rates jobs through the harness; nothing a posting wrote reaches it', async () => {
  const r = await start('claude', { harnessEnabled: true })
  try {
    const harnessFile = path.join(r.userData, 'harness.json')
    await until(async () => fs.existsSync(harnessFile), Boolean, 'harness.json', 30_000)
    const info = JSON.parse(fs.readFileSync(harnessFile, 'utf8')) as { port: number; token: string }

    const status = await harnessCall(info, 'GET', '/v1/status')
    expect(status.status).toBe(200)
    expect(status.json['engine']).toBe('claude')
    expect(status.json['state']).toBe('resume')

    // Refused without the token, and from a web page.
    expect((await harnessCall({ ...info, token: '0'.repeat(64) }, 'GET', '/v1/status')).status).toBe(401)

    expect((await harnessCall(info, 'POST', '/v1/actions/find_jobs', {})).json).toEqual({ ok: true })
    await until(() => harnessCall(info, 'GET', '/v1/status'),
      s => s.json['busy'] === false && s.json['state'] === 'query_gen' && Number(s.json['searches']) >= 5, 'searches')
    expect((await harnessCall(info, 'POST', '/v1/actions/rate_jobs', {})).json).toEqual({ ok: true })
    const rating = await until(() => invoke<{ jobs: Array<{ job_id: string; rating: number }>; done: boolean }>(r.page, 'rating:get-state'),
      v => v.done, 'rating')

    // The oracle's scores, for every job in the pool.
    const qg = await invoke<{ queries: Array<{ name: string }>; total: number }>(r.page, 'query_gen:get-state')
    expect(qg.queries.map(q => q.name)).toEqual(QUERIES.map(q => q.name))
    expect(rating.jobs.length).toBe(qg.total)
    for (const j of rating.jobs) expect(j.rating).toBe(scoreFor(j.job_id))

    // Notices: plenty of them, none carrying a title, company or URL.
    const events = await harnessCall(info, 'GET', '/v1/events?after=0')
    const text = JSON.stringify(events.json)
    const types = new Set((events.json['notices'] as Array<{ type: string }>).map(n => n.type))
    for (const t of ['state', 'ai_call', 'searches_done', 'agent_action']) expect(types.has(t), t).toBe(true)
    for (const job of rows().slice(0, 30)) {
      expect(text.includes(job.title), job.title).toBe(false)
      expect(text.includes(job.company), job.company).toBe(false)
    }
    expect(text.includes('jobs.example.com')).toBe(false)

    // Every Claude call ran isolated; Codex never started; ~/.codex untouched.
    const calls = lines(r.files.claudeLog)
    expect(calls.length).toBeGreaterThan(5)
    for (const c of calls) {
      const argv = c['argv'] as string[]
      expect(argv[argv.indexOf('--tools') + 1]).toBe('')
      expect(argv).toContain('--strict-mcp-config')
      expect((c['env'] as Record<string, string>)['CLAUDE_CODE_DISABLE_ATTACHMENTS']).toBe('1')
      expect(c['cwdEntries']).toEqual([])
    }
    expect(fs.existsSync(r.files.tripwire)).toBe(false)
    expect(fs.readdirSync(r.files.codexHome)).toEqual([])
  } finally {
    await finish(r)
  }
})

async function runPipeline(engine: 'claude' | 'codex'): Promise<{ queryPrompts: string[]; ratingPrompts: string[]; queries: unknown[]; ratings: Record<string, number> }> {
  const r = await start(engine)
  try {
    await until(() => invoke<{ state: string }>(r.page, 'state:get'), s => s.state === 'resume', 'resume screen', 30_000)
    await invoke(r.page, 'pipeline:start-query-gen')
    await invoke(r.page, 'pipeline:start-rating')
    const rating = await until(() => invoke<{ jobs: Array<{ platform: string; job_id: string; rating: number }>; done: boolean }>(r.page, 'rating:get-state'),
      v => v.done, `${engine} rating`)
    const qg = await invoke<{ queries: Array<{ name: string; flags: string }> }>(r.page, 'query_gen:get-state')
    const prompts = engine === 'claude'
      ? lines(r.files.claudeLog).map(c => String(c['stdin']))
      : lines(r.files.codexLog).map(c => String(c['text']))
    return {
      queryPrompts: prompts.filter(p => p.includes(QUERY_MARK)),
      ratingPrompts: prompts.filter(p => p.includes(RATING_MARK)).sort(),
      queries: qg.queries.map(q => ({ name: q.name, flags: q.flags })),
      ratings: Object.fromEntries(rating.jobs.map(j => [`${j.platform}:${j.job_id}`, j.rating])),
    }
  } finally {
    await finish(r)
  }
}

test('parity: Codex and Claude Code get the same prompts and leave the same results', async () => {
  const codex = await runPipeline('codex')
  const claude = await runPipeline('claude')
  expect(codex.queryPrompts.length).toBeGreaterThanOrEqual(5)
  expect(claude.queryPrompts).toEqual(codex.queryPrompts)
  expect(codex.ratingPrompts.length).toBeGreaterThan(0)
  expect(claude.ratingPrompts).toEqual(codex.ratingPrompts)
  expect(claude.queries).toEqual(codex.queries)
  expect(Object.keys(codex.ratings).length).toBeGreaterThan(40)
  expect(claude.ratings).toEqual(codex.ratings)
})
