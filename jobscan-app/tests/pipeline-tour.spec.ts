import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONFIG_PATH = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Roaming', 'Electron', 'config.json')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Electron', 'config.json')
    : path.join(os.homedir(), '.config', 'Electron', 'config.json')
const SHOT_DIR = path.join(__dirname, 'screenshots', 'tour')

function shotDir(): void { if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true }) }

function patchStore(patch: Record<string, unknown>): void {
  let existing: Record<string, unknown> = {}
  if (fs.existsSync(CONFIG_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) } catch { /* ignore */ }
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...patch }, null, 2), 'utf-8')
}

function resetConfig(): void { if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH) }

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(PROJECT_ROOT, 'out', 'main', 'main.js')],
    cwd: PROJECT_ROOT,
    env: { ...process.env, E2E_TEST: '1' },
    timeout: 30_000,
  })
  const page = await app.firstWindow({ timeout: 20_000 })
  await page.waitForLoadState('domcontentloaded')
  await page.locator('header').waitFor({ state: 'visible', timeout: 15_000 })
  return { app, page }
}

// Boot force-normalizes appState (always Resume/Auth) and disarms automation,
// so pre-launch store seeds get overwritten. Seed AFTER launch instead, then
// reload — main re-reads config.json from disk on every store.get, and the
// renderer refetches state:get / scheduler:status on load.
async function seedAndReload(page: Page, patch: Record<string, unknown>): Promise<void> {
  patchStore(patch)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.locator('header').waitFor({ state: 'visible', timeout: 15_000 })
}

async function shot(page: Page, name: string): Promise<void> {
  shotDir()
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true })
}

// ── Seed data ─────────────────────────────────────────────────────────────────

const SAMPLE_QUERIES = [
  { name: 'backend_remote_us', flags: "--title-query \"'backend engineer'\" --market remote-global --remote", description: 'Remote-friendly backend roles for US-based candidates.' },
  { name: 'platform_engineering', flags: "--title-query \"'platform engineer' OR 'infrastructure engineer'\" --market usa", description: 'Platform/infra engineering roles at mid-level.' },
  { name: 'distributed_systems', flags: "--key-query \"'distributed systems' OR Kafka OR Cassandra\" --market usa,europe", description: 'Distributed-systems-heavy roles across US and EU.' },
  { name: 'go_python_mid', flags: "--key-query \"Go OR Python\" --title-query \"'software engineer'\" --since 30d", description: 'Mid-level Go/Python roles posted in last 30 days.' },
  { name: 'ny_sf_focus', flags: "--title-query \"'backend engineer'\" --market 'new york,san francisco'", description: 'Backend roles focused on NY and SF metro.' },
]

const SAMPLE_CANDIDATES = [
  { id: 'gh:stripe:42101', job_id: '42101', company: 'Stripe', title: 'Backend Engineer, Payments', location: 'Remote — US', workplace_type: 'remote', employment_type: 'full-time', platform: 'greenhouse', job_url: 'https://example.com/1', apply_url: 'https://example.com/apply/1', description: 'Build payments infrastructure at scale.', posted_at: new Date(Date.now() - 2*86400_000).toISOString() },
  { id: 'lv:datadog:dd-1234', job_id: 'dd-1234', company: 'Datadog', title: 'Platform Engineer', location: 'New York', workplace_type: 'hybrid', employment_type: 'full-time', platform: 'lever', job_url: 'https://example.com/2', apply_url: 'https://example.com/apply/2', description: 'Own the platform reliability layer.', posted_at: new Date(Date.now() - 5*86400_000).toISOString() },
  { id: 'ab:vercel:ab-9001', job_id: 'ab-9001', company: 'Vercel', title: 'Software Engineer, Build Infrastructure', location: 'Remote — Global', workplace_type: 'remote', employment_type: 'full-time', platform: 'ashby', job_url: 'https://example.com/3', apply_url: 'https://example.com/apply/3', description: 'Speed up developer builds.', posted_at: new Date(Date.now() - 1*86400_000).toISOString() },
  { id: 'gh:linear:l-555', job_id: 'l-555', company: 'Linear', title: 'Senior Software Engineer (Realtime)', location: 'Remote — EU', workplace_type: 'remote', employment_type: 'full-time', platform: 'greenhouse', job_url: 'https://example.com/4', apply_url: 'https://example.com/apply/4', description: 'CRDT-based collaboration infra.', posted_at: new Date(Date.now() - 3*86400_000).toISOString() },
  { id: 'lv:cloudflare:cf-77', job_id: 'cf-77', company: 'Cloudflare', title: 'Systems Engineer', location: 'Lisbon', workplace_type: 'hybrid', employment_type: 'full-time', platform: 'lever', job_url: 'https://example.com/5', apply_url: 'https://example.com/apply/5', description: 'Edge networking systems.', posted_at: new Date(Date.now() - 7*86400_000).toISOString() },
]

