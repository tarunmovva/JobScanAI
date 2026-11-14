import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..')
// When playwright launches `electron out/main/main.js` directly, Electron's
// app.name resolves from its own package.json (in node_modules/electron) and
// is "Electron". userData therefore = ~/AppData/Roaming/Electron, NOT
// ~/AppData/Roaming/jobscan-app. Packaged builds correctly use jobscan-app.
// For tests we write to the Electron path; production users unaffected.
const CONFIG_PATH = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Roaming', 'Electron', 'config.json')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Electron', 'config.json')
    : path.join(os.homedir(), '.config', 'Electron', 'config.json')
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots')

function ensureScreenshotDir(): void {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
}

function patchStore(patch: Record<string, unknown>): void {
  let existing: Record<string, unknown> = {}
  if (fs.existsSync(CONFIG_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) } catch { /* ignore */ }
  }
  const merged = { ...existing, ...patch }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8')
}

/**
 * The store as the app sees it: config.json, plus the bulk keys it keeps in
 * side files beside it (config.<key>.json, see electron/store-sidecars.ts) --
 * read only when they carry config.json's own generation.
 */
function readStore(): Record<string, any> {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  for (const key of ['candidates', 'ratedJobs', 'profilePools']) {
    if (key in cfg) continue
    try {
      const side = JSON.parse(fs.readFileSync(CONFIG_PATH.replace(/config\.json$/, `config.${key}.json`), 'utf-8'))
      if (side.gen === cfg.storeSidecarGen) cfg[key] = side.value
    } catch { /* no side file */ }
  }
  return cfg
}

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(PROJECT_ROOT, 'out', 'main', 'main.js')],
    cwd: PROJECT_ROOT,
    env: { ...process.env, E2E_TEST: '1' },
    timeout: 30_000,
  })
  const page = await app.firstWindow({ timeout: 20_000 })
  await page.waitForLoadState('domcontentloaded')
  // Wait for the React tree to mount (header banner has the app name)
  await page.locator('header').waitFor({ state: 'visible', timeout: 15_000 })
  return { app, page }
}

async function shot(page: Page, name: string): Promise<void> {
  ensureScreenshotDir()
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true })
}

// Boot force-disarms automation (session-only), so pre-launch seeds of the
// armed state get overwritten. Seed AFTER launch, then reload: main re-reads
// config.json from disk on every store.get, and the renderer refetches
// scheduler:status on load.
async function seedAndReload(page: Page, patch: Record<string, unknown>): Promise<void> {
  patchStore(patch)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.locator('header').waitFor({ state: 'visible', timeout: 15_000 })
}

function resetConfig(): void {
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
}

