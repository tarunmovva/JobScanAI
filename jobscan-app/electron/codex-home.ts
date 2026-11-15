/**
 * Codex's own data folder: $CODEX_HOME when set, else ~/.codex — the rule
 * Codex itself follows. The sign-in check and the boot-time log tidy read it
 * through here, so a test that points CODEX_HOME at a scratch folder never
 * reads or rewrites the user's real ~/.codex.
 */
import os from 'os'
import path from 'path'

type Env = Record<string, string | undefined>

export function codexHome(env: Env = process.env): string {
  const configured = (env['CODEX_HOME'] ?? '').trim()
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex')
}

/**
 * Tests only: a stand-in for the Codex binary, as JSON {"command", "args"}.
 * Honoured only under E2E_TEST=1. Under E2E_TEST without it, Codex cannot
 * start at all, so no test can reach the user's real Codex account.
 */
export interface CodexCommand { command: string; args: string[] }

export const E2E_NO_CODEX = 'jobscan-e2e-codex-disabled'

export function e2eCodexCommand(env: Env = process.env): CodexCommand | null {
  if (env['E2E_TEST'] !== '1') return null
  const raw = (env['JOBSCAN_E2E_CODEX_COMMAND'] ?? '').trim()
  if (!raw) return { command: E2E_NO_CODEX, args: [] }
  try {
    const parsed = JSON.parse(raw) as { command?: unknown; args?: unknown }
    const command = typeof parsed.command === 'string' ? parsed.command : ''
    const args = Array.isArray(parsed.args) ? parsed.args.map(String) : []
    return command ? { command, args } : { command: E2E_NO_CODEX, args: [] }
  } catch {
    return { command: E2E_NO_CODEX, args: [] }
  }
}
