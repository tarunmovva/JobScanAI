/**
 * The full real run: a real Claude Code session, loaded with the jobscan
 * plugin and nothing else, drives JobScan through the harness -- rebuild,
 * find jobs, rate -- while JobScan's own AI calls run the user's real
 * Claude Code. Then this test picks three Lever/Ashby jobs in the window and
 * the app writes their form answers (the third AI call). Filling is mocked.
 *
 *   npm run build
 *   npx playwright test --config scripts/claude-smoke/playwright.config.ts orchestrator
 *
 * Spends the user's Claude plan. Isolation as smoke.spec.ts, plus:
 *  - the orchestrator runs with no built-in tools, no claude.ai connectors,
 *    the user's other MCP servers disallowed, only the jobscan tools
 *    allowed, no saved transcript -- and the test aborts unless its startup
 *    tool list is exactly the jobscan tools;
 *  - JOB_AUTOMATOR_MOCK=1: fillers report success without touching a form,
 *    and Greenhouse (which the mock does not cover) is never picked;
 *    extraction still opens the employers' public application pages in a
 *    scratch Chrome on port 9223.
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { spawn, execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'

const APP_ROOT = path.resolve(__dirname, '..', '..')
const REPO = path.resolve(APP_ROOT, '..')
const BOARDS: Record<string, string[]> = { greenhouse: ['figma', 'discord'], lever: ['plaid', 'mistral'], ashby: ['notion', 'ramp', 'linear'] }
const SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT', 'CLAUDE_EFFORT', 'CLAUDE_PID', 'ANTHROPIC_API_KEY']

function findClaude(): string {
  if (process.env['SMOKE_CLAUDE_BIN']) return process.env['SMOKE_CLAUDE_BIN']
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  if (fs.existsSync(local)) return local
  return execSync(process.platform === 'win32' ? 'where claude' : 'command -v claude', { encoding: 'utf8' })
    .split(/\r?\n/).map(s => s.trim()).find(p => /claude(\.exe)?$/i.test(p)) ?? ''
}

function harnessCall(info: { port: number; token: string }, p: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: info.port, path: p, headers: { authorization: `Bearer ${info.token}` } }, res => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => { try { resolve(JSON.parse(text)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

test('a real Claude Code session drives JobScan; the app answers forms with Claude', async () => {
  const claude = findClaude()
  expect(claude, 'Claude Code not found; set SMOKE_CLAUDE_BIN').toBeTruthy()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobscan-orchestrator-'))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(path.join(bin, 'data'), { recursive: true })
  const exeName = process.platform === 'win32' ? 'jobscan.exe' : 'jobscan'
  const exe = path.join(bin, exeName)
  fs.copyFileSync(process.env['SMOKE_JOBSCAN_EXE'] ?? path.join(REPO, 'jobscan', exeName), exe)
  for (const [platform, slugs] of Object.entries(BOARDS)) {
    const src = fs.readFileSync(path.join(REPO, 'jobscan', 'data', `finalworkingjobboardname_${platform}.csv`), 'utf8').split(/\r?\n/)
    fs.writeFileSync(path.join(bin, 'data', `finalworkingjobboardname_${platform}.csv`),
      [src[0], ...src.filter(l => slugs.includes(l.split(',')[0]!))].join('\n') + '\n')
  }
  const userData = path.join(root, 'userdata')
  const home = path.join(root, 'home')
  for (const d of [userData, home, path.join(root, 'chrome'), path.join(root, 'codex-home'), path.join(root, 'orchestrator')]) fs.mkdirSync(d, { recursive: true })
  const resumePath = path.join(root, 'alex-rivera-resume.txt')
  const resume = 'Alex Rivera — Software Engineer\nAustin, TX · alex.rivera@example.com · (555) 010-0199\n'
    + '4 years building backend services in Go and Python: Kafka pipelines, PostgreSQL, Kubernetes on AWS.\n'
    + 'B.S. Computer Science, Westbrook University, 2021.'
  fs.writeFileSync(resumePath, resume)
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    aiEngine: 'claude', claudeModel: process.env['SMOKE_MODEL'] ?? 'sonnet', harnessEnabled: true,
    jobscanExePath: exe, jobAutomatorHome: home, pythonDir: path.join(REPO, 'jobscan'), codexAutoUpdate: false,
    ratingAgents: 3, payloadAgents: 2, resumeText: resume, resumePath,
    profileTargetLocations: 'Remote US, or San Francisco / New York', profileSponsorshipNeed: 'no-sponsorship',
    profileVisaSituation: 'US citizen, no restrictions', profileCitizenship: 'United States',
    profileSalaryExpectation: '$140,000 - $165,000', profileGenerateCoverLetter: true,
  }, null, 2))

  const appLogs: string[] = []
  const app = await electron.launch({
    args: [path.join(APP_ROOT, 'out', 'main', 'main.js')], cwd: APP_ROOT, timeout: 60_000,
    env: {
      ...process.env, E2E_TEST: '1', JOBSCAN_USER_DATA_DIR: userData, JOBSCAN_CLAUDE_BIN: claude,
      JOB_AUTOMATOR_SUBMIT: '0', JOB_AUTOMATOR_AI_RECOVERY: '0', JOB_AUTOMATOR_MOCK: '1',
      JOB_AUTOMATOR_CDP_PORT: '9223', JOB_AUTOMATOR_CDP_URL: 'http://127.0.0.1:9223',
      JOB_AUTOMATOR_CHROME_USER_DATA_DIR: path.join(root, 'chrome'), CODEX_HOME: path.join(root, 'codex-home'),
    },
  })
  app.process().stdout?.on('data', d => appLogs.push(String(d)))
  app.process().stderr?.on('data', d => appLogs.push(String(d)))
  const page = await app.firstWindow({ timeout: 30_000 })
  const invoke = <T>(channel: string, arg?: unknown): Promise<T> =>
    page.evaluate(([c, a]) => (window as unknown as { api: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).api.invoke(c as string, a), [channel, arg] as const) as Promise<T>

  const report: Record<string, unknown> = { scratch: root }
  const harnessFile = path.join(userData, 'harness.json')
  let orchestrator: ReturnType<typeof spawn> | null = null
  try {
    for (let i = 0; i < 100 && !fs.existsSync(harnessFile); i++) await page.waitForTimeout(300)
    const info = JSON.parse(fs.readFileSync(harnessFile, 'utf8')) as { port: number; token: string }

    // ── the orchestrator: a real Claude Code with only the jobscan plugin ──
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SESSION_VARS.includes(k)) env[k] = v
    Object.assign(env, { JOBSCAN_HARNESS_FILE: harnessFile, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', DISABLE_AUTOUPDATER: '1' })
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--plugin-dir', path.join(REPO, 'jobscan-harness'), '--setting-sources', 'project',
      '--no-chrome', '--tools', '', '--allowedTools', 'mcp__plugin_jobscan_harness__*',
      '--disallowedTools', 'mcp__playwright__*', 'mcp__plugin_vercel_vercel__*',
      '--permission-mode', 'dontAsk', '--no-session-persistence', '--max-turns', '80',
      '--model', process.env['SMOKE_ORCHESTRATOR_MODEL'] ?? 'haiku',
    ]
    orchestrator = spawn(claude, args, { cwd: path.join(root, 'orchestrator'), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const events: Array<Record<string, unknown>> = []
    let buf = ''
    let results = 0
    orchestrator.stdout!.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        try { const m = JSON.parse(line); events.push(m); if (m.type === 'result') results++ } catch { /* not json */ }
      }
    })
    const say = (text: string): void => {
      orchestrator!.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
    }
    say('/jobscan:jobscan')
    for (let i = 0; i < 300 && !events.some(e => e['type'] === 'system' && e['subtype'] === 'init'); i++) await page.waitForTimeout(200)
    const init = events.find(e => e['type'] === 'system' && e['subtype'] === 'init') as { tools?: string[]; mcp_servers?: Array<{ name: string; status: string }> } | undefined
    expect(init, 'orchestrator started').toBeTruthy()
    report['orchestratorTools'] = init!.tools
    report['orchestratorServers'] = init!.mcp_servers
    // Abort unless the session can do nothing but drive JobScan.
    expect((init!.tools ?? []).filter(t => !t.startsWith('mcp__plugin_jobscan_harness__')), 'tools other than jobscan').toEqual([])
    expect((init!.tools ?? []).length).toBe(4)

    for (let i = 0; i < 300 && results < 1; i++) await page.waitForTimeout(200)
    say('Please rebuild the job database, then find jobs, then rate them. Follow progress with jobscan_wait. '
      + 'When rating has finished, reply with how many jobs were rated, then stop.')

    // Until the app has rated a pool (or 25 minutes).
    let status: Record<string, unknown> = {}
    for (let i = 0; i < 1500; i++) {
      await page.waitForTimeout(1000)
      status = await harnessCall(info, '/v1/status')
      if (Number(status['rated']) > 0 && status['busy'] === false && results >= 2) break
    }
    report['statusAfterDriving'] = status
    expect(Number(status['rated'])).toBeGreaterThan(0)
    orchestrator.stdin!.end()

    const toolCalls: Record<string, number> = {}
    for (const e of events) {
      if (e['type'] !== 'assistant') continue
      for (const c of ((e['message'] as { content?: Array<{ type: string; name?: string }> })?.content ?? [])) {
        if (c.type === 'tool_use' && c.name) toolCalls[c.name] = (toolCalls[c.name] ?? 0) + 1
      }
    }
    report['orchestratorToolCalls'] = toolCalls
    const final = [...events].reverse().find(e => e['type'] === 'result') as Record<string, unknown> | undefined
    report['orchestratorReply'] = String(final?.['result'] ?? '').slice(0, 400)
    report['orchestratorUsage'] = final?.['usage']

    // ── the third AI call: answers for three Lever/Ashby jobs ──
    const rating = await invoke<{ jobs: Array<{ id: string; platform: string; job_id: string; rating: number }> }>('rating:get-state')
    const picks = rating.jobs.filter(j => j.platform !== 'greenhouse').sort((a, b) => b.rating - a.rating).slice(0, 3)
    report['picked'] = picks.map(j => ({ platform: j.platform, rating: j.rating }))
    expect(picks.length).toBeGreaterThan(0)
    await invoke('selection:confirm', { jobIds: picks.map(j => j.id) })
    await invoke('pipeline:start-extract')
    for (let i = 0; i < 900; i++) {
      await page.waitForTimeout(1000)
      const s = await invoke<{ state: string }>('state:get')
      const busy = (await harnessCall(info, '/v1/status'))['busy']
      if (s.state === 'done' || (s.state === 'board' && busy === false && i > 20)) break
    }
    const payloads = picks.map(j => {
      const f = path.join(home, 'applications', j.platform, j.job_id, 'fill_payload.json')
      if (!fs.existsSync(f)) return { platform: j.platform, payload: false }
      const p = JSON.parse(fs.readFileSync(f, 'utf8')) as { answers?: Record<string, unknown>; cover_letter?: string; resume_path?: string; fields?: Array<{ type: string; id: string }> }
      const fileFields = (p.fields ?? []).filter(x => x.type === 'file').map(x => x.id)
      return {
        platform: j.platform, payload: true, fields: (p.fields ?? []).length, answers: Object.keys(p.answers ?? {}).length,
        coverLetterWords: String(p.cover_letter ?? '').split(/\s+/).filter(Boolean).length,
        resumePathSet: p.resume_path === resumePath,
        fileAnswers: fileFields.map(id => String(p.answers?.[id] ?? '')),
      }
    })
    report['payloads'] = payloads
    expect(payloads.some(p => p.payload && Number(p.answers) > 0), 'at least one form answered').toBe(true)
  } finally {
    try { orchestrator?.kill() } catch { /* gone */ }
    const lines = appLogs.join('').split(/\r?\n/)
    const byKind: Record<string, { calls: number; ok: number; ms: number; tokensIn: number; tokensOut: number }> = {}
    for (const l of lines) {
      const m = /^\[claude\] (\S+) (\S+) (\d+)ms(?: in=(\d+) cache_write=(\d+) cache_read=(\d+) out=(\d+))?/.exec(l)
      if (!m) continue
      const k = byKind[m[1]!] ??= { calls: 0, ok: 0, ms: 0, tokensIn: 0, tokensOut: 0 }
      k.calls++; if (m[2] === 'ok') k.ok++
      k.ms += Number(m[3]); k.tokensIn += Number(m[4] ?? 0) + Number(m[5] ?? 0) + Number(m[6] ?? 0); k.tokensOut += Number(m[7] ?? 0)
    }
    report['appClaudeCalls'] = byKind
    report['appErrors'] = lines.filter(l => /error|failed/i.test(l) && !l.startsWith('[claude]')).slice(0, 20)
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
    console.log('\n===== ORCHESTRATOR REPORT =====\n' + JSON.stringify(report, null, 2))
    await app.close().catch(() => { /* gone */ })
    // A scratch Chrome on 9223, if extraction started one, goes with the folder.
    try {
      if (process.platform === 'win32') execSync(`wmic process where "commandline like '%${path.basename(root)}%' and name='chrome.exe'" call terminate`, { stdio: 'ignore' })
    } catch { /* none */ }
    if (process.env['SMOKE_KEEP'] !== '1') fs.rmSync(root, { recursive: true, force: true })
  }
})
