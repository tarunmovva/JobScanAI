import { ipcMain, shell, dialog, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import path from 'path'
import store, { peek } from './state-store'
import { isOpenableRecordFile } from './record-files'
import { appliedKeys, isApplied } from './applied-jobs'
import { clearCodexClient, getCodexSpawnSpec, buildSpawnEnv, listCodexModels, codexLoginStatus, warmCodex } from './codex-client'
import { ensureLatestCodex, getUpdateStatus, reconcileSavedModel } from './codex-updater'
import { focusApplicationTab } from './chrome-tabs'
import { automatorPython } from './cli-runner'
import {
  runQueryGen, runUserQueryGen, runRating,
  runExtract, runPayloadGen, runFetch, setState,
  cancelActivePipeline, isPipelineActive, getFetchState,
  isRatingEngineActive, getRatingEngineSnapshot, getRatingEngineProgress, runBoard, seedBoard } from './pipeline'
import {
  listProfiles, createProfile, switchProfile, renameProfile, deleteProfile,
} from './profiles'
import type { AppState, LoopSettings } from '../src/types'
import type { Loop } from './loop-runner'
import { LOOP_ON_MESSAGE } from './loop-copy'
import type { IpcMainInvokeEvent } from 'electron'

// ── Back-navigation: ordered list of pipeline-visible states ──────────────────
// Mirrors src/App.tsx SCREEN_NAMES. Used by pipeline:goto-state to validate
// that the requested target is at or before the current state.
const SCREEN_ORDER: AppState[] = [
  'auth', 'resume', 'query_gen', 'rating',
  'board', 'done',
]
// Stages that have real-world side effects (browser Chrome sessions, DB writes
// of submission status). Going back from these is destructive and must be
// gated by an explicit user confirm.
const DESTRUCTIVE_FROM: ReadonlySet<AppState> = new Set(['board'])

// Safe IPC send — guards against the renderer window being destroyed mid-
// shutdown (child-process error handlers fire after before-quit).
function safeSendError(message: string): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  try {
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send('pipeline:error', { message })
  } catch { /* window gone */ }
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>
import fs from 'fs/promises'

/**
 * 'extracting' and 'payload_gen' collapsed into one 'board' state.
 *
 * appState is persisted, so anyone who closed the app mid-run has one of the
 * old values on disk. Without this they would resume into a state no screen
 * maps to and see a blank window.
 */
const LEGACY_STATES: Record<string, AppState> = {
  extracting: 'board',
  payload_gen: 'board',
}

/**
 * True when the board has nothing left in flight.
 *
 * Done is the only forward move the trail allows, and only from here: once
 * every card has settled, the run has produced its result and refusing to
 * show it strands the user on a board that will never change again.
 */
export function boardSettled(): boolean {
  const cards = Object.values((store.get('boardCards') as Record<string, { column?: string }>) ?? {})
  if (cards.length === 0) return false
  return !cards.some(c => c.column === 'todo' || c.column === 'extracted' || c.column === 'applying')
}

export function currentAppState(): AppState {
  const raw = String(store.get('appState') ?? 'auth')
  return LEGACY_STATES[raw] ?? (raw as AppState)
}

// ── Loop mode ────────────────────────────────────────────────────────────────
//
// While loop mode is on, nothing may start, cancel or reset a pipeline step,
// switch the profile, or clear what keeps a job from being applied to twice:
// the loop drives the pipeline unattended, and any of these would cut a round
// off or change what it reads mid-way. Refused, not queued -- stop it first.

const LOOP_ON = LOOP_ON_MESSAGE
let activeLoop: Loop | null = null
const loopIsOn = (): boolean => activeLoop?.isOn() === true

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lockedWhileLooping(channel: string, listener: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => (loopIsOn() ? { ok: false, error: LOOP_ON } : listener(e, ...args)))
}

export function registerLoopIpc(loop: Loop): void {
  activeLoop = loop
  ipcMain.handle('loop:get-status', () => loop.status())
  ipcMain.handle('loop:start', () => loop.start())
  ipcMain.handle('loop:stop', async (_e, opts?: { mode?: 'after-round' | 'now' }) => {
    if (opts?.mode === 'now') await loop.stopNow()
    else loop.stopAfterRound()
    return { ok: true }
  })
  ipcMain.handle('loop:save-settings', (_e, p?: Partial<LoopSettings>) => loop.updateSettings(p ?? {}))
}

