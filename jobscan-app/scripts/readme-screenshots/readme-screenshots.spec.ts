/**
 * Regenerates the screenshots in docs/screenshots/ that the README shows.
 *
 *   cd jobscan-app
 *   npm run build
 *   npx playwright test --config scripts/readme-screenshots/playwright.config.ts
 *
 * Every screen is rendered by the real app with SAMPLE data: a made-up
 * candidate and made-up companies. Nothing reaches Codex, Claude Code,
 * jobscan or Chrome (E2E_TEST=1), and the app runs on a throwaway data folder
 * (JOBSCAN_USER_DATA_DIR) and Codex home, so your own profile, resume,
 * history and sign-in are never read or touched. Codex counts as installed
 * through the test stand-in (it is never asked anything), so the sign-in
 * screen and Settings look the way they do for a user who has it.
 *
 * Screens whose state lives only in the main process (the rebuild progress,
 * loop mode, the IMAP status) are fed by swapping that one IPC handler for a
 * fixed answer before the window reloads.
 */
import { test, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'
import http from 'http'

const APP_ROOT = path.resolve(__dirname, '..', '..')
const OUT_DIR = path.resolve(APP_ROOT, '..', 'docs', 'screenshots')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobscan-readme-shots-'))
const CONFIG = path.join(DATA_DIR, 'config.json')
const CODEX_STAND_IN = { command: process.execPath, args: [path.join(APP_ROOT, 'tests', 'unit', 'fixtures', 'fake-app-server.cjs')] }

const W = 1440
const H = 900

// ── Sample data (all fictional) ──────────────────────────────────────────────

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

const RESUME_TEXT = [
  'Alex Rivera — Software Engineer',
  'Austin, TX · alex.rivera@example.com',
  '4 years building backend services in Go and Python: event pipelines on Kafka,',
  'PostgreSQL, Kubernetes on AWS. Led the move of a billing service to gRPC.',
  'B.S. Computer Science, Westbrook University.',
].join('\n')

const PROFILE = {
  resumePath: path.join(DATA_DIR, 'alex-rivera-resume.pdf'),
  resumeText: RESUME_TEXT,
  profileTargetLocations: 'Austin TX, or Remote US',
  profileSearchInstructions: 'Prefer roles posted in the last 30 days. Skip ad-tech and crypto.',
  profileVisaSituation: 'US citizen, no restrictions',
  profileSponsorshipNeed: 'no-sponsorship',
  profileSalaryExpectation: '$140,000 - $165,000',
  profileGenerateCoverLetter: true,
  profileCitizenship: 'United States',
}

const QUERIES = [
  { name: 'title_backbone_austin_remote', flags: "--title-query \"'software engineer' OR 'backend engineer' OR 'platform engineer'\" --market usa --location \"Austin\" --since 30d", description: 'Every plausible backend title in Austin, posted in the last 30 days.' },
  { name: 'go_kafka_stack', flags: "--key-query \"Go AND (Kafka OR 'event streaming')\" --title-query \"engineer AND NOT (staff OR principal OR director)\" --market usa", description: 'Go + Kafka event-pipeline roles at the right level.' },
  { name: 'python_aws_k8s_remote', flags: "--key-query \"Python AND (AWS OR Kubernetes)\" --remote --market usa", description: 'Remote US Python roles on AWS or Kubernetes.' },
  { name: 'distributed_systems_domain', flags: "--key-query \"'distributed systems' AND (gRPC OR PostgreSQL)\" --market usa --since 30d", description: 'Distributed-systems work with a gRPC or Postgres stack.' },
  { name: 'platform_sre_adjacent', flags: "--title-query \"'site reliability' OR 'infrastructure engineer'\" --market usa --remote", description: 'Adjacent SRE / infrastructure titles the resume supports.' },
  { name: 'billing_payments_domain', flags: "--key-query \"(billing OR payments) AND (Go OR Python)\" --market usa", description: 'Billing and payments backends, matching past domain work.' },
]
const COUNTS = [212, 187, 164, 231, 143, 96]
const FOUND = [100, 81, 64, 58, 37, 22]

const COMPANIES: Array<[string, string, string]> = [
  ['northwind-robotics', 'Northwind Robotics', 'greenhouse'],
  ['lumen-pay', 'Lumen Pay', 'ashby'],
  ['cobalt-data', 'Cobalt Data', 'lever'],
  ['fernway-health', 'Fernway Health', 'greenhouse'],
  ['quarry-systems', 'Quarry Systems', 'ashby'],
  ['atlas-freight', 'Atlas Freight', 'lever'],
  ['brightloop', 'Brightloop', 'greenhouse'],
  ['kestrel-ai', 'Kestrel AI', 'ashby'],
  ['harbor-analytics', 'Harbor Analytics', 'greenhouse'],
  ['tidewater-cloud', 'Tidewater Cloud', 'lever'],
  ['meridian-labs', 'Meridian Labs', 'greenhouse'],
  ['orchid-security', 'Orchid Security', 'ashby'],
]
const TITLES = [
  'Backend Engineer, Fleet Telemetry', 'Software Engineer II, Payments Platform', 'Platform Engineer',
  'Backend Engineer — Claims Pipeline', 'Software Engineer, Distributed Storage', 'Backend Engineer (Go)',
  'Software Engineer, Billing', 'Senior Software Engineer, Inference Serving', 'Data Platform Engineer',
  'Site Reliability Engineer', 'Software Engineer, Developer Tools', 'Staff Engineer, Detection',
]
const LOCATIONS = [
  'Austin, TX', 'Remote — US', 'Austin, TX (Hybrid)', 'Remote — US', 'Remote — US', 'Austin, TX',
  'Remote — US', 'San Francisco, CA', 'Remote — US', 'Denver, CO', 'Austin, TX', 'New York, NY',
]
const RATINGS = [10, 9, 9, 8, 8, 8, 7, 6, 6, 5, 4, 3]
const REASONS = [
  'Go + Kafka telemetry matches resume; 4yr fits; Austin is a target.',
  'Payments backend in Go mirrors billing work; remote US fits.',
  'Kubernetes/AWS platform work matches; hybrid Austin is a target.',
  'Python event pipelines match; level fits; remote US.',
  'Distributed storage in Go; slight gap on storage internals.',
  'Strong Go match; Austin onsite; smaller team than past roles.',
  'Billing domain match; stack is mostly Ruby, a real gap.',
  'Senior inference role; SF onsite is not a target location.',
  'Spark-heavy data platform; Python fits, Spark is a gap.',
  'SRE in Denver; not a target city, on-call heavy.',
  'Developer tools in TypeScript; little backend overlap.',
  'Staff level with 8+ years asked; well above resume.',
]

const ABBR: Record<string, string> = { greenhouse: 'gh', lever: 'lv', ashby: 'ab' }

const JOBS = COMPANIES.map(([slug, name, platform], i) => {
  const jobId = `${4100 + i * 37}`
  return {
    id: `${ABBR[platform]}:${slug}:${jobId}`,
    job_id: jobId,
    company: name,
    company_slug: slug,
    title: TITLES[i],
    location: LOCATIONS[i],
    workplace_type: LOCATIONS[i].includes('Remote') ? 'remote' : LOCATIONS[i].includes('Hybrid') ? 'hybrid' : 'onsite',
    employment_type: 'full-time',
    platform,
    job_url: `https://example.com/jobs/${slug}/${jobId}`,
    apply_url: `https://example.com/apply/${slug}/${jobId}`,
    description: [
      `${name} is hiring a ${TITLES[i]} to build and run the services behind its core product.`,
      '',
      "What you'll do",
      '• Design, build and operate backend services in Go and Python',
      '• Own event pipelines on Kafka and the PostgreSQL stores behind them',
      '• Run what you ship on Kubernetes, with on-call shared across the team',
      '',
      "What you'll need",
      '• 3+ years building production backend systems',
      '• Experience with distributed systems, queues and relational databases',
      '• Comfort with AWS or GCP and infrastructure-as-code',
    ].join('\n'),
    salary_raw: i % 3 === 0 ? '$150,000 - $180,000' : '',
    posted_at: ago((1 + i) * DAY),
  }
})
const RATED_TOP = JOBS.map((j, i) => ({ ...j, rating: RATINGS[i], reason: REASONS[i] }))

// The rest of the pool: what six queries really return, mostly weaker fits.
const FILLER_COMPANIES = ['Juniper Grid', 'Sable Logistics', 'Pinecrest Bio', 'Vantage Retail', 'Copperline', 'Driftwood Media', 'Ironbark Energy', 'Wren Insurance']
const FILLER_TITLES = ['Software Engineer', 'Backend Developer', 'Full Stack Engineer', 'Infrastructure Engineer', 'Software Engineer, Integrations', 'Data Engineer']
const FILLER_REASONS = ['Partial overlap; stack is mostly Java.', 'Right role, but onsite outside target cities.', 'Frontend-heavy; little backend work.', 'Level fits; domain is unrelated.', 'Good stack match; no remote option.']
const POOL_SIZE = FOUND.reduce((a, b) => a + b, 0)
const FILLER = Array.from({ length: POOL_SIZE - JOBS.length }, (_, k) => {
  const platform = ['greenhouse', 'lever', 'ashby'][k % 3]
  const company = FILLER_COMPANIES[k % FILLER_COMPANIES.length]
  const slug = company.toLowerCase().replace(/\s+/g, '-')
  const jobId = `${7000 + k}`
  return {
    ...JOBS[0],
    id: `${ABBR[platform]}:${slug}:${jobId}`, job_id: jobId, company, company_slug: slug, platform,
    title: FILLER_TITLES[k % FILLER_TITLES.length], location: k % 2 ? 'Remote — US' : 'Chicago, IL',
    workplace_type: k % 2 ? 'remote' : 'onsite', salary_raw: '',
    job_url: `https://example.com/jobs/${slug}/${jobId}`, apply_url: `https://example.com/apply/${slug}/${jobId}`,
    posted_at: ago((2 + (k % 20)) * DAY),
  }
})
const POOL = [...JOBS, ...FILLER]
const RATED = [...RATED_TOP, ...FILLER.map((j, k) => ({ ...j, rating: [7, 6, 5, 5, 4, 3, 2][k % 7], reason: FILLER_REASONS[k % FILLER_REASONS.length] }))]

const card = (i: number, column: string, extra: Record<string, unknown> = {}) => {
  const j = JOBS[i]
  return {
    key: `${j.platform}:${j.job_id}`,
    platform: j.platform,
    jobId: j.job_id,
    company: j.company,
    title: j.title,
    applyUrl: j.apply_url,
    column,
    updatedAt: ago((12 - i) * 60_000),
    ...extra,
  }
}
const BOARD = Object.fromEntries([
  card(0, 'done', { detail: '✓ submitted', agentId: 'app-0' }),
  card(1, 'done', { detail: '✓ submitted', agentId: 'app-1' }),
  card(2, 'applying', { detail: 'Filling form...', agentId: 'app-2' }),
  card(3, 'applying', { detail: 'Generating answers...', agentId: 'app-3' }),
  card(4, 'applying', { detail: 'Filling form...', agentId: 'app-4' }),
  card(5, 'extracted'),
  card(6, 'todo'),
  card(7, 'defect', { defect: 'needs_you', needsYou: 'CAPTCHA challenge — clear it in the open tab and submit', detail: 'blocked_captcha_puzzle', agentId: 'app-0' }),
  card(8, 'defect', { defect: 'error', detail: 'posting_closed', agentId: 'app-1' }),
].map(c => [c.key, c]))

const result = (i: number, status: string, message: string, via: string, ageMs: number) => ({
  company: JOBS[i].company_slug, jobId: JOBS[i].job_id, platform: JOBS[i].platform, title: JOBS[i].title,
  applyUrl: JOBS[i].apply_url, status, message, via, ts: ago(ageMs),
})
const DONE = [
  result(0, 'submitted', 'submitted', 'manual', 3 * 60_000),
  result(1, 'submitted', 'submitted', 'manual', 4 * 60_000),
  result(2, 'submitted', 'submitted', 'manual', 6 * 60_000),
  result(3, 'submitted', 'submitted', 'manual', 7 * 60_000),
  { ...result(7, 'failed', 'blocked_captcha_puzzle', 'manual', 8 * 60_000), needsYou: 'CAPTCHA challenge — clear it in the open tab and submit' },
  result(8, 'failed', 'posting_closed: this job is no longer accepting applications', 'manual', 9 * 60_000),
]
const HISTORY = [
  ...DONE,
  result(4, 'submitted', 'submitted', 'auto', 5 * HOUR),
  result(5, 'submitted', 'submitted', 'auto', 5 * HOUR + 4 * 60_000),
  { ...result(9, 'failed', 'otp_timeout', 'auto', 6 * HOUR), needsYou: 'Verification code never arrived — finish in the open tab' },
  result(10, 'submitted', 'submitted', 'auto', 29 * HOUR),
  result(11, 'submitted', 'submitted', 'manual', 2 * DAY),
]

const round = (startAgo: number, mins: number, r: Record<string, number | boolean | string>) => ({
  startedAt: ago(startAgo), endedAt: ago(startAgo - mins * 60_000), searched: true, ...r,
})
const LOOP_STATUS = {
  phase: 'running',
  round: 6,
  stage: 'apply',
  nextAt: null,
  waitReason: '',
  codexUsage: { fiveHour: 38, weekly: 21 },
  stopReason: '',
  today: { attempted: 14, limit: 25 },
  paused: [{ platform: 'lever', until: new Date(Date.now() + 2 * HOUR).toISOString() }],
  excluded: [
    { key: 'ashby:4359', reason: 'captcha', at: ago(3 * HOUR), title: TITLES[7], company: 'Kestrel AI' },
    { key: 'lever:4433', reason: 'unconfirmed', at: ago(9 * HOUR), title: TITLES[9], company: 'Tidewater Cloud' },
  ],
  history: [
    round(70 * 60_000, 41, { newJobs: 63, newlyRated: 63, selected: 5, submitted: 4, failed: 1, skipped: 0 }),
    round(3 * HOUR, 37, { newJobs: 48, newlyRated: 48, selected: 4, submitted: 3, failed: 0, skipped: 1 }),
    round(5 * HOUR, 52, { newJobs: 91, newlyRated: 91, selected: 5, submitted: 5, failed: 0, skipped: 0 }),
    round(7 * HOUR, 18, { newJobs: 0, newlyRated: 0, selected: 0, submitted: 0, failed: 0, skipped: 0, error: 'Codex usage limit', codexLimit: true }),
  ],
  settings: { threshold: 8, dailyLimit: 25, minGapMin: 60 },
}

const FETCH_RUNNING = {
  status: 'running', phase: 'fetch', companiesTotal: 13_695, companiesDone: 8_412, jobsSoFar: 171_356,
  jobsAdded: null, errorCount: null, emptyBoards: null, durations: { load: '41ms' },
  startedAt: Date.now() - 94_000, finishedAt: null, exitCode: null, lines: [],
}

const FETCH_DONE = {
  status: 'success', phase: 'done', companiesTotal: 13_695, companiesDone: 13_695, jobsSoFar: 271_904,
  jobsAdded: 271_904, errorCount: 212, emptyBoards: 3_870,
  durations: { load: '41ms', fetch: '3m52s', ftsTable: '2ms', ftsRebuild: '48.1s', ftsTriggers: '3ms', index: '19.6s', checkpoint: '1.2s', swap: '84ms', total: '5m3s' },
  startedAt: Date.now() - 303_000, finishedAt: Date.now(), exitCode: 0, lines: [],
}

// ── Harness ──────────────────────────────────────────────────────────────────

function patch(p: Record<string, unknown>): void {
  let cur: Record<string, unknown> = {}
  try { cur = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')) } catch { /* first write */ }
  fs.writeFileSync(CONFIG, JSON.stringify({ ...cur, ...p }, null, 2), 'utf-8')
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(APP_ROOT, 'out', 'main', 'main.js')],
    cwd: APP_ROOT,
    env: {
      ...process.env, E2E_TEST: '1', JOBSCAN_USER_DATA_DIR: DATA_DIR,
      CODEX_HOME: path.join(DATA_DIR, 'codex-home'), JOBSCAN_E2E_CODEX_COMMAND: JSON.stringify(CODEX_STAND_IN),
    },
    timeout: 30_000,
  })
  const page = await app.firstWindow({ timeout: 20_000 })
  await page.waitForLoadState('domcontentloaded')
  await page.locator('header').waitFor({ state: 'visible', timeout: 15_000 })
  await app.evaluate(({ BrowserWindow }, size) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(size.w, size.h)
    w.center()
  }, { w: W, h: H })
  return { app, page }
}

