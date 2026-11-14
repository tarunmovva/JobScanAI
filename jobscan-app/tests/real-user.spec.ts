/**
 * Real-user exploratory tests. Drives UI as a fresh user would,
 * stopping short of any action that fires real codex / jobscan / Chrome
 * submissions. Captures friction, broken affordances, weird states.
 *
 * Tests log discovered issues via console.log("[finding] ...") so the
 * stdout/test report serves as the issue list.
 */
import { test, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONFIG_PATH = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Roaming', 'Electron', 'config.json')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Electron', 'config.json')
    : path.join(os.homedir(), '.config', 'Electron', 'config.json')
const SHOT_DIR = path.join(__dirname, 'screenshots', 'real-user')

function ensure(): void { if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true }) }
function resetConfig(): void { if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH) }

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
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

async function shot(page: Page, name: string): Promise<void> {
  ensure()
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true })
}

// Boot force-normalizes appState (Resume when codex-authed, else Auth), so
// tests that need a specific screen seed AFTER launch and reload — this keeps
// them deterministic regardless of the machine's codex login state.
async function seedAndReload(page: Page, patch: Record<string, unknown>): Promise<void> {
  let existing: Record<string, unknown> = {}
  try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) } catch { /* ignore */ }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...patch }, null, 2), 'utf-8')
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.locator('header').waitFor({ state: 'visible', timeout: 15_000 })
}

const findings: string[] = []
function find(msg: string): void {
  findings.push(msg)
  // eslint-disable-next-line no-console
  console.log(`[finding] ${msg}`)
}