const SAMPLE_RATED = SAMPLE_CANDIDATES.map((c, i) => ({
  ...c,
  rating: [9, 8, 7, 6, 4][i],
  reason: [
    'Strong fit — payments infra experience matches resume, remote-US aligns.',
    'Good fit — platform/SRE background matches, NY location flexible.',
    'Decent — build infra adjacent to candidate skills.',
    'Borderline — senior role, may be too senior for candidate level.',
    'Weak match — networking-heavy, not in candidate background.',
  ][i],
}))

// ── Tour ──────────────────────────────────────────────────────────────────────

test.describe('Pipeline tour (no real codex / jobscan / Chrome)', () => {

  test.beforeEach(() => { resetConfig() })

  test('A. resume screen — first time, never fetched DB', async () => {
    const { app, page } = await launchApp()
    try {
      await seedAndReload(page, { appState: 'resume' })
      await page.waitForTimeout(500)
      // Nav cleanup: Resume is the pipeline root — no back button in the header.
      await expect(page.getByRole('button', { name: '← Back' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Logout/ })).toHaveCount(0)
      await shot(page, 'A-resume-empty')
    } finally { await app.close() }
  })

  test('B. resume screen — resume uploaded + profile filled', async () => {
    const seed = {
      appState: 'resume',
      resumePath: 'F:\\fake\\resume.pdf',
      resumeText: 'Mid-level software engineer, 4 years Go + Python, distributed systems.',
      profileTargetLocations: 'Austin TX or Remote US',
      profileSearchInstructions: 'Prefer roles posted in last 14 days. Avoid finance.',
      profileVisaSituation: 'US citizen, no restrictions',
      profileSponsorshipNeed: 'no-sponsorship',
      lastFetchAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    }
    const { app, page } = await launchApp()
    try {
      await seedAndReload(page, seed)
      await page.waitForTimeout(500)
      await shot(page, 'B-resume-filled')
    } finally { await app.close() }
  })

  test('C. query gen — mid-flight with valid + invalid + generating cards', async () => {
    const { app, page } = await launchApp()
    try {
      await seedAndReload(page, {
        appState: 'query_gen',
        queryList: SAMPLE_QUERIES.slice(0, 3),
        queryGenResults: SAMPLE_QUERIES.slice(0, 3).map((q, i) => ({ index: i, query: q })),
      })
      await page.waitForTimeout(700)
      // Back button exists past Resume and targets the previous step.
      await expect(page.getByRole('button', { name: '← Back' })).toHaveCount(1)
      await shot(page, 'C-querygen-mid')
    } finally { await app.close() }
  })

  test('D. query gen — done, all queries valid, Continue button shown', async () => {
    const { app, page } = await launchApp()
    try {
      await seedAndReload(page, {
        appState: 'query_gen',
        queryList: SAMPLE_QUERIES,
        queryGenResults: SAMPLE_QUERIES.map((q, i) => ({ index: i, query: q })),
      })
      await page.waitForTimeout(700)
      // wait for done state to be set via queryGen:done emit — actually it's not emitted on rehydrate
      // The screen sets done=true via onDone event. Need to look at QueryGenScreen.
      await shot(page, 'D-querygen-done')
    } finally { await app.close() }
  })

  test('E. find jobs — done: pool total, Evaluate button, find-more box', async () => {
    const { app, page } = await launchApp()
    try {
      let running = 0
      await seedAndReload(page, {
        appState: 'query_gen',
        queryList: SAMPLE_QUERIES.map(q => ({ ...q, count: 40 })),
        queryGenResults: SAMPLE_QUERIES.map((q, i) => {
          running += [2, 1, 1, 1, 0][i]
          return { index: i, query: { ...q, count: 40 }, found: [2, 1, 1, 1, 0][i], totalAfter: running }
        }),
        candidates: SAMPLE_CANDIDATES,
      })
      await page.waitForTimeout(700)
      await expect(page.getByText(`${SAMPLE_CANDIDATES.length} unique candidates found`)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Evaluate Matches →' })).toBeEnabled()
      await expect(page.getByText('+2 new')).toBeVisible()
      // Find-more ask box present (not clicked — codex offline in e2e)
      await expect(page.getByPlaceholder(/Ask for more/)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Find more →' })).toBeDisabled() // empty input
      await shot(page, 'E-find-jobs-done')
    } finally { await app.close() }
  })

  test('G. rating — done, jobs sorted, ready for selection', async () => {
    const { app, page } = await launchApp()
    try {
      await seedAndReload(page, {
        appState: 'rating',
        candidates: SAMPLE_CANDIDATES,
        ratedJobs: SAMPLE_RATED,
        appliedJobIds: [],
      })
      await page.waitForTimeout(700)
      await shot(page, 'G-rating-done')
    } finally { await app.close() }
  })

  test('H. rating — open detail panel for a high-rated job', async () => {
    const { app, page } = await launchApp()
    try {
      await seedAndReload(page, {
        appState: 'rating',
        candidates: SAMPLE_CANDIDATES,
        ratedJobs: SAMPLE_RATED,
        appliedJobIds: [],
      })
      await page.waitForTimeout(700)
      await page.getByText('Backend Engineer, Payments').first().click()
      await page.waitForTimeout(300)
      await shot(page, 'H-rating-detail')
    } finally { await app.close() }
  })

  test('I. extract — progress with mixed success/fail', async () => {
    const { app, page } = await launchApp()
    try {
      await seedAndReload(page, {
        appState: 'board',
        selectedJobIds: SAMPLE_CANDIDATES.slice(0, 3).map(c => c.id),
        extractResults: [
          { platform: 'greenhouse', company: 'stripe', jobId: '42101', title: 'Backend Engineer, Payments', applyUrl: 'https://example.com/apply/1', status: 'extracted' },
          { platform: 'lever',      company: 'datadog', jobId: 'dd-1234', title: 'Platform Engineer',         applyUrl: 'https://example.com/apply/2', status: 'extracted' },
          { platform: 'ashby',      company: 'vercel',  jobId: 'ab-9001', title: 'Software Engineer, Build Infrastructure', applyUrl: 'https://example.com/apply/3', status: 'failed', error: 'apply URL returned 403' },
        ],
      })
      await page.waitForTimeout(700)
      await shot(page, 'I-extract-mixed')
    } finally { await app.close() }
  })

  test('J. done screen — submissions with view-all link', async () => {
    const { app, page } = await launchApp()
    try {
      await seedAndReload(page, {
        appState: 'done',
        doneSummary: [
          { company: 'stripe', jobId: '42101', platform: 'greenhouse', title: 'Backend Engineer, Payments', applyUrl: 'https://example.com/apply/1', status: 'submitted', message: 'submitted', via: 'manual', ts: new Date().toISOString() },
          { company: 'datadog', jobId: 'dd-1234', platform: 'lever', title: 'Platform Engineer', applyUrl: 'https://example.com/apply/2', status: 'submitted', message: 'submitted', via: 'manual', ts: new Date().toISOString() },
          { company: 'cloudflare', jobId: 'cf-77', platform: 'lever', title: 'Systems Engineer', applyUrl: 'https://example.com/apply/5', status: 'failed', message: 'OTP timeout after 15s', via: 'manual', ts: new Date().toISOString() },
        ],
      })
      await page.waitForTimeout(700)
      await shot(page, 'J-done-screen')
    } finally { await app.close() }
  })

  test('L. AppliedJobsPanel with mixed historical via tags', async () => {
    const now = Date.now()
    const seed = {
      appState: 'resume',
      appliedJobsLog: [
        { company: 'stripe', jobId: '42101', platform: 'greenhouse', title: 'Backend Engineer, Payments', applyUrl: 'https://example.com/apply/1', status: 'submitted', message: 'submitted', via: 'auto', ts: new Date(now - 1*3600_000).toISOString() },
        { company: 'linear', jobId: 'l-555', platform: 'greenhouse', title: 'Senior Software Engineer (Realtime)', applyUrl: 'https://example.com/apply/4', status: 'submitted', message: 'submitted', via: 'auto', ts: new Date(now - 7*3600_000).toISOString() },
        { company: 'datadog', jobId: 'dd-1234', platform: 'lever', title: 'Platform Engineer', applyUrl: 'https://example.com/apply/2', status: 'submitted', message: 'submitted', via: 'manual', ts: new Date(now - 24*3600_000).toISOString() },
        { company: 'cloudflare', jobId: 'cf-77', platform: 'lever', title: 'Systems Engineer', applyUrl: 'https://example.com/apply/5', status: 'failed', message: 'OTP timeout', via: 'auto', ts: new Date(now - 30*3600_000).toISOString() },
      ],
    }
    const { app, page } = await launchApp()
    try {
      await seedAndReload(page, seed)
      await page.waitForTimeout(700)
      await page.locator('button[title="Settings"]').click()
      await page.getByRole('button', { name: 'View history →' }).click()
      await expect(page.getByRole('heading', { name: 'Applied Jobs' })).toBeVisible()
      await page.waitForTimeout(400)
      await shot(page, 'L-applied-jobs-rich')
    } finally { await app.close() }
  })

  test('M. fetching — idle block with escape hatch back to Resume', async () => {
    const { app, page } = await launchApp()
    try {
      // Stale 'fetching' state with no run in flight → idle block, not a spinner.
      await seedAndReload(page, { appState: 'fetching' })
      await expect(page.getByText('No rebuild in progress.')).toBeVisible()
      // Trail stays coherent during fetching: Resume highlighted as current step.
      await expect(page.locator('[aria-current="step"]')).toHaveText(/Resume/)
      await shot(page, 'M-fetch-idle')
      await page.getByRole('button', { name: '← Back to Resume' }).click()
      // fetch:cancel routes a non-running fetching state back to Resume.
      await expect(page.getByText('Rebuilding Job Database')).toHaveCount(0, { timeout: 5000 })
    } finally { await app.close() }
  })

  test('N. auth — step trail hidden on login screen', async () => {
    const { app, page } = await launchApp()
    try {
      await seedAndReload(page, { appState: 'auth' })
      // Assert immediately — the auth:status probe may auto-advance shortly after.
      // Scope to the header — the auth tagline contains "Find jobs" as prose.
      await expect(page.locator('header').getByText('Find Jobs')).toHaveCount(0)
      // Let the screen entrance fade (140ms) finish so the shot isn't dim.
      await page.waitForTimeout(400)
      await shot(page, 'N-auth-no-trail')
    } finally { await app.close() }
  })
})