export function registerIpcHandlers(): void {

  // ── Auth ──────────────────────────────────────────────────────────────────
  lockedWhileLooping('auth:login', async () => {
    await warmCodex()   // a first start off the main thread (binary-warmup.ts)
    const spec = getCodexSpawnSpec(['login'])

    return new Promise<{ success: boolean; message?: string }>((resolve) => {
      const child = spawn(spec.command, spec.args, {
        windowsHide: true,
        shell: spec.shell,
        env: buildSpawnEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let openedUrl = false

      const onText = (chunk: Buffer) => {
        const text = chunk.toString()
        const match = text.match(/https:\/\/auth\.openai\.com\/\S+/i)
        if (match && !openedUrl) {
          openedUrl = true
          void shell.openExternal(match[0]).catch(() => { /* best effort */ })
        }
      }

      child.stdout?.on('data', onText)
      child.stderr?.on('data', onText)

      child.on('close', (code: number | null) => {
        if (code !== 0) {
          resolve({ success: false, message: 'Login was cancelled or failed. Try again.' })
          return
        }
        // Exit 0 — probe to verify actual auth state
        const probeSpec = getCodexSpawnSpec(['login', 'status'])
        const probeChild = spawn(probeSpec.command, probeSpec.args, {
          windowsHide: true,
          shell: probeSpec.shell,
          env: buildSpawnEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let probeOutput = ''
        probeChild.stdout?.on('data', (c: Buffer) => { probeOutput += c.toString() })
        probeChild.stderr?.on('data', (c: Buffer) => { probeOutput += c.toString() })
        probeChild.on('close', (probeCode: number | null) => {
          const loggedOut = /not logged in|login required|unauthenticated|not authenticated/i.test(probeOutput)
          if (probeCode === 0 && !loggedOut) {
            setState('resume')
            resolve({ success: true })
          } else {
            resolve({ success: false, message: 'Authentication did not complete. Please try again.' })
          }
        })
        probeChild.on('error', () => {
          // Probe failed — assume success based on exit code 0
          setState('resume')
          resolve({ success: true })
        })
      })

      child.on('error', (err: Error) => {
        resolve({ success: false, message: `Could not start Codex: ${err.message}` })
      })
    })
  })

  lockedWhileLooping('auth:logout', async () => {
    // Match the goto-state→auth path: kill any running pipeline first so
    // Settings "Sign Out" doesn't leave child processes running.
    await cancelActivePipeline('logout')
    await clearCodexClient()
    setState('auth')
    // Run codex logout in background (best effort)
    try {
      const spec = getCodexSpawnSpec(['logout'])
      spawn(spec.command, spec.args, {
        windowsHide: true,
        shell: spec.shell,
        env: buildSpawnEnv(),
        stdio: 'ignore',
        detached: true,
      }).unref()
    } catch { /* best effort */ }
  })

  ipcMain.handle('auth:status', async () => {
    // E2E runs must never spawn codex — and the auto-advance this probe
    // triggers (auth → resume) would race seeded-state assertions.
    // codexLoginStatus answers false under E2E_TEST without spawning.
    // Unknown (codex would not run) shows as signed out, as it always has.
    const loggedIn = (await codexLoginStatus()) === true
    if (loggedIn) {
      // Auto-advance ONLY when currently on auth screen — otherwise this
      // probe (which AuthScreen fires on mount during the brief moment
      // before state:get rehydrates) would yank a user out of any other
      // resumed state (query_gen, rating, etc.).
      const currentState = currentAppState()
      if (!currentState || currentState === 'auth') {
        setState('resume')
      }
    }
    return { loggedIn }
  })

  // ── Resume ────────────────────────────────────────────────────────────────
  ipcMain.handle('resume:upload', async (_e, { filePath }: { filePath: string }) => {
    const buffer = await fs.readFile(filePath)
    let text: string
    if (filePath.toLowerCase().endsWith('.pdf')) {
      const parsed = await pdfParse(buffer)
      text = parsed.text
    } else if (filePath.toLowerCase().endsWith('.txt')) {
      text = buffer.toString('utf-8')
    } else {
      // DOCX and other binary formats: reject with a clear error
      throw new Error(`Unsupported file type. Please upload a PDF or TXT file. DOCX is not supported yet.`)
    }
    store.set('resumeText', text as never)
    store.set('resumePath', filePath as never)
    const filename = filePath.split(/[\\/]/).pop() ?? filePath
    return { text, filename }
  })

  // User profile (visa, location, EEO) — collected on resume screen
  ipcMain.handle('profile:save', (_e, p: {
    targetLocations: string; visaSituation: string; citizenship: string; sponsorshipNeed: string;
    clearance: string; salaryExpectation: string; searchInstructions: string;
    eeoGender: string; eeoRace: string; eeoVeteran: string; eeoDisability: string;
    generateCoverLetter: boolean;
  }) => {
    store.set('profileTargetLocations', p.targetLocations as never)
    store.set('profileVisaSituation', p.visaSituation as never)
    store.set('profileCitizenship', p.citizenship as never)
    store.set('profileSponsorshipNeed', p.sponsorshipNeed as never)
    store.set('profileClearance', p.clearance as never)
    store.set('profileSalaryExpectation', p.salaryExpectation as never)
    store.set('profileSearchInstructions', p.searchInstructions as never)
    store.set('profileEeoGender', p.eeoGender as never)
    store.set('profileEeoRace', p.eeoRace as never)
    store.set('profileEeoVeteran', p.eeoVeteran as never)
    store.set('profileEeoDisability', p.eeoDisability as never)
    store.set('profileGenerateCoverLetter', Boolean(p.generateCoverLetter) as never)
  })

  ipcMain.handle('profile:get', () => ({
    targetLocations:      (store.get('profileTargetLocations') as string) ?? '',
    visaSituation:        (store.get('profileVisaSituation') as string) ?? '',
    citizenship:          (store.get('profileCitizenship') as string) ?? '',
    sponsorshipNeed:      (store.get('profileSponsorshipNeed') as string) ?? '',
    clearance:            (store.get('profileClearance') as string) ?? '',
    salaryExpectation:    (store.get('profileSalaryExpectation') as string) ?? '',
    searchInstructions:   (store.get('profileSearchInstructions') as string) ?? '',
    eeoGender:            (store.get('profileEeoGender') as string) ?? '',
    eeoRace:              (store.get('profileEeoRace') as string) ?? '',
    eeoVeteran:           (store.get('profileEeoVeteran') as string) ?? '',
    eeoDisability:        (store.get('profileEeoDisability') as string) ?? '',
    generateCoverLetter:  (store.get('profileGenerateCoverLetter') as boolean) ?? false,
  }))

  // Open native file picker, return selected path (or null if cancelled)
  ipcMain.handle('resume:browse', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0], {
      title: 'Select Resume',
      filters: [
        { name: 'Resume', extensions: ['pdf', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ── Pipeline ──────────────────────────────────────────────────────────────
  // Step 1: generate queries one-at-a-time, stop + wait for user to click Continue
  lockedWhileLooping('pipeline:start-query-gen', async () => {
    if (isPipelineActive()) return { alreadyRunning: true }
    try {
      await runQueryGen()
      // State stays 'query_gen' — renderer shows Continue button
    } catch (e) {
      safeSendError(String(e))
      console.error('[pipeline:start-query-gen] error:', String(e))
    }
  })

  // Targeted "find more" ask from the Find Jobs screen — generates 1-3 extra
  // queries for the user's request and grows the candidate pool.
  lockedWhileLooping('pipeline:add-user-queries', async (_e, { prompt }: { prompt: string }) => {
    if (isPipelineActive()) return { alreadyRunning: true }
    const ask = (prompt ?? '').trim()
    if (!ask) return { ok: false }
    try {
      await runUserQueryGen(ask)
      return { ok: true }
    } catch (e) {
      safeSendError(String(e))
      console.error('[pipeline:add-user-queries] error:', String(e))
      return { ok: false }
    }
  })

  // Step 2: user clicked Evaluate — run rating
  lockedWhileLooping('pipeline:start-rating', async () => {
    if (isPipelineActive()) return { alreadyRunning: true }
    try {
      await runRating()
    } catch (e) {
      safeSendError(String(e))
      console.error('[pipeline:start-rating] error:', String(e))
    }
  })

  lockedWhileLooping('selection:confirm', (_e, { jobIds }: { jobIds: string[] }) => {
    store.set('selectedJobIds', jobIds as never)
    // Populate the board here, not when extraction starts, so To do is full
    // the moment the board opens rather than for the instant before the
    // first form is ready.
    seedBoard()
  })

  // Step: extract forms only — stays on extracting screen, user confirms before filling
  lockedWhileLooping('pipeline:start-extract', async () => {
    if (isPipelineActive()) return { alreadyRunning: true }
    try {
      // One call now runs extraction and the application agents together, so
      // a job that finishes extracting is applied to while others are still
      // being extracted. There is no confirm step between the two any more.
      await runBoard()
    } catch (e) {
      safeSendError(String(e))
      console.error('[pipeline:start-extract] error:', String(e))
    }
  })

  // Step: user confirmed — fill payloads + submit (summary+done emitted at end of runPayloadGen)
  lockedWhileLooping('pipeline:start-payload-gen', async () => {
    if (isPipelineActive()) return { alreadyRunning: true }
    try {
      await runPayloadGen()
    } catch (e) {
      safeSendError(String(e))
      console.error('[pipeline:start-payload-gen] error:', String(e))
    }
  })

  ipcMain.handle('shell:open', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle('done:get-summary', () => store.get('doneSummary') ?? [])

  ipcMain.handle('applied:get-ids', () => store.get('appliedJobIds') ?? [])

  // ── Fetch (job data refresh) ───────────────────────────────────────────────
  ipcMain.handle('fetch:check', () => {
    const lastFetchAt = (store.get('lastFetchAt') as string | undefined) ?? ''
    if (!lastFetchAt) return { needsFetch: true, ageMinutes: Infinity, lastFetchAt: '' }
    const ageMinutes = (Date.now() - Date.parse(lastFetchAt)) / 60_000
    return { needsFetch: ageMinutes > 120, ageMinutes: Math.round(ageMinutes), lastFetchAt }
  })

  lockedWhileLooping('fetch:start', () => {
    runFetch().catch(e => console.error('[fetch]', String(e)))
  })

  // Rehydrate — FetchScreen reads on mount (remount/reload mid-rebuild).
  ipcMain.handle('fetch:get-state', () => getFetchState())

  // Cancel a running rebuild, or dismiss a finished/idle fetch screen.
  // fetching is not in SCREEN_ORDER, so pipeline:goto-state can't serve it.
  lockedWhileLooping('fetch:cancel', async () => {
    if (isPipelineActive()) {
      await cancelActivePipeline('fetch-cancel')  // close handler routes to resume
      return { ok: true }
    }
    if (currentAppState() === 'fetching') setState('resume')
    return { ok: true }
  })

  // ── IMAP OTP Setup ──────────────────────────────────────────────────────────
  ipcMain.handle('imap:get-config', () => {
    const homeDir = store.get('jobAutomatorHome') as string
    const configPath = path.join(homeDir, 'secrets', 'imap_config.json')
    try {
      const raw = JSON.parse(require('fs').readFileSync(configPath, 'utf-8'))
      return {
        configured: true,
        host: raw.host,
        port: raw.port,
        username: raw.username,
      }
    } catch {
      return { configured: false }
    }
  })

  ipcMain.handle('imap:save-config', async (_e, cfg: {
    host: string; port: number; username: string; password: string
  }) => {
    const homeDir = store.get('jobAutomatorHome') as string
    const secretsDir = path.join(homeDir, 'secrets')
    await fs.mkdir(secretsDir, { recursive: true })
    const configPath = path.join(secretsDir, 'imap_config.json')
    await fs.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf-8')
    store.set('imapConfigured', true as never)
  })

  ipcMain.handle('imap:test-connection', (_e, cfg: {
    host: string; port: number; username: string; password: string
  }) => {
    const resPath: string =
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ??
      require('path').join(__dirname, '..', '..', 'resources')
    const platformTag =
      process.platform === 'win32' ? 'win-x64' : process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
    const bundledPython = process.platform === 'win32'
      ? require('path').join(resPath, 'python', platformTag, 'python.exe')
      : require('path').join(resPath, 'python', platformTag, 'bin', 'python3')
    // A packaged build's own Python, else this checkout's venv (python / python3 without one).
    const pythonExe = require('fs').existsSync(bundledPython) ? bundledPython : automatorPython()
    const pythonDir = store.get('pythonDir') as string

    const { spawnSync } = require('child_process')
    const result = spawnSync(pythonExe, [
      '-m', 'job_application_automator.imap_setup_check',
      '--host', cfg.host,
      '--port', String(cfg.port),
      '--user', cfg.username,
      '--password', cfg.password,
    ], {
      encoding: 'utf-8',
      stdio: 'pipe',
      shell: false,
      windowsHide: true,
      cwd: pythonDir,
      env: {
        ...process.env,
        JOB_AUTOMATOR_PYTHON_DIR: pythonDir,
        PYTHONDONTWRITEBYTECODE: '1',
      },
    })
    try {
      return JSON.parse(result.stdout.trim())
    } catch {
      return { ok: false, error: result.stderr?.slice(0, 200) || 'Unknown error' }
    }
  })

  lockedWhileLooping('pipeline:reset', async () => {
    await cancelActivePipeline('reset')
    setState('resume')
    store.set('candidates', [] as never)
    store.set('ratedJobs', [] as never)
    store.set('selectedJobIds', [] as never)
    store.set('queryList', [] as never)
    store.set('doneSummary', [] as never)
    store.set('queryGenResults', [] as never)
    store.set('extractResults', [] as never)
    store.set('queryGenInputHash', '' as never)
    store.set('ratingInputHash', '' as never)
    store.set('extractInputHash', '' as never)
    store.set('payloadInputHash', '' as never)
  })

  // ── Settings ──────────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', () => ({
    ratingAgents: store.get('ratingAgents'),
    payloadAgents: store.get('payloadAgents'),
    codexModel: store.get('codexModel'),
    jobscanExePath: store.get('jobscanExePath'),
    pythonDir: store.get('pythonDir'),
    jobAutomatorHome: store.get('jobAutomatorHome'),
    imapConfigured: store.get('imapConfigured'),
    resumePath: store.get('resumePath'),
    // codexToken removed — auth managed by Codex CLI
  }))

  ipcMain.handle('settings:save', async (_e, partial: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(partial)) {
      // Optional fields never set (e.g. resumePath on a fresh profile) arrive
      // as undefined; electron-store's set() throws on undefined, which made
      // the whole save reject and left the Settings panel stuck open.
      if (v === undefined) continue
      store.set(k as never, v as never)
    }
    // Note: previously called clearCodexClient() to handle API-key rotation.
    // Codex CLI now owns auth (no API-key field in settings), and killing the
    // client mid-run interrupts the in-flight pipeline. Removed.
    // A saved codexModel applies on the NEXT turn — runTurn reads the store
    // per call — so no client restart is needed for model switches either.
  })

  // Models for the Settings dropdown. Never throws — the renderer always gets
  // { models, error } and degrades to Auto + saved-value when the list is
  // unavailable (codex logged out, spawn failure, slow init).
  ipcMain.handle('codex:list-models', async () => {
    // E2E runs must never spawn codex; return the same shape as the error path.
    if (process.env['E2E_TEST'] === '1') return { models: [], error: 'model list disabled in e2e' }
    try {
      const p = listCodexModels()
      // If the timeout below wins the race, this promise keeps running and
      // warms the client cache for the next open — but its rejection must not
      // become an unhandledRejection.
      p.catch(() => { /* handled via race */ })
      const models = await Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('model list timed out')), 10_000)),
      ])
      // A saved model the API has since dropped fails EVERY turn with
      // `400 The '<id>' model is not supported`, which takes the whole pipeline
      // down. Reset to Auto rather than leave the app wedged.
      const cleared = reconcileSavedModel(models.map(m => m.id))
      return { models, error: null, ...(cleared ? { clearedModel: cleared } : {}) }
    } catch (e) {
      return { models: [], error: e instanceof Error ? e.message : String(e) }
    }
  })

  // Codex CLI version + auto-update. The renderer shows which binary is in use
  // and can force a check; the boot check is throttled to once a day.
  // "Finish it" on a blocked application. The tab was left open with every
  // answer already in it, so raising THAT tab is the whole point — opening the
  // apply URL again would hand the user a blank form.
  ipcMain.handle('chrome:focus-tab', async (_e, applyUrl: string) => {
    const result = await focusApplicationTab(String(applyUrl || ''))
    if (!result.focused && applyUrl) {
      // Better a blank form than a dead button.
      shell.openExternal(String(applyUrl)).catch(() => { /* nothing else to try */ })
    }
    return result
  })

  ipcMain.handle('codex:update-status', () => getUpdateStatus())

  lockedWhileLooping('codex:check-update', async () => {
    if (process.env['E2E_TEST'] === '1') return { state: 'skipped', message: 'disabled in e2e' }
    const status = await ensureLatestCodex({ force: true })
    if (status.state === 'updated') await clearCodexClient()   // next turn spawns the new binary
    return status
  })

  // ── State rehydration ─────────────────────────────────────────────────────
  ipcMain.handle('state:get', () => ({
    state: currentAppState(),
    hasResume: !!(store.get('resumeText')),
  }))

  // ── Back navigation ───────────────────────────────────────────────────────
  // Returns counts for trail-chip badges so the user sees what survives a back jump.
  ipcMain.handle('state:get-counts', () => ({
    // Lengths only: peek, never copy the pools (this runs on every state change).
    queryList:    (peek<unknown[]>('queryList') ?? []).length,
    candidates:   (peek<unknown[]>('candidates') ?? []).length,
    ratedJobs:    (peek<unknown[]>('ratedJobs') ?? []).length,
    selectedJobs: (peek<string[]>('selectedJobIds') ?? []).length,
    extractResults: (peek<unknown[]>('extractResults') ?? []).length,
    doneSummary:    (peek<unknown[]>('doneSummary') ?? []).length,
    // Lets the trail offer Done once the board has finished.
    boardSettled:   boardSettled(),
  }))

  // Per-stage rehydrate — screens read on mount when revisited via back-nav.
  ipcMain.handle('query_gen:get-state', () => ({
    cards:   store.get('queryGenResults') ?? [],
    queries: store.get('queryList') ?? [],
    done:    ((store.get('queryList') as unknown[]) ?? []).length > 0,
    total:   (peek<unknown[]>('candidates') ?? []).length,
  }))
  ipcMain.handle('rating:get-state', () => {
    // Jobs applied to are dropped here rather than badged in the list.
    // Coming back to Rating after a run, they are no longer choices -- an
    // applied job offered again is only an invitation to apply twice. Ratings
    // are NOT re-run: this filters the cached result on the way out, so
    // returning to this screen costs nothing.
    const spent = appliedKeys()
    const unapplied = <T extends { job_id?: string; platform?: string }>(list: T[]): T[] =>
      list.filter(j => !isApplied(spent, String(j.platform ?? ''), String(j.job_id ?? '')))

    // Attach path: while the background engine streams, show what's rated so
    // far — rating:progress/rating:done events carry the rest. progress makes
    // the header counters correct the moment the screen mounts.
    if (isRatingEngineActive()) {
      const streaming = unapplied(getRatingEngineSnapshot() as Array<{ job_id?: string; platform?: string }>)
      return { jobs: streaming, done: false, progress: getRatingEngineProgress() }
    }
    const all = (store.get('ratedJobs') as Array<{ job_id?: string; platform?: string }>) ?? []
    const jobs = unapplied(all)
    // The screen says how many it dropped: a list that silently shrinks
    // between visits reads as data loss.
    return { jobs, done: all.length > 0, hiddenApplied: all.length - jobs.length }
  })
  ipcMain.handle('extract:get-state', () => {
    const results = (store.get('extractResults') as Array<{ status: 'extracted' | 'failed' }>) ?? []
    const total = ((store.get('selectedJobIds') as string[]) ?? []).length
    const done = results.filter(r => r.status === 'extracted').length
    const failed = results.filter(r => r.status === 'failed').length
    return { jobs: results, done, failed, total, extractDone: results.length > 0 }
  })
  ipcMain.handle('payload:get-state', () => ({
    completed: store.get('doneSummary') ?? [],
  }))

  // Goto-state: cancel any active pipeline, optionally require confirm, then setState.
  // Allowed targets: any state at or before current. Auth target also clears codex client.
  lockedWhileLooping('pipeline:goto-state', async (_e, { target, confirmed }: { target: AppState; confirmed?: boolean }) => {
    const current = currentAppState()
    const currentIdx = SCREEN_ORDER.indexOf(current)
    const targetIdx  = SCREEN_ORDER.indexOf(target)
    if (targetIdx === -1 || currentIdx === -1) {
      return { ok: false, error: 'invalid state' }
    }
    // Backwards is always allowed. The one forward move is board -> done, and
    // only once every card has settled: the run is over, its result exists,
    // and without this the user is stranded on a board that will never change
    // again -- the pipeline that would have called setState('done') has
    // already finished.
    const returningToDone = target === 'done' && current === 'board' && boardSettled()
    if (targetIdx >= currentIdx && !returningToDone) {
      return { ok: false, error: 'target must be earlier than current' }
    }

    // Destructive states need explicit confirm
    // Only destructive while work is actually in flight. Warning about
    // abandoning Chrome sessions when the run has finished is a false alarm
    // the user has to dismiss every time.
    if (DESTRUCTIVE_FROM.has(current) && isPipelineActive() && !confirmed) {
      return {
        ok: false, needsConfirm: true,
        reason: 'Applications are in progress. Going back will stop extraction and '
          + 'abandon Chrome sessions for any jobs still being filled. Continue?',
      }
    }

    // Auth target: logout flow (kill codex + launch logout cli in background)
    if (target === 'auth') {
      await cancelActivePipeline('goto:auth')
      await clearCodexClient()
      try {
        const spec = getCodexSpawnSpec(['logout'])
        spawn(spec.command, spec.args, {
          windowsHide: true, shell: spec.shell, env: buildSpawnEnv(),
          stdio: 'ignore', detached: true,
        }).unref()
      } catch { /* best effort */ }
      setState('auth')
      return { ok: true }
    }

    await cancelActivePipeline('goto:' + target)
    setState(target)
    return { ok: true }
  })

  // ── Local profiles (personas) ─────────────────────────────────────────────
  ipcMain.handle('profiles:list', () => listProfiles())
  lockedWhileLooping('profiles:create', (_e, { name }: { name: string }) => createProfile(name))
  lockedWhileLooping('profiles:switch', async (_e, { id }: { id: string }) => switchProfile(id))
  ipcMain.handle('profiles:rename', (_e, { id, name }: { id: string; name: string }) => renameProfile(id, name))
  lockedWhileLooping('profiles:delete', (_e, { id }: { id: string }) => deleteProfile(id))

  // Applied jobs log (for AppliedJobsPanel)
  ipcMain.handle('board:get-state', () => store.get('boardCards') ?? {})

  ipcMain.handle('applied-jobs:get-log', () => store.get('appliedJobsLog') ?? [])

  // Read a per-application Q&A record (.md). Path comes from the renderer, so
  // it MUST resolve inside {home}/application-records — arbitrary-read guard.
  ipcMain.handle('applied-jobs:get-details', async (_e, { path: recordPath }: { path: string }) => {
    try {
      const home = store.get('jobAutomatorHome') as string
      const recordsRoot = path.resolve(home, 'application-records')
      const resolved = path.resolve(String(recordPath ?? ''))
      if (resolved !== recordsRoot && !resolved.startsWith(recordsRoot + path.sep)) {
        return { ok: false, error: 'invalid path' }
      }
      const content = await fs.readFile(resolved, 'utf-8')
      return { ok: true, content }
    } catch {
      return { ok: false, error: 'Record file not found.' }
    }
  })
  // Open a file referenced by an application record (resume, cover letter).
  // The path comes from the renderer, so it is allowed ONLY when it resolves
  // inside the job-automator home or is exactly the configured resume -- the
  // same arbitrary-path guard applied-jobs:get-details uses.
  ipcMain.handle('applied-jobs:open-file', async (_e, { path: filePath }: { path: string }) => {
    try {
      const home = (store.get('jobAutomatorHome') as string) ?? ''
      const resumePath = (store.get('resumePath') as string) ?? ''
      const resolved = path.resolve(String(filePath ?? ''))
      if (!isOpenableRecordFile(home, resumePath, resolved)) {
        return { ok: false, error: 'invalid path' }
      }
      await fs.access(resolved)
      // openPath returns a non-empty string on failure.
      const err = await shell.openPath(resolved)
      return err ? { ok: false, error: err } : { ok: true }
    } catch {
      return { ok: false, error: 'File not found.' }
    }
  })
  lockedWhileLooping('applied-jobs:clear', () => {
    store.set('appliedJobsLog', [] as never)
    return { ok: true }
  })
}