test.describe('Real-user exploration', () => {
  test.beforeEach(() => { resetConfig() })

  test.afterAll(() => {
    // eslint-disable-next-line no-console
    console.log(`\n[summary] ${findings.length} findings:`)
    findings.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
  })

  test('R1. fresh boot — observe initial state', async () => {
    const { app, page } = await launch()
    try {
      // Real user lands here — what do they see?
      await page.waitForTimeout(1000)
      await shot(page, 'R1-fresh-boot')

      const headerText = await page.locator('header').textContent()
      if (!headerText?.includes('JobScan AI')) find('R1: app name not visible in header')

      const settingsCog = page.locator('button[title="Settings"]')
      if (!(await settingsCog.isVisible())) find('R1: settings cog not visible from first screen')

      // Cog has only "⚙" emoji — accessibility: aria-label?
      const cogAria = await settingsCog.getAttribute('aria-label')
      if (!cogAria) find('R1: settings cog has no aria-label (only ⚙ emoji)')
    } finally { await app.close() }
  })

  test('R2. settings panel — open, scroll, close via X, reopen, close via Escape', async () => {
    const { app, page } = await launch()
    try {
      await page.locator('button[title="Settings"]').click()
      await page.waitForTimeout(300)
      await shot(page, 'R2a-settings-opened')

      // Check Escape closes modal
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      const settingsStillOpen = await page.getByText('AI CONFIGURATION').isVisible().catch(() => false)
      if (settingsStillOpen) find('R2: Settings panel does NOT close on Escape — user expects it')

      // Re-open
      if (settingsStillOpen) {
        await page.locator('button[title="Settings"]').click()
        await page.waitForTimeout(300)
      } else {
        await page.locator('button[title="Settings"]').click()
        await page.waitForTimeout(300)
      }

      // Try clicking backdrop (outside panel) to close
      await page.mouse.click(50, 400)  // click far left
      await page.waitForTimeout(200)
      const stillOpenAfterBackdrop = await page.getByText('AI CONFIGURATION').isVisible().catch(() => false)
      if (stillOpenAfterBackdrop) find('R2: Settings panel does NOT close on backdrop click')

      if (stillOpenAfterBackdrop) {
        // Close via X
        await page.locator('button:has-text("×")').first().click()
        await page.waitForTimeout(300)
      }
    } finally { await app.close() }
  })

  test('R4. AppliedJobsPanel — empty state', async () => {
    const { app, page } = await launch()
    try {
      await page.locator('button[title="Settings"]').click()
      await page.waitForTimeout(300)
      await page.getByRole('button', { name: 'View history →' }).click()
      await page.waitForTimeout(400)
      await shot(page, 'R4-applied-empty')

      // Empty state — should have helpful message, not just blank
      const emptyMsg = await page.getByText(/No applications yet|No automation runs yet|No jobs match/).first().isVisible().catch(() => false)
      if (!emptyMsg) find('R4: AppliedJobsPanel empty state lacks clear "no data yet" message')

      // Close button works
      await page.getByRole('button', { name: 'Close' }).click()
      await page.waitForTimeout(200)
      const stillOpen = await page.getByText('Applied Jobs & Automation History').isVisible().catch(() => false)
      if (stillOpen) find('R4: AppliedJobsPanel did not close on Close button')

      // Escape on AppliedJobsPanel?
      await page.getByRole('button', { name: 'View history →' }).click()
      await page.waitForTimeout(300)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      const stillOpenAfterEsc = await page.getByText('Applied Jobs & Automation History').isVisible().catch(() => false)
      if (stillOpenAfterEsc) find('R4: AppliedJobsPanel does NOT close on Escape')
    } finally { await app.close() }
  })

  test('R5. resume screen — try to start without resume or location', async () => {
    const { app, page } = await launch()
    try {
      await seedAndReload(page, { appState: 'resume' })
      // The Continue button should be disabled
      const continueBtn = page.getByRole('button', { name: /Upload resume|Find Matching Jobs/ })
      const isDisabled = await continueBtn.isDisabled().catch(() => false)
      if (!isDisabled) find('R5: Continue button not disabled when resume + location missing')

      const label = await continueBtn.textContent()
      if (!label || !label.toLowerCase().includes('upload') && !label.toLowerCase().includes('to continue')) {
        find(`R5: disabled Continue button label "${label}" should hint at what's missing`)
      }
      await shot(page, 'R5-disabled-continue')
    } finally { await app.close() }
  })

  test('R6. resume screen — fill only location, no resume, observe', async () => {
    const { app, page } = await launch()
    try {
      await seedAndReload(page, { appState: 'resume' })
      const locationsInput = page.locator('input').filter({ hasText: '' }).first()
      // Actually use the placeholder-based selector
      const loc = page.getByPlaceholder(/Austin TX or Remote US/)
      await loc.fill('Austin TX')
      await page.waitForTimeout(300)
      await shot(page, 'R6-location-only')

      const continueBtn = page.getByRole('button', { name: /Upload resume|Find Matching Jobs/ })
      const isDisabled = await continueBtn.isDisabled().catch(() => true)
      if (!isDisabled) find('R6: Continue button enabled when location filled but resume missing')
    } finally { await app.close() }
  })

  test('R7. keyboard nav — Tab through main elements', async () => {
    const { app, page } = await launch()
    try {
      await page.keyboard.press('Tab')
      const first = await page.evaluate(() => document.activeElement?.textContent ?? null)
      if (!first || first === 'body' || first.trim() === '') find('R7: Tab focus did not land on a meaningful element')
    } finally { await app.close() }
  })

  test('R8. resize window — verify no overflow', async () => {
    const { app, page } = await launch()
    try {
      await page.setViewportSize({ width: 800, height: 600 })
      await page.waitForTimeout(300)
      await shot(page, 'R8a-small-window')

      await page.setViewportSize({ width: 1920, height: 1080 })
      await page.waitForTimeout(300)
      await shot(page, 'R8b-wide-window')

      await page.setViewportSize({ width: 400, height: 800 })
      await page.waitForTimeout(300)
      await shot(page, 'R8c-narrow-window')
      // Header has many elements — does trail wrap?
      const headerHeight = await page.locator('header').evaluate(el => el.getBoundingClientRect().height)
      if (headerHeight > 100) find(`R8: header height ${headerHeight}px at 400px width — content wrapping causes tall header`)
    } finally { await app.close() }
  })

  test('R9. settings — change rating agents, save, reopen, verify persisted', async () => {
    const { app, page } = await launch()
    try {
      await page.locator('button[title="Settings"]').click()
      await page.waitForTimeout(300)
      const agentsInput = page.locator('label:has-text("Rating Agents (parallel threads)") + input')
      await agentsInput.fill('7')
      await page.getByRole('button', { name: 'Save Settings' }).click()
      await page.waitForTimeout(1200)  // save() closes the panel after ~800ms
      await page.locator('button[title="Settings"]').click()
      await page.waitForTimeout(300)
      const newValue = await page.locator('label:has-text("Rating Agents (parallel threads)") + input').inputValue()
      if (newValue !== '7') find(`R9: rating agents did not persist — saved 7, reads back "${newValue}"`)
    } finally { await app.close() }
  })

  test('R10. trail chips — clickable from later state', async () => {
    const { app, page } = await launch()
    try {
      // Boot force-resets appState, so seed AFTER launch (merge-style — boot
      // already wrote defaults into config.json) and reload the renderer.
      const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        ...existing,
        appState: 'rating',
        ratedJobs: [
          { id: 'gh:x:1', job_id: '1', company: 'X', title: 'Engineer', location: 'Remote', workplace_type: 'remote', employment_type: 'ft', platform: 'greenhouse', job_url: '', apply_url: '', description: '', posted_at: new Date().toISOString(), rating: 8, reason: 'fit' },
        ],
        candidates: [{ id: 'gh:x:1', job_id: '1', company: 'X', title: 'Engineer', location: 'Remote', workplace_type: 'remote', employment_type: 'ft', platform: 'greenhouse', job_url: '', apply_url: '', description: '', posted_at: new Date().toISOString() }],
        queryList: [{ name: 'q1', flags: '--title-query ee', description: 'd' }],
      }, null, 2), 'utf-8')
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await page.locator('header').waitFor({ state: 'visible', timeout: 15_000 })

      await page.waitForTimeout(500)
      await shot(page, 'R10-at-rating')

      // Click "Find Jobs" trail chip (earlier state) → should go back
      const queriesChip = page.locator('header').getByRole('button', { name: /Find Jobs/ })
      const visible = await queriesChip.isVisible().catch(() => false)
      if (!visible) find('R10: Find Jobs trail chip not clickable from rating state')
      if (visible) {
        await queriesChip.click()
        await page.waitForTimeout(500)
        await shot(page, 'R10-after-back-to-queries')
        // Should be on query_gen now
        const onQueryGen = await page.getByText('Find Matching Jobs').isVisible().catch(() => false)
        if (!onQueryGen) find('R10: clicking Find Jobs chip did not navigate to QueryGenScreen')
      }
    } finally { await app.close() }
  })
})
