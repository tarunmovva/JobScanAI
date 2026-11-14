/**
 * "Let Claude Code drive JobScan": the switch in Settings, and the glue
 * between the local endpoint (harness-server.ts) and the app.
 *
 * Off by default. On, it:
 *  - starts the endpoint and writes harness.json for the jobscan MCP server;
 *  - forwards app events into notices (numbers and labels only);
 *  - lets the six agent actions call the same functions the window's
 *    buttons call, after the same checks;
 *  - shows the agent's notes in the window, labelled as coming from it;
 *  - holds a single-instance lock, so harness.json always names this app.
 */
import { app, ipcMain, BrowserWindow } from 'electron'
import path from 'path'
import store, { peek } from './state-store'
import { startHarnessServer, type HarnessHandle } from './harness-server'
import { NoticeFeed, noticesFromEvent, aiCallNotice } from './notices'
import { setNoticeSink } from './notice-hub'
import { createAgentActions, AGENT_ACTIONS } from './agent-actions'
import { onClaudeCall } from './ai-engine-claude'
import { selectedEngineId } from './ai-engine'
import {
  isPipelineActive, isRatingEngineActive, getFetchState, setState, runFetch, cancelActivePipeline,
  runQueryGen, runUserQueryGen, runRating,
} from './pipeline'
import { currentAppState, safeSendError } from './ipc-handlers'
import type { Loop } from './loop-runner'
import type { AppState } from '../src/types'

/** A driver that asked for notices this recently counts as connected. */
const CONNECTED_MS = 60_000

let handle: HarnessHandle | null = null
let feed: NoticeFeed | null = null
let stopClaudeCalls: (() => void) | null = null
let loopRef: Loop | null = null
const notes: Array<{ text: string; at: string; from: 'agent' | 'app' }> = []

function sendToWindow(channel: string, data: unknown): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  try { win.webContents.send(channel, data) } catch { /* window gone */ }
}

function addNote(text: string, from: 'agent' | 'app'): void {
  const note = { text, at: new Date().toISOString(), from }
  notes.push(note)
  if (notes.length > 20) notes.shift()
  sendToWindow('agent:note', note)
}

const failed = (what: string) => (e: unknown): void => {
  safeSendError(String(e))
  console.error(`[agent:${what}] error:`, String(e))
}

const runAction = createAgentActions({
  loopIsOn: () => loopRef?.isOn() === true,
  isPipelineActive,
  isRatingEngineActive,
  appState: () => currentAppState(),
  fetchStatus: () => getFetchState().status,
  queriesReady: () => ((store.get('queryList') as unknown[] | undefined) ?? []).length > 0,
  poolSize: () => (peek<unknown[]>('candidates') ?? []).length,
  setState: s => setState(s as AppState),
  runFetch: () => { runFetch().catch(e => console.error('[fetch]', String(e))) },
  cancelRebuild: () => { void cancelActivePipeline('agent:cancel-rebuild') },
  runQueryGen: () => { runQueryGen().catch(failed('find_jobs')) },
  runUserQueryGen: ask => { runUserQueryGen(ask).catch(failed('find_more')) },
  runRating: () => { runRating().catch(failed('rate_jobs')) },
  stopLoop: mode => { if (mode === 'now') void loopRef?.stopNow(); else loopRef?.stopAfterRound() },
})

/** What a driver may know about the app: labels and counts, nothing a posting wrote. */
function statusPayload(): Record<string, unknown> {
  const s = loopRef?.status()
  return {
    state: currentAppState(),
    busy: isPipelineActive() || isRatingEngineActive(),
    engine: selectedEngineId(),
    rebuild: getFetchState().status,
    searches: ((store.get('queryList') as unknown[] | undefined) ?? []).length,
    pool: (peek<unknown[]>('candidates') ?? []).length,
    rated: ((store.get('ratedJobs') as unknown[] | undefined) ?? []).length,
    loop: s
      ? { phase: s.phase, round: s.round, stage: s.stage ?? '', wait: s.waitReason, applied_today: s.today.attempted, daily_limit: s.today.limit }
      : null,
    actions: [...AGENT_ACTIONS],
  }
}

export async function startHarness(): Promise<{ ok: boolean; error?: string }> {
  if (handle) return { ok: true }
  if (!app.requestSingleInstanceLock()) {
    return { ok: false, error: 'Another JobScan window is open. Close it, then turn this on.' }
  }
  const f = new NoticeFeed()
  feed = f
  setNoticeSink((channel, data) => { for (const n of noticesFromEvent(channel, data)) f.add(n) })
  stopClaudeCalls = onClaudeCall(info => f.add(aiCallNotice(info)))
  try {
    handle = await startHarnessServer({
      version: app.getVersion(),
      feed: f,
      status: statusPayload,
      note: text => addNote(text, 'agent'),
      action: (name, args) => {
        const result = runAction(name, args)
        f.add(['agent_action', { action: (AGENT_ACTIONS as readonly string[]).includes(name) ? name : 'unknown', ok: result.ok }])
        if (result.ok) addNote(`Started by your agent: ${name.replace(/_/g, ' ')}`, 'app')
        return result
      },
    }, path.join(app.getPath('userData'), 'harness.json'))
    console.log(`[harness] listening on 127.0.0.1:${handle.port}`)
    return { ok: true }
  } catch (e) {
    await stopHarness()
    return { ok: false, error: `Could not start: ${String((e as Error)?.message ?? e).slice(0, 120)}` }
  }
}

export async function stopHarness(quitting = false): Promise<void> {
  const f = feed
  if (quitting && f) {
    f.add(['app_quitting', {}])
    await new Promise(r => setTimeout(r, 200))      // let a waiting driver hear it
  }
  setNoticeSink(null)
  stopClaudeCalls?.()
  stopClaudeCalls = null
  feed = null
  const h = handle
  handle = null
  if (h) { try { await h.close() } catch { /* best effort */ } }
  try { app.releaseSingleInstanceLock() } catch { /* not held */ }
}

export function harnessStatus(): { enabled: boolean; connected: boolean; notes: typeof notes } {
  return {
    enabled: handle !== null,
    connected: feed !== null && Date.now() - feed.lastPollAt < CONNECTED_MS,
    notes: [...notes],
  }
}

/** Window-only: the switch and the chip's status. Agents cannot reach these. */
export function registerHarness(loop: Loop): void {
  loopRef = loop
  ipcMain.handle('harness:get-status', () => harnessStatus())
  ipcMain.handle('harness:set', async (_e, arg?: { enabled?: unknown }) => {
    if (arg?.enabled === true) {
      const r = await startHarness()
      if (r.ok) store.set('harnessEnabled', true)
      return { ...r, ...harnessStatus() }
    }
    store.set('harnessEnabled', false)
    await stopHarness()
    return { ok: true, ...harnessStatus() }
  })
}
