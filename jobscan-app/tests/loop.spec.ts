/**
 * Loop mode, end to end in the real app, without anything real happening.
 *
 * Every spec points jobscanExePath at Node itself: a rebuild runs
 * `node --db … fetch --rebuild`, which exits at once with an error, so a
 * round can never get past its first stage -- no database, no Codex, no
 * Chrome, no application. E2E_TEST keeps codex from being spawned at all;
 * E2E_LOOP_SIGNED_IN lets the specs that need it start a loop.
 */
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { startConfirmCopy } from '../electron/loop-copy'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONFIG_PATH = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Roaming', 'Electron', 'config.json')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Electron', 'config.json')
    : path.join(os.homedir(), '.config', 'Electron', 'config.json')
const SHOT_DIR = path.join(__dirname, 'screenshots', 'loop')

/** An executable that exists and fails every jobscan command at once. */
const FAKE_EXE = process.execPath

const USA_SEARCH = { name: 'Backend, USA', flags: "--title-query \"'backend'\" --market usa", description: '', count: 120 }
const EUROPE_SEARCH = { name: 'Backend, Europe', flags: "--title-query \"'backend'\" --market europe", description: '', count: 80 }

const DEFAULTS = { threshold: 8, dailyLimit: 25, minGapMin: 60 }

async function launch(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
  const app = await electron.launch({
    args: [path.join(PROJECT_ROOT, 'out', 'main', 'main.js')],
    cwd: PROJECT_ROOT,
    env: { ...process.env, E2E_TEST: '1', ...env },
    timeout: 30_000,
  })
  const page = await app.firstWindow({ timeout: 20_000 })
  await page.waitForLoadState('domcontentloaded')
  await page.locator('header').waitFor({ state: 'visible', timeout: 15_000 })
  return { app, page }
}

// Boot normalizes appState, so screens are seeded after launch and reloaded.
async function seedAndReload(page: Page, patch: Record<string, unknown>): Promise<void> {
  let existing: Record<string, unknown> = {}
  try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) } catch { /* fresh */ }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...patch }, null, 2), 'utf-8')
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.locator('header').waitFor({ state: 'visible', timeout: 15_000 })
}

const ready = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  appState: 'resume',
  resumeText: 'Backend engineer. Go, Python, distributed systems.',
  jobscanExePath: FAKE_EXE,
  queryList: [USA_SEARCH],
  ...extra,
})

const chip = (page: Page) => page.getByRole('button', { name: /^Loop mode: / })
const panel = (page: Page) => page.getByRole('dialog', { name: 'Loop mode' })

async function shot(page: Page, name: string): Promise<void> {
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
}

test.describe('Loop mode', () => {
  test('the loop panel shows defaults and the legend, and no market setting', async () => {
    const { app, page } = await launch()
    try {
      await seedAndReload(page, ready({ queryList: [USA_SEARCH, EUROPE_SEARCH], loopSettings: DEFAULTS }))
      await expect(chip(page)).toHaveText('Loop')
      await chip(page).click()
      const p = panel(page)
      await expect(p).toBeVisible()
      await expect(p.getByLabel('Rated at least')).toHaveValue('8')
      await expect(p.getByLabel('Jobs a day, at most')).toHaveValue('25')
      await expect(p.getByLabel('Minutes between rounds')).toHaveValue('60')
      // Markets come from the target location, through the query agent, as in
      // a manual run: the loop has no market setting of its own.
      await expect(p.getByLabel(/^Market /)).toHaveCount(0)
      await expect(p.getByText(/^Markets/)).toHaveCount(0)
      await expect(p.getByTestId('loop-legend').locator('li')).toHaveCount(5)
      await shot(page, 'panel-off')
    } finally {
      await app.close()
    }
  })

  test('start asks first, and cancelling leaves it off', async () => {
    const { app, page } = await launch({ E2E_LOOP_SIGNED_IN: '1' })
    try {
      await seedAndReload(page, ready({ loopSettings: DEFAULTS }))
      await chip(page).click()
      await panel(page).getByRole('button', { name: 'Start', exact: true }).click()
      await expect(page.getByText(startConfirmCopy(DEFAULTS), { exact: true })).toBeVisible()
      await shot(page, 'start-warning')
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(page.getByText(startConfirmCopy(DEFAULTS), { exact: true })).toHaveCount(0)
      await expect(panel(page)).toBeVisible()
      await expect(chip(page)).toHaveText('Loop')
    } finally {
      await app.close()
    }
  })

  test('a saved search in any market starts the loop, as a manual run would', async () => {
    const { app, page } = await launch({ E2E_LOOP_SIGNED_IN: '1' })
    try {
      await seedAndReload(page, ready({ queryList: [EUROPE_SEARCH], loopSettings: DEFAULTS }))
      await chip(page).click()
      const p = panel(page)
      await p.getByRole('button', { name: 'Start', exact: true }).click()
      await page.getByRole('button', { name: 'Start loop' }).click()
      // Round 1 fails at the rebuild (the fake exe) and the loop waits for round 2.
      await expect(chip(page)).toHaveText(/^Next (\w{3} )?\d\d:\d\d$/, { timeout: 20_000 })
      await p.getByRole('button', { name: 'Stop now' }).click()
      await expect(chip(page)).toHaveText('Loop')
    } finally {
      await app.close()
    }
  })

  test('start is refused while Codex is not signed in', async () => {
    const { app, page } = await launch()
    try {
      await seedAndReload(page, ready({ loopSettings: DEFAULTS }))
      await chip(page).click()
      await panel(page).getByRole('button', { name: 'Start', exact: true }).click()
      await page.getByRole('button', { name: 'Start loop' }).click()
      await expect(panel(page).getByRole('alert')).toHaveText('Codex is not signed in')
    } finally {
      await app.close()
    }
  })

  test('while on, navigation is locked; stop now turns it off', async () => {
    const { app, page } = await launch({ E2E_LOOP_SIGNED_IN: '1' })
    try {
      await seedAndReload(page, ready({ loopSettings: DEFAULTS }))
      await chip(page).click()
      await panel(page).getByRole('button', { name: 'Start', exact: true }).click()
      await page.getByRole('button', { name: 'Start loop' }).click()
      // Round 1 fails at the rebuild (the fake exe) and the loop waits for round 2.
      await expect(chip(page)).toHaveText(/^Next (\w{3} )?\d\d:\d\d$/, { timeout: 20_000 })
      await expect(panel(page).getByText('Rebuild failed')).toBeVisible()
      await shot(page, 'panel-waiting')
      await panel(page).getByRole('button', { name: 'Close' }).click()

      // A screen that normally has Back and clickable steps.
      await seedAndReload(page, { appState: 'rating' })
      await expect(chip(page)).toHaveText(/^Next (\w{3} )?\d\d:\d\d$/)
      const trail = page.locator('header div[title="Loop mode is on — stop it first"]')
      await expect(trail).toBeVisible()
      await expect(trail.locator('button')).toHaveCount(0)
      await expect(page.getByRole('button', { name: '← Back' })).toHaveCount(0)
      await expect(page.locator('header button[title="Loop mode is on — stop it first"]')).toBeDisabled()
      await shot(page, 'locked-header')

      await chip(page).click()
      await panel(page).getByRole('button', { name: 'Stop now' }).click()
      await expect(chip(page)).toHaveText('Loop')
      await expect(panel(page).getByText('Last stopped: Stopped by you')).toBeVisible()
      await panel(page).getByRole('button', { name: 'Close' }).click()
      await expect(page.getByRole('button', { name: '← Back' })).toBeVisible()
    } finally {
      await app.close()
    }
  })
})
