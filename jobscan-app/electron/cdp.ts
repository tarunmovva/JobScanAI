/**
 * Where JobScan's automation Chrome listens, and how it is started.
 *
 * These read the same variables as the Python side (browser_cdp.py), so a
 * test run can put the whole stack on its own port and profile. Without
 * them, a test that started Chrome on 9222 would leave a browser the user's
 * real app later adopts as its own. Unset, everything is exactly as before:
 * port 9222 and <automation home>/chrome-cdp-profile.
 */
import path from 'path'

type Env = Record<string, string | undefined>

export function cdpHost(env: Env = process.env): string {
  return (env['JOB_AUTOMATOR_CDP_HOST'] ?? '').trim() || '127.0.0.1'
}

export function cdpPort(env: Env = process.env): string {
  return (env['JOB_AUTOMATOR_CDP_PORT'] ?? '').trim() || '9222'
}

export function cdpVersionUrl(env: Env = process.env): string {
  return `http://${cdpHost(env)}:${cdpPort(env)}/json/version`
}

export function chromeProfileDir(automationHome: string, env: Env = process.env): string {
  const configured = (env['JOB_AUTOMATOR_CHROME_USER_DATA_DIR'] ?? '').trim()
  return configured ? path.resolve(configured) : path.join(automationHome, 'chrome-cdp-profile')
}

export function chromeLaunchArgs(automationHome: string, env: Env = process.env): string[] {
  return [
    `--remote-debugging-port=${cdpPort(env)}`,
    `--user-data-dir=${chromeProfileDir(automationHome, env)}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
}