/** Replace one invoke handler in main with a fixed answer. */
async function stub(app: ElectronApplication, channel: string, value: unknown): Promise<void> {
  await app.evaluate(({ ipcMain }, a) => {
    ipcMain.removeHandler(a.channel)
    ipcMain.handle(a.channel, () => a.value)
  }, { channel, value })
}

async function seed(page: Page, p: Record<string, unknown>): Promise<void> {
  patch(p)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.locator('header').waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(900)   // screen entrance + ambient background settle
}

/** One authorised call to the app's harness endpoint, as the jobscan plugin makes it. */
function harnessCall(method: string, route: string, body?: unknown): Promise<number> {
  const { port, token } = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'harness.json'), 'utf-8')) as { port: number; token: string }
  const data = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: route, method,
      headers: { authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json' } : {}) },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    req.on('error', reject)
    req.end(data)
  })
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) })
}

const BASE = {
  ...PROFILE,
  lastFetchAt: ago(25 * 60_000),
  appliedJobsLog: [],
  appliedJobIds: [],
}

const IMAP_OK = { configured: true, host: 'imap.gmail.com', port: 993, username: 'alex.rivera@example.com' }
// Only keeps the picker from warning that the list is unavailable; the shot shows Auto.
const MODELS = { models: [{ id: 'example-model', label: 'Example model' }], error: null }

