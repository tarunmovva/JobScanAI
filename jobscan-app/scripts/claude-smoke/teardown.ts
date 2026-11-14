/**
 * How a real run ends, in the order Windows needs.
 *
 * The scratch Chrome goes first. The app starts it, and on Windows it
 * inherits the app's stdio pipes; Playwright's close() waits for those pipes
 * to close, so it would hang for as long as that Chrome lives. Then the app
 * gets 30 s to close before its whole process tree is killed.
 *
 * Real users are not affected: an app started from the Start menu has no
 * pipes for Chrome to inherit.
 */
import { execSync } from 'child_process'
import path from 'path'
import type { ElectronApplication } from '@playwright/test'

/** Kills every Chrome whose command line names this run's scratch folder. */
export function killScratchChrome(root: string): void {
  // mkdtemp names are letters, digits and dashes: safe in both patterns below.
  const tag = path.basename(root)
  try {
    if (process.platform === 'win32') {
      const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | `
        + `Where-Object { $_.CommandLine -like '*${tag}*' } | `
        + `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`,
        { stdio: 'ignore', timeout: 60_000, windowsHide: true })
    } else {
      execSync(`pkill -f -- "chrom.*${tag}"`, { stdio: 'ignore' })
    }
  } catch { /* none running */ }
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: true })
    else process.kill(pid, 'SIGKILL')
  } catch { /* already gone */ }
}

/** Ends the run: scratch Chrome, then the app (30 s, then killed). */
export async function endRun(app: ElectronApplication, root: string): Promise<'closed' | 'killed'> {
  killScratchChrome(root)
  const pid = app.process().pid
  const closed = await Promise.race([
    app.close().then(() => true, () => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 30_000)),
  ])
  if (closed) return 'closed'
  if (pid) killTree(pid)
  killScratchChrome(root)
  return 'killed'
}
