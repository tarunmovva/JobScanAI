import { spawn, SpawnOptions, ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import store from './state-store'
import { tokenizeQueryFlags } from './query-flags'
import { getCodexBinaryPath, activeCodexModel } from './codex-client'
import { unattendedEnv } from './run-mode'
import { collectChild, killTree, treeSpawnOptions } from './proc'
import { resolvePython } from './app-paths'
import { parseSearchOutput } from './search-output'

function storeGet(key: string): string {
  return store.get(key) as string
}

/** The Python the automator runs with: this checkout's venv, else python / python3. */
export function automatorPython(): string {
  return resolvePython(process.platform, storeGet('pythonDir') ?? '', fs.existsSync)
}

function getEnv(): NodeJS.ProcessEnv {
  // JOB_AUTOMATOR_CODEX_BIN pins the python recovery agent to the SAME codex the
  // app-server side uses. Without it agent_recovery.py falls back to
  // shutil.which("codex") and picks up whatever is on PATH — so an auto-update
  // would land on one surface and not the other.
  const codexBin = getCodexBinaryPath()
  // Settings' model, or the one "Auto" resolved to: with nothing passed, the
  // recovery agent falls back to a fixed model a new account may not have.
  const recoveryModel = activeCodexModel()
  return {
    ...process.env,
    JOB_AUTOMATOR_HOME: storeGet('jobAutomatorHome'),
    JOB_AUTOMATOR_PYTHON_DIR: storeGet('pythonDir'),
    // jobscan runs the fillers with $PYTHON (bare `python` otherwise, which a Mac does not have).
    PYTHON: automatorPython(),
    ...(codexBin ? { JOB_AUTOMATOR_CODEX_BIN: codexBin } : {}),
    // The recovery agent used to pass no -m and inherit codex's config.toml,
    // which on a developer machine was the most expensive model available
    // while the app was set to the cheapest. It reads the app config as a
    // fallback, but the app knowing its own choice should not depend on that.
    ...(recoveryModel ? { JOB_AUTOMATOR_RECOVERY_MODEL: recoveryModel } : {}),
    // Last, so nothing above can unset it: during a loop round nobody is at
    // the computer, and the fillers close every tab (JOB_AUTOMATOR_UNATTENDED).
    ...unattendedEnv(),
  }
}

interface RunResult {
  stdout: string
  stderr: string
  /** -2 when the deadline ran out. */
  exitCode: number
  /** The process tree was killed on its deadline (only when `timeoutMs` was given). */
  timedOut: boolean
}

// Cancel token type — kept structural to avoid circular import with pipeline.ts
export interface CliCancelToken {
  canceled: boolean
  children: Set<ChildProcess>
}

/**
 * The one database every jobscan invocation must agree on.
 *
 * Without an explicit --db the CLI picks its own default, which is
 * `<exeDir>/jobs.db` only when a `data/` directory happens to sit next to the
 * binary and `<cwd>/jobs.db` otherwise -- and the Electron cwd is not a place
 * anyone fetches into. Fetch already passed --db explicitly, so on a machine
 * without that `data/` directory fetch would populate one file while search
 * read another, and search would return nothing, forever, without an error.
 */
export function getDbPath(): string {
  const exePath = storeGet('jobscanExePath')
  return path.join(path.dirname(exePath), 'jobs.db').replace(/\\/g, '/')
}

/**
 * Run one jobscan command. Resolves with its exit code; rejects only when the
 * program cannot start.
 *
 * `timeoutMs` (loop rounds only) kills the whole process tree when it runs
 * out, and resolves with `exitCode: -2, timedOut: true` once the tree is gone.
 */
export function runCli(
  args: string[],
  onLine?: (line: string) => void,
  token?: CliCancelToken,
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const exe = storeGet('jobscanExePath')
    const spawnOpts: SpawnOptions = { env: getEnv(), shell: false, windowsHide: true, ...treeSpawnOptions() }
    // --db is a persistent root flag, so it goes before the subcommand.
    const child = spawn(exe, args[0] === '--db' ? args : ['--db', getDbPath(), ...args], spawnOpts)
    if (token) {
      if (token.canceled) killTree(child)
      token.children.add(child)
    }
    collectChild(child, { onLine, timeoutMs: opts.timeoutMs }).then(
      (r) => { token?.children.delete(child); resolve(r) },
      (err) => { token?.children.delete(child); reject(err) },
    )
  })
}

// Which optional search flags this jobscan binary understands. The app can be
// pointed at an externally-installed CLI, and passing an unknown flag makes
// jobscan exit non-zero — which cliSearch would swallow into an empty result
// set, i.e. every search silently returning nothing. Probed once, cached.
let _searchFlagSupport: Promise<Set<string>> | null = null
const OPTIONAL_SEARCH_FLAGS = ['--dedupe', '--max-per-company'] as const

function searchFlagSupport(): Promise<Set<string>> {
  if (!_searchFlagSupport) {
    _searchFlagSupport = runCli(['search', '--help'])
      .then(({ stdout }) => new Set(OPTIONAL_SEARCH_FLAGS.filter(f => stdout.includes(f))))
      .catch(() => new Set<string>())
  }
  return _searchFlagSupport
}