// ── Shots ────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' })

test.afterAll(() => { fs.rmSync(DATA_DIR, { recursive: true, force: true }) })

test('screens', async () => {
  test.setTimeout(240_000)
  const { app, page } = await launch()
  try {
    await stub(app, 'imap:get-config', IMAP_OK)
    await stub(app, 'codex:list-models', MODELS)
    await stub(app, 'loop:get-status', { ...LOOP_STATUS, phase: 'off', round: 0, stage: null, paused: [], excluded: [], history: [] })

    // 01 sign in
    await seed(page, { appState: 'auth' })
    await shot(page, '01-sign-in')

    // 02 resume + profile
    await seed(page, { ...BASE, appState: 'resume' })
    await shot(page, '02-resume-profile')
    const scroller = page.locator('main, [class*="overflow-y-auto"]').first()
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight }).catch(() => {})
    await page.mouse.wheel(0, 4000)
    await page.waitForTimeout(400)
    await shot(page, '03-resume-profile-otp')
    await page.getByText('Citizenship', { exact: false }).first().evaluate(el => el.scrollIntoView({ block: 'start' }))
    await page.mouse.wheel(0, -260)
    await page.waitForTimeout(500)
    await shot(page, '02b-resume-authorization')

    // OTP mailbox setup, as a first-time user sees it
    await stub(app, 'imap:get-config', { configured: false })
    await seed(page, { ...BASE, appState: 'resume' })
    // Not configured: the form opens on its own.
    await page.getByText('Email for OTP Verification').first().evaluate(el => el.scrollIntoView({ block: 'start' }))
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(500)
    await shot(page, '03b-otp-setup')
    await stub(app, 'imap:get-config', IMAP_OK)

    // 04 database rebuild
    await stub(app, 'fetch:get-state', FETCH_RUNNING)
    await seed(page, { ...BASE, appState: 'fetching' })
    await shot(page, '04-rebuild-running')
    await stub(app, 'fetch:get-state', FETCH_DONE)
    await seed(page, { ...BASE, appState: 'fetching' })
    await shot(page, '04b-rebuild-done')

    // 05 find jobs (query agent, mid-run)
    await seed(page, {
      ...BASE, appState: 'query_gen',
      queryList: QUERIES.slice(0, 3).map((q, i) => ({ ...q, count: COUNTS[i] })),
      queryGenResults: QUERIES.slice(0, 3).map((q, i) => ({ index: i, query: { ...q, count: COUNTS[i] }, found: FOUND[i], totalAfter: FOUND.slice(0, i + 1).reduce((a, b) => a + b, 0) })),
      candidates: POOL.slice(0, FOUND[0] + FOUND[1] + FOUND[2]),
    })
    await shot(page, '05-find-jobs-running')

    // 06 find jobs done
    let running = 0
    await seed(page, {
      ...BASE, appState: 'query_gen',
      queryList: QUERIES.map((q, i) => ({ ...q, count: COUNTS[i] })),
      queryGenResults: QUERIES.map((q, i) => { running += FOUND[i]; return { index: i, query: { ...q, count: COUNTS[i] }, found: FOUND[i], totalAfter: running } }),
      candidates: POOL,
    })
    await shot(page, '06-find-jobs-done')
    await page.getByText('go kafka stack').first().click()
    await page.waitForTimeout(400)
    await shot(page, '06b-find-jobs-query-detail')

    // 07 rating
    await seed(page, { ...BASE, appState: 'rating', candidates: POOL, ratedJobs: RATED })
    await shot(page, '07-rating')
    await page.getByText(TITLES[0]).first().click()
    await page.waitForTimeout(400)
    await shot(page, '08-rating-detail')

    // 09 applications board
    await seed(page, {
      ...BASE, appState: 'board',
      candidates: POOL, ratedJobs: RATED,
      selectedJobIds: JOBS.slice(0, 9).map(j => j.id),
      boardCards: BOARD,
    })
    await shot(page, '09-board')
    await page.getByRole('button', { name: /Chrome tab labels/ }).click()
    await page.waitForTimeout(300)
    await page.mouse.wheel(0, 2000)
    await page.waitForTimeout(300)
    await shot(page, '09b-board-tab-labels')

    // 10 done
    await seed(page, { ...BASE, appState: 'done', doneSummary: DONE, appliedJobsLog: HISTORY })
    await shot(page, '10-done')

    // 11 settings, 12 history
    await seed(page, { ...BASE, appState: 'resume', appliedJobsLog: HISTORY })
    await page.locator('button[title="Settings"]').click()
    await page.waitForTimeout(500)
    await shot(page, '11-settings')
    await page.getByRole('button', { name: 'View history →' }).click()
    await page.waitForTimeout(500)
    await shot(page, '12-applied-history')

    // 13 loop mode
    await stub(app, 'loop:get-status', LOOP_STATUS)
    await seed(page, { ...BASE, appState: 'board', appliedJobsLog: HISTORY, boardCards: BOARD, selectedJobIds: JOBS.slice(0, 9).map(j => j.id) })
    await shot(page, '13-loop-chip')
    await page.locator('button[title="Loop mode"]').click()
    await page.waitForTimeout(500)
    await shot(page, '14-loop-panel')
    await page.keyboard.press('Escape')

    // 15 a Claude Code or Codex session driving JobScan: the header chip and its notes
    await stub(app, 'loop:get-status', { ...LOOP_STATUS, phase: 'off', round: 0, stage: null, paused: [], excluded: [], history: [] })
    let found = 0
    await seed(page, {
      ...BASE, appState: 'query_gen',
      queryList: QUERIES.map((q, i) => ({ ...q, count: COUNTS[i] })),
      queryGenResults: QUERIES.map((q, i) => { found += FOUND[i]; return { index: i, query: { ...q, count: COUNTS[i] }, found: FOUND[i], totalAfter: found } }),
      candidates: POOL,
    })
    await page.evaluate(() => (window as unknown as { api: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).api.invoke('harness:set', { enabled: true }))
    for (let i = 0; i < 50 && !fs.existsSync(path.join(DATA_DIR, 'harness.json')); i++) await page.waitForTimeout(100)
    for (const text of [
      'Rebuilt the job database: 812 new jobs in 4 min.',
      'Started Find Jobs from your resume.',
      'Find Jobs is done: 6 searches, 362 jobs. They are being rated now; pick the ones you want in the window.',
    ]) await harnessCall('POST', '/v1/notes', { text })
    await harnessCall('GET', '/v1/status')
    await page.getByRole('button', { name: /Agent connected/ }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: /Agent connected/ }).click()
    await page.waitForTimeout(500)
    await shot(page, '15-agent-chip')
  } finally {
    await app.close()
  }
})
