/**
 * A real run of JobScan with the Claude engine: the user's own Claude Code
 * writes the searches and rates the jobs, against a small real job database.
 *
 *   npm run build
 *   npx playwright test --config scripts/claude-smoke/playwright.config.ts
 *
 * Spends the user's Claude plan. Everything else is isolated:
 *  - a scratch folder holds the settings (JOBSCAN_USER_DATA_DIR), a copy of
 *    the jobscan binary with an 8-board list, its own job database, the
 *    automation home, a Chrome profile and a Codex home -- the real ones are
 *    never read or written;
 *  - Chrome, if anything started it, would be on port 9223, never the user's
 *    9222; JOB_AUTOMATOR_SUBMIT=0 and AI recovery is off; nothing here even
 *    reaches extraction or form filling;
 *  - E2E_TEST=1, so Codex cannot start at all and Claude Code is only the
 *    binary named by JOBSCAN_CLAUDE_BIN.
 *
 * Env: SMOKE_CLAUDE_BIN (default: claude.exe in ~/.local/bin or on PATH),
 *      SMOKE_MODEL (default sonnet), SMOKE_JOBSCAN_EXE (default: the main
 *      checkout's jobscan/jobscan.exe), SMOKE_KEEP=1 keeps the scratch folder.
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { endRun } from './teardown'

const APP_ROOT = path.resolve(__dirname, '..', '..')
const REPO = path.resolve(APP_ROOT, '..')
const BOARDS: Record<string, string[]> = {
  greenhouse: ['figma', 'discord', 'airtable'],
  lever: ['plaid', 'mistral'],
  ashby: ['notion', 'ramp', 'linear'],
}

function findClaude(): string {
  if (process.env['SMOKE_CLAUDE_BIN']) return process.env['SMOKE_CLAUDE_BIN']
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  if (fs.existsSync(local)) return local
  const cmd = process.platform === 'win32' ? 'where claude' : 'command -v claude'
  return execSync(cmd, { encoding: 'utf8' }).split(/\r?\n/).map(s => s.trim()).find(p => /claude(\.exe)?$/i.test(p)) ?? ''
}

function scratch(): { root: string; exe: string; userData: string; env: Record<string, string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobscan-claude-smoke-'))
  const bin = path.join(root, 'bin')
  const data = path.join(bin, 'data')
  fs.mkdirSync(data, { recursive: true })
  const exeSource = process.env['SMOKE_JOBSCAN_EXE']
    ?? path.resolve(REPO, '..', 'jobscan-ai', 'jobscan', process.platform === 'win32' ? 'jobscan.exe' : 'jobscan')
  const exe = path.join(bin, path.basename(exeSource))
  fs.copyFileSync(exeSource, exe)
  for (const [platform, slugs] of Object.entries(BOARDS)) {
    const src = fs.readFileSync(path.join(REPO, 'jobscan', 'data', `finalworkingjobboardname_${platform}.csv`), 'utf8').split(/\r?\n/)
    const keep = [src[0], ...src.filter(l => slugs.includes(l.split(',')[0]!))]
    fs.writeFileSync(path.join(data, `finalworkingjobboardname_${platform}.csv`), keep.join('\n') + '\n')
  }
  const userData = path.join(root, 'userdata')
  for (const d of ['home', 'chrome', 'codex-home', 'userdata']) fs.mkdirSync(path.join(root, d), { recursive: true })
  const env: Record<string, string> = {
    E2E_TEST: '1',
    JOBSCAN_USER_DATA_DIR: userData,
    JOBSCAN_CLAUDE_BIN: findClaude(),
    JOB_AUTOMATOR_SUBMIT: '0',
    JOB_AUTOMATOR_AI_RECOVERY: '0',
    JOB_AUTOMATOR_CDP_PORT: '9223',
    JOB_AUTOMATOR_CDP_URL: 'http://127.0.0.1:9223',
    JOB_AUTOMATOR_CHROME_USER_DATA_DIR: path.join(root, 'chrome'),
    CODEX_HOME: path.join(root, 'codex-home'),
  }
  return { root, exe, userData, env }
}

const RESUME = [
  'Alex Rivera — Software Engineer',
  'Austin, TX · alex.rivera@example.com',
  '4 years building backend services in Go and Python: event pipelines on Kafka,',
  'PostgreSQL, Kubernetes on AWS. Led the move of a billing service to gRPC.',
  'Built internal developer tooling and CI pipelines; on-call for payments APIs.',
  'B.S. Computer Science, Westbrook University.',
].join('\n')

test('Claude Code writes the searches and rates the jobs', async () => {
  const s = scratch()
  expect(s.env['JOBSCAN_CLAUDE_BIN'], 'Claude Code not found; set SMOKE_CLAUDE_BIN').toBeTruthy()
  fs.writeFileSync(path.join(s.userData, 'config.json'), JSON.stringify({
    aiEngine: 'claude',
    claudeModel: process.env['SMOKE_MODEL'] ?? 'sonnet',
    jobscanExePath: s.exe,
    jobAutomatorHome: path.join(s.root, 'home'),
    pythonDir: path.join(REPO, 'jobscan'),
    ratingAgents: 3,
    payloadAgents: 2,
    resumeText: RESUME,
    profileTargetLocations: 'Remote US, or San Francisco / New York',
    profileSearchInstructions: 'Backend, platform or infrastructure engineering roles.',
    profileVisaSituation: 'US citizen, no restrictions',
    profileSponsorshipNeed: 'no-sponsorship',
    profileCitizenship: 'United States',
  }, null, 2))

  const logs: string[] = []
  const app = await electron.launch({
    args: [path.join(APP_ROOT, 'out', 'main', 'main.js')],
    cwd: APP_ROOT,
    env: { ...process.env, ...s.env } as Record<string, string>,
    timeout: 60_000,
  })
  app.process().stdout?.on('data', d => logs.push(String(d)))
  app.process().stderr?.on('data', d => logs.push(String(d)))
  const page = await app.firstWindow({ timeout: 30_000 })
  await page.waitForLoadState('domcontentloaded')
  const invoke = <T>(channel: string, arg?: unknown): Promise<T> =>
    page.evaluate(([c, a]) => (window as unknown as { api: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).api.invoke(c as string, a), [channel, arg] as const) as Promise<T>

  const report: Record<string, unknown> = { scratch: s.root, model: process.env['SMOKE_MODEL'] ?? 'sonnet' }
  try {
    // 1. A small real rebuild: the 8 boards above, fetched from their public APIs.
    const t0 = Date.now()
    await invoke('fetch:start')
    let fetch: { status: string; jobsAdded: number | null } = { status: 'running', jobsAdded: null }
    for (let i = 0; i < 600 && (fetch.status === 'running' || fetch.status === 'idle'); i++) {
      await page.waitForTimeout(1000)
      fetch = await invoke('fetch:get-state')
    }
    report['rebuild'] = { status: fetch.status, jobsAdded: fetch.jobsAdded, seconds: Math.round((Date.now() - t0) / 1000) }
    expect(fetch.status).toBe('success')
    await invoke('fetch:cancel')                 // dismiss the finished fetch screen -> Resume

    // 2. Claude writes the searches (one call per query, in order).
    const t1 = Date.now()
    await invoke('pipeline:start-query-gen')
    const qg = await invoke<{ queries: Array<{ name: string; flags: string; count?: number }>; total: number }>('query_gen:get-state')
    report['searches'] = { seconds: Math.round((Date.now() - t1) / 1000), count: qg.queries.length, pool: qg.total, queries: qg.queries.map(q => ({ name: q.name, flags: q.flags, count: q.count })) }
    expect(qg.queries.length).toBeGreaterThan(0)
    expect(qg.total).toBeGreaterThan(0)

    // 3. Claude rates the pool.
    const t2 = Date.now()
    await invoke('pipeline:start-rating')
    let rating = await invoke<{ jobs: Array<{ rating: number }>; done: boolean }>('rating:get-state')
    for (let i = 0; i < 900 && !rating.done; i++) {
      await page.waitForTimeout(1000)
      rating = await invoke('rating:get-state')
    }
    const scores = rating.jobs.map(j => j.rating)
    const histogram: Record<string, number> = {}
    for (const r of scores) histogram[String(r)] = (histogram[String(r)] ?? 0) + 1
    report['rating'] = { seconds: Math.round((Date.now() - t2) / 1000), rated: scores.length, of: qg.total, histogram }
    expect(scores.length).toBeGreaterThan(0)
    for (const r of scores) expect(r >= 1 && r <= 10).toBe(true)
  } finally {
    const claudeLines = logs.join('').split(/\r?\n/).filter(l => l.startsWith('[claude]'))
    const byKind: Record<string, { calls: number; ok: number; ms: number; in: number; cacheWrite: number; cacheRead: number; out: number }> = {}
    for (const l of claudeLines) {
      const m = /^\[claude\] (\S+) (\S+) (\d+)ms(?: in=(\d+) cache_write=(\d+) cache_read=(\d+) out=(\d+))?/.exec(l)
      if (!m) continue
      const k = byKind[m[1]!] ??= { calls: 0, ok: 0, ms: 0, in: 0, cacheWrite: 0, cacheRead: 0, out: 0 }
      k.calls++; if (m[2] === 'ok') k.ok++
      k.ms += Number(m[3]); k.in += Number(m[4] ?? 0); k.cacheWrite += Number(m[5] ?? 0); k.cacheRead += Number(m[6] ?? 0); k.out += Number(m[7] ?? 0)
    }
    report['claudeCalls'] = byKind
    report['codexStarted'] = logs.join('').includes('jobscan-e2e-codex-disabled')
    report['errors'] = logs.join('').split(/\r?\n/).filter(l => /error|failed/i.test(l) && !/^\[claude\]/.test(l)).slice(0, 15)
    fs.writeFileSync(path.join(s.root, 'report.json'), JSON.stringify(report, null, 2))
    console.log('\n===== SMOKE REPORT =====\n' + JSON.stringify(report, null, 2))
    console.log(`app ${await endRun(app, s.root)}`)
    if (process.env['SMOKE_KEEP'] !== '1') fs.rmSync(s.root, { recursive: true, force: true })
  }
})