/** A search's tokens, with the pool's defaults added where the search does not set them. */
async function withSearchDefaults(searchTokens: string[]): Promise<string[]> {
  const tokens = [...searchTokens]
  // jobscan's default --limit is 25 — far too small for the retrieval pool.
  // Relevance sort (bm25, title-weighted) makes top-100 the right slice.
  if (!tokens.includes('--limit')) tokens.push('--limit', '100')
  // A retrieval pool wants distinct openings, not the same title at the same
  // company four times. Measured on a representative slice: 70 → 79 distinct
  // companies per 100, and one employer that held 11 slots now holds 3.
  const supported = await searchFlagSupport()
  if (supported.has('--dedupe') && !tokens.includes('--dedupe')) tokens.push('--dedupe')
  if (supported.has('--max-per-company') && !tokens.includes('--max-per-company')) {
    tokens.push('--max-per-company', '3')
  }
  return tokens
}

export async function cliSearch(queryFlags: string, token?: CliCancelToken): Promise<unknown[]> {
  // Parse shell-like flags, preserving single-quoted phrases (jobscan needs them)
  // e.g. --title-query "'backend engineer'" → ['--title-query', "'backend engineer'"]
  const tokens = await withSearchDefaults(tokenizeQueryFlags(queryFlags))
  const { stdout, stderr } = await runCli(['search', ...tokens, '--format', 'json'], undefined, token)
  if (stderr) console.error('[jobscan search stderr]', stderr.slice(0, 200))
  try { return JSON.parse(stdout) } catch { return [] }
}

/**
 * The same search for loop mode, read strictly: it throws when the search did
 * not work, so a CLI error can never pass for "no results". A search that
 * matched nothing returns [].
 */
export async function cliSearchStrict(searchTokens: string[], token?: CliCancelToken): Promise<unknown[]> {
  const tokens = await withSearchDefaults(searchTokens)
  return parseSearchOutput(await runCli(['search', ...tokens, '--format', 'json'], undefined, token))
}

/** Run one SQL query against jobs.db, asynchronously: its rows, or null when it failed. */
export async function cliDbQuery(sql: string, token?: CliCancelToken, timeoutMs?: number): Promise<unknown[] | null> {
  try {
    const { exitCode, stdout, stderr } = await runCli(['db', 'query', sql], undefined, token, { timeoutMs })
    if (exitCode !== 0) {
      console.warn('[db query] failed:', stderr.slice(0, 300))
      return null
    }
    const rows = JSON.parse(stdout || '[]')
    return Array.isArray(rows) ? rows : null
  } catch (e) {
    console.warn('[db query] failed:', String(e).slice(0, 200))
    return null
  }
}

/** Run one SQL statement against jobs.db, asynchronously. True on success. */
export async function cliDbExec(sql: string, token?: CliCancelToken): Promise<boolean> {
  if (!sql) return true
  try {
    const { exitCode, stderr } = await runCli(['db', 'exec', sql], undefined, token)
    if (exitCode !== 0) console.warn('[db exec] failed:', stderr.slice(0, 200))
    return exitCode === 0
  } catch (e) {
    console.warn('[db exec] failed:', String(e).slice(0, 200))
    return false
  }
}

/** Queue the selected jobs for extraction. The exit code and stderr say whether it ran. */
export async function cliQueueJobs(jobIds: string[], token?: CliCancelToken): Promise<{ exitCode: number; stderr: string }> {
  const { exitCode, stderr } = await runCli(['apply', 'queue', '--job-ids', jobIds.join(',')], undefined, token)
  return { exitCode, stderr }
}

/** Read the queued forms of one platform. The exit code and stderr say whether it ran at all. */
export async function cliExtract(
  platform: string,
  onLine: (line: string) => void,
  token?: CliCancelToken
): Promise<{ exitCode: number; stderr: string }> {
  const { exitCode, stderr } = await runCli(
    ['apply', 'extract', '--platform', platform, '--workers', '3', '--limit', '200'],
    onLine,
    token
  )
  return { exitCode, stderr }
}

export async function cliClaim(agentId: string, count: number, token?: CliCancelToken): Promise<unknown[]> {
  const { stdout } = await runCli([
    'apply', 'claim',
    '--count', String(Math.min(count, 15)),
    '--agent-id', agentId,
    '--format', 'json',
  ], undefined, token)
  try { return JSON.parse(stdout) } catch { return [] }
}

/**
 * Fill and submit one claimed job. `timedOut` is set only when a deadline was
 * given (loop rounds) and ran out; the filler's whole tree is gone by then.
 */
export async function cliSubmit(
  claimToken: string,
  jobId: string,
  payloadFile: string,
  otpMailbox: string = '',
  token?: CliCancelToken,
  opts: { timeoutMs?: number } = {},
): Promise<{ output: string; timedOut: boolean }> {
  const { stdout, stderr, timedOut } = await runCli([
    'apply', 'submit',
    '--claim-token', claimToken,
    '--job-id', jobId,
    '--payload-file', payloadFile,
    '--otp-mailbox', otpMailbox,
  ], undefined, token, { timeoutMs: opts.timeoutMs })
  return { output: stdout + stderr, timedOut }
}

export async function cliStatus(): Promise<Record<string, number>> {
  const { stdout } = await runCli(['apply', 'status', '--format', 'json'])
  try { return JSON.parse(stdout) } catch { return {} }
}
