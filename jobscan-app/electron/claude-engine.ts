/**
 * The Claude engine: each AI call is one isolated `claude -p` run of the
 * user's own Claude Code (see claude-cli.ts for the isolation).
 *
 * Mirrors what the pipeline and the loop expect from the Codex engine:
 *  - resolves with the reply text; rejects only when the call failed;
 *  - failures read like Codex's to the loop's classifiers: "Claude: …" for
 *    an error Claude reported (sign-in, usage limit), "Claude exited (…)"
 *    when the process died without a reply -- neither is the job's fault --
 *    and "Claude: no reply within 5 minutes" for a timeout (retryable, as a
 *    Codex turn timeout is);
 *  - cancel ends the owner's processes at once, and an owner already
 *    canceled is refused without starting a process.
 *
 * Pure Node (no Electron): unit-tested with tests/unit/fixtures/fake-claude.cjs.
 */
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import type { AiCall, AiEngine } from './ai-engine'
import {
  workerArgs, workerEnv, authStatusArgs, spawnSpecFor, parseClaudeOutput, parseAuthStatus,
  type ClaudeUsage,
} from './claude-cli'
import { killTree, treeSpawnOptions } from './proc'

export const CLAUDE_TIMEOUT_MS = 5 * 60_000
const AUTH_TTL_MS = 60_000
const AUTH_TIMEOUT_MS = 30_000

export interface ClaudeCallInfo {
  kind: AiCall['kind']
  outcome: 'ok' | 'error' | 'exited' | 'timeout' | 'canceled'
  ms: number
  usage: ClaudeUsage | null
}

export interface ClaudeEngineDeps {
  /** The Claude Code binary or script, or null when none is installed. */
  binary: () => string | null
  /** '' = Claude Code's own default. */
  model: () => string
  /** An empty folder that only these workers use. */
  workDir: () => string
  env?: () => Record<string, string | undefined>
  execPath?: string
  timeoutMs?: number
  now?: () => number
  /** One record per finished call, for notices. */
  onCall?: (info: ClaudeCallInfo) => void
}

export const CANCELED = 'AI call canceled'
export const NOT_FOUND = 'Claude: Claude Code was not found. Install it, or set its path in Settings.'

interface Running { child: ChildProcess; canceled: boolean }

export function createClaudeEngine(deps: ClaudeEngineDeps): AiEngine {
  const timeoutMs = deps.timeoutMs ?? CLAUDE_TIMEOUT_MS
  const now = deps.now ?? Date.now
  const execPath = deps.execPath ?? process.execPath
  const env = (): Record<string, string> => workerEnv(deps.env ? deps.env() : process.env)
  const byOwner = new Map<object | undefined, Set<Running>>()
  const canceledOwners = new WeakSet<object>()
  let auth: { at: number; value: boolean } | null = null

  const isCanceled = (owner: object | undefined): boolean =>
    !!owner && (canceledOwners.has(owner) || (owner as { canceled?: unknown }).canceled === true)

  function emptyWorkDir(): string {
    const dir = deps.workDir()
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Nothing a previous run left there may be readable by the next one.
    for (const entry of fs.readdirSync(dir)) {
      try { fs.rmSync(`${dir}/${entry}`, { recursive: true, force: true }) } catch { /* in use */ }
    }
    return dir
  }

  function runOnce(call: AiCall, binary: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const started = now()
      const spec = spawnSpecFor(binary, workerArgs(deps.model()), env(), execPath)
      let child: ChildProcess
      try {
        child = spawn(spec.command, spec.args, {
          cwd: emptyWorkDir(), env: spec.env, stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true, ...treeSpawnOptions(),
        })
      } catch (e) {
        reject(Object.assign(new Error(`Claude exited (spawn failed: ${(e as Error).message})`), { spawnFailed: true }))
        return
      }
      const running: Running = { child, canceled: false }
      const set = byOwner.get(call.owner) ?? new Set<Running>()
      set.add(running)
      byOwner.set(call.owner, set)

      let stdout = ''
      let settled = false
      const finish = (outcome: ClaudeCallInfo['outcome'], usage: ClaudeUsage | null, fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        set.delete(running)
        if (set.size === 0) byOwner.delete(call.owner)
        deps.onCall?.({ kind: call.kind, outcome, ms: now() - started, usage })
        fn()
      }
      const timer = setTimeout(() => {
        killTree(child)
        finish('timeout', null, () => reject(new Error(`Claude: no reply within ${Math.round(timeoutMs / 60_000)} minutes`)))
      }, timeoutMs)

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (d: string) => { stdout += d })
      child.stderr?.resume()
      child.on('error', err => {
        if (running.canceled) return finish('canceled', null, () => reject(new Error(CANCELED)))
        finish('exited', null, () => reject(Object.assign(
          new Error(`Claude exited (spawn error: ${(err as NodeJS.ErrnoException).code ?? err.message})`),
          { spawnFailed: true })))
      })
      child.on('close', (code, signal) => {
        if (running.canceled) return finish('canceled', null, () => reject(new Error(CANCELED)))
        const out = parseClaudeOutput(stdout, code, signal)
        if (out.kind === 'ok') return finish('ok', out.usage, () => resolve(out.text))
        if (out.kind === 'error') {
          // Signed out since the last check: the loop's precondition must see it.
          if (/not logged in/i.test(out.message)) auth = { at: now(), value: false }
          return finish('error', null, () => reject(new Error(`Claude: ${out.message}`)))
        }
        finish('exited', null, () => reject(new Error(out.message)))
      })
      child.stdin?.on('error', () => { /* the process went away; close reports it */ })
      child.stdin?.end(`${call.system}\n\n---\n\n${call.user}`)
    })
  }

  return {
    id: 'claude',

    async complete(call: AiCall): Promise<string> {
      if (isCanceled(call.owner)) throw new Error(CANCELED)
      const binary = deps.binary()
      if (!binary) throw new Error(NOT_FOUND)
      try {
        return await runOnce(call, binary)
      } catch (e) {
        // A binary being swapped by Claude Code's own updater can fail to
        // start once; one retry, never for a call that already ran.
        if ((e as { spawnFailed?: boolean }).spawnFailed && !isCanceled(call.owner)) {
          return await runOnce(call, binary)
        }
        throw e
      }
    },

    hashModel: () => `claude:${deps.model().trim() || 'default'}`,

    async ready(): Promise<boolean> {
      if (auth && now() - auth.at < AUTH_TTL_MS) return auth.value
      const binary = deps.binary()
      if (!binary) return false
      const value = await new Promise<boolean>(resolve => {
        const spec = spawnSpecFor(binary, authStatusArgs(), env(), execPath)
        let out = ''
        let child: ChildProcess
        try {
          child = spawn(spec.command, spec.args, { env: spec.env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
        } catch { resolve(false); return }
        const t = setTimeout(() => { killTree(child); resolve(false) }, AUTH_TIMEOUT_MS)
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (d: string) => { out += d })
        child.on('error', () => { clearTimeout(t); resolve(false) })
        child.on('close', () => { clearTimeout(t); resolve(parseAuthStatus(out) === true) })
      })
      auth = { at: now(), value }
      return value
    },

    limits: async () => null,

    async cancelAll(): Promise<void> {
      for (const set of byOwner.values()) {
        for (const r of set) { r.canceled = true; killTree(r.child) }
      }
    },

    cancelOwner(owner: object): void {
      canceledOwners.add(owner)
      for (const r of byOwner.get(owner) ?? []) { r.canceled = true; killTree(r.child) }
    },
  }
}
