/**
 * Running the user's own Claude Code as an isolated, tool-less worker for
 * one AI call -- the command, its environment, and reading its reply.
 *
 * Each call is a fresh `claude -p` that can only read the prompt on stdin
 * and write a reply: no tools, no MCP servers (claude.ai connectors
 * included), none of the user's settings, hooks, plugins or CLAUDE.md files,
 * no `@file` expansion, no saved transcript, and an empty working folder.
 * The prompt contains job-posting text, which is untrusted; a measured
 * canary showed `@path` in stdin IS expanded unless
 * CLAUDE_CODE_DISABLE_ATTACHMENTS=1. The reply goes only back to the app.
 *
 * Pure (no Electron): unit-tested against tests/unit/fixtures/fake-claude.cjs.
 */
import path from 'path'

export const WORKER_SYSTEM =
  'You answer one request from the JobScan desktop app. Follow the request exactly. '
  + 'Output only the reply it asks for — no code fences, no commentary.'

type Env = Record<string, string | undefined>

/** Set by a parent Claude Code session for its children; never passed on. */
const SESSION_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_EFFORT', 'CLAUDE_PID',
]

/**
 * The worker's environment. Provider settings (CLAUDE_CONFIG_DIR, Bedrock,
 * Vertex) pass through; a parent session's variables and ANTHROPIC_API_KEY
 * do not -- in -p mode an API key would silently replace the user's
 * subscription.
 */
export function workerEnv(base: Env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v
  for (const k of SESSION_VARS) delete env[k]
  delete env['ANTHROPIC_API_KEY']
  env['CLAUDE_CODE_DISABLE_ATTACHMENTS'] = '1'
  env['ENABLE_CLAUDEAI_MCP_SERVERS'] = 'false'
  env['CLAUDE_CODE_DISABLE_CLAUDE_MDS'] = '1'
  env['DISABLE_AUTOUPDATER'] = '1'
  return env
}

export function workerArgs(model: string): string[] {
  const m = model.trim()
  return [
    '-p', '--output-format', 'json',
    '--system-prompt', WORKER_SYSTEM,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--no-chrome',
    '--max-turns', '1',
    '--permission-mode', 'dontAsk',
    '--disallowedTools', 'mcp__*',
    ...(m ? ['--model', m] : []),
  ]
}

/** `claude auth status --json`, same isolation as a worker. */
export function authStatusArgs(): string[] {
  return ['auth', 'status', '--json']
}

export interface SpawnSpec { command: string; args: string[]; env: Record<string, string> }

/**
 * A native binary runs directly. A .js/.cjs/.mjs entry point (an npm
 * install's script, or the test fake) runs with this process's own runtime
 * as plain Node: Windows cannot execute a script file.
 */
export function spawnSpecFor(binary: string, args: string[], env: Record<string, string>, execPath: string): SpawnSpec {
  if (/\.(c|m)?js$/i.test(binary)) {
    return { command: execPath, args: [binary, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { command: binary, args, env }
}

export type ClaudeOutcome =
  | { kind: 'ok'; text: string; usage: ClaudeUsage | null }
  | { kind: 'error'; message: string }
  | { kind: 'exited'; message: string }

export interface ClaudeUsage { input: number; cacheWrite: number; cacheRead: number; output: number }

/** The reply in a `--output-format json` run: the last JSON line on stdout. */
export function parseClaudeOutput(stdout: string, code: number | null, signal: string | null): ClaudeOutcome {
  const lines = String(stdout ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(lines[i]!) as Record<string, unknown> } catch { continue }
    if (parsed['type'] !== 'result') continue
    if (parsed['is_error'] === true || (parsed['subtype'] && parsed['subtype'] !== 'success')) {
      const message = String(parsed['result'] ?? parsed['subtype'] ?? 'unknown error').trim() || 'unknown error'
      return { kind: 'error', message }
    }
    const u = parsed['usage'] as Record<string, unknown> | undefined
    const usage = u
      ? {
          input: Number(u['input_tokens'] ?? 0),
          cacheWrite: Number(u['cache_creation_input_tokens'] ?? 0),
          cacheRead: Number(u['cache_read_input_tokens'] ?? 0),
          output: Number(u['output_tokens'] ?? 0),
        }
      : null
    return { kind: 'ok', text: String(parsed['result'] ?? ''), usage }
  }
  return { kind: 'exited', message: `Claude exited (code=${code}, signal=${signal}) without a reply` }
}

/** `claude auth status --json` → signed in? null when it cannot tell. */
export function parseAuthStatus(stdout: string): boolean | null {
  try {
    const j = JSON.parse(String(stdout ?? '').trim()) as { loggedIn?: unknown }
    return typeof j.loggedIn === 'boolean' ? j.loggedIn : null
  } catch { return null }
}

export interface ResolveOptions {
  setting: string
  env: Env
  platform: NodeJS.Platform
  homedir: string
  exists: (p: string) => boolean
  readFile: (p: string) => string
}

/**
 * Where the user's Claude Code is. Under E2E_TEST only JOBSCAN_CLAUDE_BIN
 * counts, so no test can reach the user's real account by accident.
 * Never a .cmd/.ps1 shim: those need a shell.
 */
export function resolveClaudeBinary(o: ResolveOptions): string | null {
  const isFile = (p: string): boolean => { try { return !!p && o.exists(p) } catch { return false } }
  const override = (o.env['JOBSCAN_CLAUDE_BIN'] ?? '').trim()
  if (o.env['E2E_TEST'] === '1') return override && isFile(override) ? override : null
  if (o.setting.trim() && isFile(o.setting.trim())) return o.setting.trim()
  if (override && isFile(override)) return override

  const win = o.platform === 'win32'
  const exe = win ? 'claude.exe' : 'claude'
  const known = win
    ? [path.join(o.homedir, '.local', 'bin', exe)]
    : [path.join(o.homedir, '.local', 'bin', exe), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  for (const p of known) if (isFile(p)) return p

  const pathVar = o.env['PATH'] ?? o.env['Path'] ?? ''
  for (const dir of pathVar.split(win ? ';' : ':').map(s => s.trim()).filter(Boolean)) {
    const p = path.join(dir, exe)
    if (isFile(p)) return p
  }

  // npm installs: the package says where its entry point is.
  const prefixes = win
    ? [o.env['APPDATA'] ? path.join(o.env['APPDATA']!, 'npm') : '']
    : ['/usr/local', '/opt/homebrew', path.join(o.homedir, '.npm-global')]
  for (const prefix of prefixes.filter(Boolean)) {
    const pkgDir = win
      ? path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code')
      : path.join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code')
    const pkgJson = path.join(pkgDir, 'package.json')
    if (!isFile(pkgJson)) continue
    try {
      const bin = (JSON.parse(o.readFile(pkgJson)) as { bin?: string | Record<string, string> }).bin
      const rel = typeof bin === 'string' ? bin : bin?.['claude']
      if (rel) {
        const p = path.join(pkgDir, rel)
        if (isFile(p)) return p
      }
    } catch { /* unreadable package.json */ }
  }
  return null
}