const headerName = (page: Page) => page.locator('header').getByText('JobScan AI')

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('App settings & profiles', () => {

  test.beforeEach(() => {
    resetConfig()
  })

  test('1. boots — header + settings gear visible, no automation badge exists', async () => {
    const { app, page } = await launchApp()
    try {
      await expect(headerName(page)).toBeVisible()
      await expect(page.locator('button[title="Settings"]')).toBeVisible()
      // Automation was removed — no badge text anywhere.
      await expect(page.getByText(/Auto · /)).toHaveCount(0)
      await shot(page, '01-boot')
    } finally { await app.close() }
  })

  test('2. settings opens with Profiles / AI / Application / Paths — no automation section', async () => {
    const { app, page } = await launchApp()
    try {
      await page.locator('button[title="Settings"]').click()
      await expect(page.getByText('Profiles', { exact: true })).toBeVisible()
      await expect(page.getByText('AI Configuration')).toBeVisible()
      await expect(page.getByText('Application Settings')).toBeVisible()
      await expect(page.getByText('Paths', { exact: true })).toBeVisible()
      await expect(page.getByText('Automation (Auto-Apply)')).toHaveCount(0)
      await shot(page, '02-settings')
    } finally { await app.close() }
  })

  test('7. AppliedJobsPanel — opens from Settings, status filter, closes', async () => {
    patchStore({
      appliedJobsLog: [
        { company: 'Stripe', jobId: 'sp-1', platform: 'greenhouse', title: 'Backend Engineer',
          applyUrl: 'https://example.com/sp-1', status: 'submitted', message: 'OK',
          via: 'auto', ts: new Date(Date.now() - 1*3600_000).toISOString() },
        { company: 'Datadog', jobId: 'dd-1', platform: 'lever', title: 'Platform Engineer',
          applyUrl: 'https://example.com/dd-1', status: 'submitted', message: 'OK',
          via: 'manual', ts: new Date(Date.now() - 24*3600_000).toISOString() },
        { company: 'Cloudflare', jobId: 'cf-1', platform: 'ashby', title: 'SRE',
          applyUrl: 'https://example.com/cf-1', status: 'failed', message: 'required field empty',
          via: 'auto', ts: new Date(Date.now() - 12*3600_000).toISOString() },
      ],
    })
    const { app, page } = await launchApp()
    try {
      await page.locator('button[title="Settings"]').click()
      await page.getByRole('button', { name: 'View history →' }).click()
      await expect(page.getByRole('heading', { name: 'Applied Jobs' })).toBeVisible()
      await expect(page.getByText('Automation History')).toHaveCount(0)
      await expect(page.getByText('Backend Engineer', { exact: true })).toBeVisible()
      await expect(page.getByText('Platform Engineer', { exact: true })).toBeVisible()
      await expect(page.getByText('SRE', { exact: true })).toBeVisible()
      await shot(page, '07a-history-all')

      // Status filter — failed only
      const statusSelect = page.locator('select').filter({ hasText: /All status/ }).last()
      await statusSelect.selectOption('failed')
      await expect(page.getByText('Backend Engineer', { exact: true })).toHaveCount(0)
      await expect(page.getByText('SRE', { exact: true })).toBeVisible()
      await shot(page, '07b-history-failed-only')

      await page.getByRole('button', { name: 'Close' }).click()
      await expect(page.getByRole('heading', { name: 'Applied Jobs' })).toHaveCount(0)
    } finally { await app.close() }
  })

  test('10. codex model dropdown — Auto default, unavailable hint, persists on save', async () => {
    const { app, page } = await launchApp()
    try {
      await page.locator('button[title="Settings"]').click()
      const modelSelect = page.locator('label:has-text("Codex Model") + select')
      await expect(modelSelect).toBeVisible()
      await expect(modelSelect).toHaveValue('')                                     // Auto by default
      await expect(modelSelect.locator('option[value=""]')).toHaveText('Auto (Codex default)')
      // Deterministic under E2E_TEST=1: the handler short-circuits with an
      // empty list, exercising the degraded-UI path without spawning codex.
      await expect(page.getByText(/Model list unavailable/)).toBeVisible()
      await shot(page, '10-model-default-auto')
      await page.getByRole('button', { name: 'Save Settings' }).click()
      await expect(page.locator('h3', { hasText: 'Settings' })).toHaveCount(0, { timeout: 5000 })
      const cfg = readStore()
      expect(cfg.codexModel).toBe('')
    } finally { await app.close() }
  })

  test('11. stored codex model renders selected without live list; switch to Auto persists', async () => {
    const { app, page } = await launchApp()
    try {
      await seedAndReload(page, { codexModel: 'gpt-5.4' })                          // boot does NOT normalize codexModel
      await page.locator('button[title="Settings"]').click()
      const modelSelect = page.locator('label:has-text("Codex Model") + select')
      await expect(modelSelect).toHaveValue('gpt-5.4')                              // saved value usable without a live list
      await expect(modelSelect.locator('option[value="gpt-5.4"]')).toHaveText('gpt-5.4 (saved)')
      await shot(page, '11-model-saved-selected')
      await modelSelect.selectOption('')
      await page.getByRole('button', { name: 'Save Settings' }).click()
      await expect(page.locator('h3', { hasText: 'Settings' })).toHaveCount(0, { timeout: 5000 })
      expect(readStore().codexModel).toBe('')
      await page.locator('button[title="Settings"]').click()                        // reopen → round-trip
      await expect(page.locator('label:has-text("Codex Model") + select')).toHaveValue('')
    } finally { await app.close() }
  })

  test('12. profiles: fresh boot migrates to a "Default" profile', async () => {
    const { app, page } = await launchApp()
    try {
      const cfg = readStore()
      expect(cfg.profilesList).toHaveLength(1)
      expect(cfg.profilesList[0].name).toBe('Default')
      expect(cfg.activeProfileId).toBe(cfg.profilesList[0].id)
      expect(cfg.profileSnapshots[cfg.activeProfileId]).toBeTruthy()

      // Header chip shows the active profile; menu lists Manage entry.
      // (Seed resume — the chip is hidden on the auth screen.)
      await seedAndReload(page, { appState: 'resume' })
      const chip = page.locator('header').getByRole('button', { name: /Default/ })
      await expect(chip).toBeVisible()
      await chip.click()
      await expect(page.getByRole('button', { name: 'Manage profiles…' })).toBeVisible()
      await shot(page, '12-profiles-default')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: 'Manage profiles…' })).toHaveCount(0)
    } finally { await app.close() }
  })

  test('13. profiles: fully isolated — blank create, history NOT shared', async () => {
    const { app, page } = await launchApp()
    try {
      const appliedEntry = {
        company: 'Stripe', jobId: 'sp-1', platform: 'greenhouse', title: 'Backend Engineer',
        applyUrl: 'https://example.com/sp-1', status: 'submitted', message: 'OK',
        via: 'manual', ts: new Date().toISOString(),
      }
      const pool = {
        candidates: [{ platform: 'greenhouse', job_id: 'pool-1', title: 'Platform Engineer', company: 'Acme' }],
        ratedJobs: [{ platform: 'greenhouse', job_id: 'pool-1', title: 'Platform Engineer', company: 'Acme', rating: 9, reason: 'fit' }],
      }
      await seedAndReload(page, { appState: 'resume', profileTargetLocations: 'Austin TX', appliedJobsLog: [appliedEntry], ...pool })

      // Create "Persona B" (blank space), then switch to it via the header menu
      await page.locator('button[title="Settings"]').click()
      await page.getByPlaceholder('New profile name…').fill('Persona B')
      await page.getByRole('button', { name: 'Create profile' }).click()
      await expect(page.getByText('Persona B')).toBeVisible()
      await page.getByRole('button', { name: 'Cancel' }).click()  // close settings

      await page.locator('header').getByRole('button', { name: /Default/ }).click()
      await page.getByRole('button', { name: /Persona B/ }).click()
      await expect(page.getByText('Switched to "Persona B"')).toBeVisible({ timeout: 5000 })
      await expect(page.locator('header').getByRole('button', { name: /Persona B/ })).toBeVisible()
      await page.waitForTimeout(400)  // let store writes flush

      // Blank space: nothing carried over from Default
      let cfg = readStore()
      expect(cfg.profileTargetLocations ?? '').toBe('')
      expect(cfg.appliedJobsLog ?? []).toHaveLength(0)
      expect(cfg.candidates ?? []).toHaveLength(0)                          // no pools carried over
      expect(cfg.ratedJobs ?? []).toHaveLength(0)
      // …and the SCREEN shows the blank space too: switching while on the
      // Resume screen must remount it (regression: stale fields stayed
      // painted and could be saved into the new profile).
      await expect(page.getByPlaceholder(/Austin TX or Remote US/)).toHaveValue('')

      // Edit Persona B's flat keys, then switch back to Default
      await seedAndReload(page, { profileTargetLocations: 'Remote US' })
      await page.locator('header').getByRole('button', { name: /Persona B/ }).click()
      await page.getByRole('button', { name: /Default/ }).click()
      await expect(page.getByText('Switched to "Default"')).toBeVisible({ timeout: 5000 })
      await page.waitForTimeout(400)
      // Screen remounted with Default's data restored
      await expect(page.getByPlaceholder(/Austin TX or Remote US/)).toHaveValue('Austin TX')

      cfg = readStore()
      expect(cfg.profileTargetLocations).toBe('Austin TX')                 // Default restored
      expect(cfg.appliedJobsLog).toHaveLength(1)                           // Default's own history intact
      expect(cfg.appliedJobsLog[0].jobId).toBe('sp-1')
      const bId = cfg.profilesList.find((p: { name: string }) => p.name === 'Persona B').id
      expect(cfg.profileSnapshots[bId].profileTargetLocations).toBe('Remote US')  // B kept its edit
      expect(cfg.profileSnapshots[bId].appliedJobsLog ?? []).toHaveLength(0)      // B's history stayed empty
      // Default's pools came back with it. They travel beside config.json,
      // never inside a snapshot: snapshots stay in config.json, and the pools
      // would make every write of it slow again.
      expect(cfg.candidates).toEqual(pool.candidates)
      expect(cfg.ratedJobs).toEqual(pool.ratedJobs)
      for (const snap of Object.values(cfg.profileSnapshots) as Array<Record<string, unknown>>) {
        expect(snap).not.toHaveProperty('candidates')
        expect(snap).not.toHaveProperty('ratedJobs')
      }
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      expect(raw).not.toHaveProperty('ratedJobs')
      expect(raw).not.toHaveProperty('profilePools')
      expect(raw.profileSnapshots[bId]).toBeTruthy()                       // the snapshots live in config.json
      await shot(page, '13-profiles-isolation')
    } finally { await app.close() }
  })

  test('13b. profiles: a switch cut off between its writes never leaves one profile with another\'s pools', async () => {
    // The state a crash mid-switch left: A is active, but the pools are B's
    // (the owner tag still names B). The loop would apply A's resume to jobs
    // rated for B's.
    resetConfig()
    patchStore({
      appState: 'resume',
      profilesList: [{ id: 'pa', name: 'Alpha', createdAt: '2026-01-01T00:00:00Z' }, { id: 'pb', name: 'Beta', createdAt: '2026-01-01T00:00:00Z' }],
      activeProfileId: 'pa', poolsOwner: 'pb',
      ratedJobs: [{ platform: 'lever', job_id: 'b-job', title: 'Beta job', company: 'co', rating: 9, reason: 'b' }],
      candidates: [{ platform: 'lever', job_id: 'b-job', title: 'Beta job', company: 'co' }],
      profilePools: { pa: { ratedJobs: [{ platform: 'lever', job_id: 'a-job', title: 'Alpha job', company: 'co', rating: 9, reason: 'a' }], candidates: [] } },
      profileSnapshots: { pa: { profileTargetLocations: 'Austin TX' }, pb: { profileTargetLocations: 'Remote US' } },
    })
    const { app } = await launchApp()
    try {
      const cfg = readStore()
      expect(cfg.activeProfileId).toBe('pa')
      expect(cfg.ratedJobs.map((j: { job_id: string }) => j.job_id)).toEqual(['a-job'])
      expect(cfg.candidates).toEqual([])
      expect(cfg.poolsOwner).toBe('pa')
    } finally { await app.close() }
  })

  test('13c. profiles: a profile whose saved data is missing is not switched to', async () => {
    // Switching to it would start it with no applied history: the loop could
    // apply again to every job it already applied to.
    resetConfig()
    patchStore({
      appState: 'resume',
      profilesList: [{ id: 'pa', name: 'Alpha', createdAt: '2026-01-01T00:00:00Z' }, { id: 'pb', name: 'Beta', createdAt: '2026-01-01T00:00:00Z' }],
      activeProfileId: 'pa',
      profileSnapshots: { pa: { profileTargetLocations: 'Austin TX' } },
    })
    const { app, page } = await launchApp()
    try {
      await page.locator('header').getByRole('button', { name: /Alpha/ }).click()
      await page.getByRole('button', { name: /Beta/ }).click()
      await expect(page.getByText(/saved data is missing/)).toBeVisible({ timeout: 5000 })
      expect(readStore().activeProfileId).toBe('pa')
    } finally { await app.close() }
  })

  test('15. application record renders in-app from history Details', async () => {
    const { app, page } = await launchApp()
    try {
      // Point the app home at a scratch dir and drop a fixture record there.
      const scratchHome = path.join(os.tmpdir(), `jobscan-e2e-home-${Date.now()}`)
      const recordsDir = path.join(scratchHome, 'application-records')
      fs.mkdirSync(recordsDir, { recursive: true })
      const recordPath = path.join(recordsDir, 'rec.md')
      fs.writeFileSync(recordPath, [
        '# Backend Engineer — stripe',
        '',
        'Applied: Jul 10, 2026',
        'Profile: Default',
        'Status: submitted — submitted',
        '',
        '## Questions & Answers',
        '',
        '**Full name** — Test User',
        '',
        '**Why Stripe?**',
        '> Because payments infrastructure at scale is exactly',
        '> what my background prepared me for.',
        '',
      ].join('\n'), 'utf-8')

      const ts = new Date().toISOString()
      await seedAndReload(page, {
        jobAutomatorHome: scratchHome,
        appliedJobsLog: [
          { company: 'stripe', jobId: 'sp-1', platform: 'greenhouse', title: 'Backend Engineer',
            applyUrl: 'https://example.com/sp-1', status: 'submitted', message: 'submitted',
            via: 'manual', ts, detailsPath: recordPath },
          { company: 'datadog', jobId: 'dd-1', platform: 'lever', title: 'Platform Engineer',
            applyUrl: 'https://example.com/dd-1', status: 'submitted', message: 'submitted',
            via: 'manual', ts },
        ],
      })

      await page.locator('button[title="Settings"]').click()
      await page.getByRole('button', { name: 'View history →' }).click()
      await expect(page.getByRole('button', { name: 'Details sp-1' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Details dd-1' })).toHaveCount(0)  // no record → no button

      await page.getByRole('button', { name: 'Details sp-1' }).click()
      await expect(page.getByText('Backend Engineer — stripe')).toBeVisible()
      await expect(page.getByText('Full name')).toBeVisible()
      await expect(page.getByText('Test User')).toBeVisible()
      await expect(page.getByText(/payments infrastructure at scale/)).toBeVisible()
      await shot(page, '15-application-record')

      // Esc closes the record but keeps the history panel open
      await page.keyboard.press('Escape')
      await expect(page.getByText('Backend Engineer — stripe')).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Applied Jobs' })).toBeVisible()
      await page.getByRole('button', { name: 'Close' }).click()

      fs.rmSync(scratchHome, { recursive: true, force: true })
    } finally { await app.close() }
  })

  test('14. profiles: delete guards + confirm flow', async () => {
    const { app, page } = await launchApp()
    try {
      await page.locator('button[title="Settings"]').click()
      await page.getByPlaceholder('New profile name…').fill('Doomed')
      await page.getByRole('button', { name: 'Create profile' }).click()
      await expect(page.getByRole('button', { name: 'Delete Doomed' })).toBeEnabled()
      // Active profile cannot be deleted
      await expect(page.getByRole('button', { name: 'Delete Default' })).toBeDisabled()

      await page.getByRole('button', { name: 'Delete Doomed' }).click()
      // History is per profile: deleting one deletes its history, and no other
      // profile knows where it applied. The copy said "shared and stays".
      await expect(page.getByText(
        'Delete profile "Doomed"? Its resume, answers, searches, ratings, OTP email and applied-job history '
        + 'are removed, and this cannot be undone. History is kept per profile, so no other profile will know '
        + 'which jobs "Doomed" already applied to.', { exact: true })).toBeVisible()
      await expect(page.getByText(/shared and stays/)).toHaveCount(0)
      await page.getByRole('button', { name: 'Delete profile', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Delete Doomed' })).toHaveCount(0)

      const cfg = readStore()
      expect(cfg.profilesList).toHaveLength(1)
      expect(Object.keys(cfg.profileSnapshots)).toHaveLength(1)
      await shot(page, '14-profiles-delete-guards')
    } finally { await app.close() }
  })
})
