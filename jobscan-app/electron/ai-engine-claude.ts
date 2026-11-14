/**
 * The Claude engine as the app runs it: the user's own Claude Code, found
 * on this machine (claude-cli.ts), the model chosen in Settings, and one
 * private, emptied working folder per app launch.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import store from './state-store'
import { resolveClaudeBinary } from './claude-cli'
import { createClaudeEngine, type ClaudeCallInfo } from './claude-engine'
import type { AiEngine } from './ai-engine'

export function claudeBinary(): string | null {
  return resolveClaudeBinary({
    setting: String(store.get('claudePath') ?? ''),
    env: process.env,
    platform: process.platform,
    homedir: os.homedir(),
    exists: p => { try { return fs.statSync(p).isFile() } catch { return false } },
    readFile: p => fs.readFileSync(p, 'utf8'),
  })
}

let launchDir: string | null = null

/** Created on first use (mkdtemp: owner-only on macOS/Linux), removed on quit. */
function workDir(): string {
  if (!launchDir) launchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobscan-claude-'))
  return path.join(launchDir, 'worker')
}

export function disposeClaudeWorkDir(): void {
  if (!launchDir) return
  try { fs.rmSync(launchDir, { recursive: true, force: true }) } catch { /* in use */ }
  launchDir = null
}

const listeners = new Set<(info: ClaudeCallInfo) => void>()
/** Every finished Claude call (kind, outcome, duration, tokens) -- no text. */
export function onClaudeCall(fn: (info: ClaudeCallInfo) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function createClaudeEngineForApp(): AiEngine {
  return createClaudeEngine({
    binary: claudeBinary,
    model: () => String(store.get('claudeModel') ?? ''),
    workDir,
    onCall: info => {
      // One line per call: what ran, how it ended, how long, how many tokens. Never any text.
      const u = info.usage
      console.log(`[claude] ${info.kind} ${info.outcome} ${info.ms}ms`
        + (u ? ` in=${u.input} cache_write=${u.cacheWrite} cache_read=${u.cacheRead} out=${u.output}` : ''))
      for (const fn of listeners) { try { fn(info) } catch { /* a listener never breaks a call */ } }
    },
  })
}
