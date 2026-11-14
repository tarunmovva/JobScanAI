/**
 * The conductor's deps, for real: the pipeline, the store, Codex, Chrome and
 * the OS. Each one reports what actually happened -- the conductor decides
 * everything from these answers, so none may guess.
 */
import { BrowserWindow, powerSaveBlocker } from 'electron'
import fs from 'fs'
import store, { peek } from './state-store'
import {
  runFetch, getFetchState, regenerateSavedQueries, researchSavedQueries, rateNewJobs,
  seedBoard, runBoard, cancelActivePipeline, isPipelineActive, isRatingEngineActive,
  queryInputsHash, markPlatformSkippedOnBoard,
} from './pipeline'
import { cliDbExec } from './cli-runner'
import { skipPlatformSql } from './queue-sql'
import { closeTabsFor } from './chrome-tabs'
import { aiEngine, selectedEngineId } from './ai-engine'
import { noticeEvent } from './notice-hub'
import { appliedKeys, isApplied } from './applied-jobs'
import { queriesStale } from './loop-policy'
import { extractFailures } from './selection'
import { setUnattended, setRunHooks } from './run-mode'
import type { LoopDeps } from './loop-runner'
import type { BreakerState, LoopSettings, LoopState, SelectableJob } from '../src/types'

/** setTimeout's ceiling (~24.8 days); a longer wait would fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

export function createLoopDeps(getWindow: () => BrowserWindow | null): LoopDeps {
  let blocker: number | null = null

  // appliedKeys() rebuilds a set from two store reads; selection asks once
  // per rated job. Rebuilt at most once a second.
  let applied: { at: number; keys: ReturnType<typeof appliedKeys> } | null = null
  const spent = (): ReturnType<typeof appliedKeys> => {
    const now = Date.now()
    if (!applied || now - applied.at > 1000) applied = { at: now, keys: appliedKeys() }
    return applied.keys
  }

  return {
    now: () => new Date(),
    setTimer: (fn, ms) => setTimeout(fn, Math.min(Math.max(0, ms), MAX_TIMER_MS)),
    clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),

    signedIn: async () => {
      // e2e never spawns codex; a spec that needs a running loop says so.
      if (process.env['E2E_TEST'] === '1') return process.env['E2E_LOOP_SIGNED_IN'] === '1'
      // Codex: (await codexLoginStatus()) ?? checkAuth(), as before (ai-engine-codex.ts).
      return aiEngine().ready()
    },
    aiName: () => (selectedEngineId() === 'claude' ? 'Claude Code' : 'Codex'),
    // Codex reads its usage windows; Claude has none to read (null), so its
    // limits are learned from the first call that hits one.
    codexLimits: () => aiEngine().limits(),
    hasResume: () => String(store.get('resumeText') ?? '').trim().length > 0,
    exeExists: () => {
      try { return fs.existsSync(String(store.get('jobscanExePath') ?? '')) } catch { return false }
    },
    isBusy: () => isPipelineActive() || isRatingEngineActive(),
    savedQueries: () => (((store.get('queryList') as unknown as Array<{ name?: string; flags?: string }>) ?? [])
      .filter(q => typeof q?.flags === 'string')
      .map(q => ({ name: q.name, flags: String(q.flags) }))),
    queriesStale: () => queriesStale(String(store.get('queryListInputsHash') ?? ''), queryInputsHash()),

    rebuild: async () => {
      // runFetch reports only through its snapshot. If it never ran -- the
      // token was taken -- the snapshot is a previous fetch's, success and
      // all; a fresh start time is the proof this one ran.
      const before = getFetchState().startedAt
      await runFetch()
      const s = getFetchState()
      if (s.startedAt === before) return 'failed'
      if (s.status === 'success') return 'success'
      if (s.status === 'canceled') return 'canceled'
      return 'failed'
    },
    regenerate: () => regenerateSavedQueries(),
    research: o => researchSavedQueries(o),
    rate: () => rateNewJobs(),
    // Selection only reads and filters it: no copy of the pool.
    ratedJobs: () => (peek<SelectableJob[]>('ratedJobs') ?? []),
    isApplied: (p, id) => isApplied(spent(), p, id),
    appliedLog: () => ((store.get('appliedJobsLog') as unknown as ReturnType<LoopDeps['appliedLog']>) ?? []),

    apply: async ids => {
      store.set('selectedJobIds', ids as never)
      seedBoard()
      await runBoard()   // a throw fails the round as "Applying failed"
      applied = null     // new submissions since
      return {
        ok: store.get('appState') === 'done',
        extractFailed: extractFailures(store.get('extractResults') as never, ids),
      }
    },
    cancelPipeline: reason => cancelActivePipeline(reason),
    sweepPlatform: (platform, reason) => {
      // Its waiting rows never reach an agent; their cards would sit in To do.
      void cliDbExec(skipPlatformSql(platform, reason)).catch(() => false)
      markPlatformSkippedOnBoard(platform, reason)
    },
    closeTabsFor: url => { void closeTabsFor(url).catch(() => 0) },

    load: () => ({
      settings: store.get('loopSettings') as LoopSettings,
      state: store.get('loopState') as LoopState,
      breaker: store.get('loopBreaker') as BreakerState,
    }),
    saveSettings: s => store.set('loopSettings', s),
    saveState: s => store.set('loopState', s),
    saveBreaker: b => store.set('loopBreaker', b),

    setUnattended,
    setHooks: setRunHooks,
    keepAwake: on => {
      try {
        if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
        if (!on && blocker !== null) {
          if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
          blocker = null
        }
      } catch (e) {
        console.warn('[loop] keep-awake:', String(e).slice(0, 120))
      }
    },
    emit: status => {
      noticeEvent('loop:status', status)
      const win = getWindow()
      try {
        if (!win || win.isDestroyed()) return
        const wc = win.webContents
        if (!wc || wc.isDestroyed()) return
        wc.send('loop:status', status)
      } catch { /* window gone */ }
    },
  }
}
