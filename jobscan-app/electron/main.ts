import { app, BrowserWindow, dialog } from 'electron'
// First: it may move userData, and the store is created when imported below.
import './user-data-dir'
import path from 'path'
import fs from 'fs'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { monitorEventLoopDelay } from 'perf_hooks'
import { registerIpcHandlers, registerLoopIpc } from './ipc-handlers'
import { discardInterruptedRun, cancelActivePipeline, ratingEngineCancel } from './pipeline'
import { setPipelineWindow, setState, isPipelineActive } from './pipeline'
import { createLoop, type Loop } from './loop-runner'
import { createLoopDeps } from './loop-deps'
import type { LoopState } from '../src/types'
import { setBusyCheck, scheduleCodexUpdateCheck } from './codex-updater'
import { clearCodexClient, checkAuth } from './codex-client'
import { ensureProfiles, syncActiveSnapshot } from './profiles'
import store from './state-store'
import { createQuitGuard } from './quit-guard'
import { resolvePython } from './app-paths'
import { codexHome } from './codex-home'
import { registerEngines, aiEngine, selectedEngineId } from './ai-engine'
import { createCodexEngine } from './ai-engine-codex'
import { createClaudeEngineForApp, disposeClaudeWorkDir } from './ai-engine-claude'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The AI engines, registered before anything can make an AI call. The
// machine-wide `aiEngine` setting picks one; Codex is the default.
registerEngines({ codex: createCodexEngine(), claude: createClaudeEngineForApp() }, () => store.get('aiEngine'))

// ── Codex logs DB maintenance ────────────────────────────────────────────────
//
// Runs on every app boot, before any codex.exe spawn.
//
// Layer 1: set PRAGMA journal_size_limit so SQLite never grows the WAL past
//   64 MB once we get a connection to it. (Per-connection setting; primarily
//   ensures our own maintenance doesn't bloat anything.)
// Layer 2: wal_checkpoint(TRUNCATE) clears any WAL left over from a prior
//   crash, SIGKILL, or power loss — the scenarios where the graceful shutdown
//   patch (Layer 3) didn't get to run.
//
// Fast-path: if WAL is already huge (> 200 MB) checkpoint would take minutes
// because SQLite must merge every WAL page into the main DB first. Codex's
// main DB is durable on its own; unflushed log entries are not worth waiting
// minutes for. Discard the WAL+SHM directly in that case — same approach as
// the manual cleanup that fixed the original bloat.
function truncateCodexWal(): void {
  // Tests never touch a Codex log folder, not even a scratch one.
  if (process.env['E2E_TEST'] === '1') return
  const dbDir = codexHome()
  const dbPath = path.join(dbDir, 'logs_2.sqlite')
  const walPath = path.join(dbDir, 'logs_2.sqlite-wal')
  const shmPath = path.join(dbDir, 'logs_2.sqlite-shm')
  if (!fs.existsSync(dbPath)) return

  try {
    const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
    if (walSize > 200 * 1024 * 1024) {
      console.warn(`[codex-wal] WAL ${(walSize / 1024 / 1024).toFixed(0)} MB on boot — discarding orphan WAL+SHM`)
      try { fs.rmSync(walPath, { force: true }) } catch { /* may be locked */ }
      try { fs.rmSync(shmPath, { force: true }) } catch { /* may be locked */ }
      return
    }
  } catch (e) {
    console.warn('[codex-wal] size check failed:', String(e).slice(0, 80))
  }

  // Small/missing WAL → quick checkpoint via Python sqlite3 (bundled in prod,
  // system in dev — same resolver as imap:test-connection in ipc-handlers).
  const resPath: string =
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ??
    path.join(__dirname, '..', '..', 'resources')
  const platformTag =
    process.platform === 'win32' ? 'win-x64' : process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  const bundledPython = process.platform === 'win32'
    ? path.join(resPath, 'python', platformTag, 'python.exe')
    : path.join(resPath, 'python', platformTag, 'bin', 'python3')
  const pythonExe = fs.existsSync(bundledPython)
    ? bundledPython
    : resolvePython(process.platform, String(store.get('pythonDir') ?? ''), fs.existsSync)

  const script =
    `import sqlite3; ` +
    `db=sqlite3.connect(r'${dbPath}', timeout=5); ` +
    `db.execute('PRAGMA journal_size_limit = 67108864'); ` +
    `db.execute('PRAGMA wal_checkpoint(TRUNCATE)'); ` +
    `db.close()`

  try {
    const r = spawnSync(pythonExe, ['-c', script], {
      stdio: 'ignore', shell: false, windowsHide: true, timeout: 15_000,
    })
    if (r.status !== 0) {
      console.warn('[codex-wal] checkpoint exit', r.status, r.error?.message ?? '')
    }
  } catch (e) {
    console.warn('[codex-wal] checkpoint failed:', String(e).slice(0, 120))
  }
}

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  setPipelineWindow(win)

  // Windows/Linux: closing the window quits the app, and the window is gone
  // before before-quit could ask. (macOS keeps running with no window, and
  // asks on Cmd+Q in before-quit.)
  if (process.platform !== 'darwin') {
    win.on('close', (e) => {
      if (quitGuard.confirmed || !isPipelineActive() || loop?.isOn() === true) return
      e.preventDefault()
      void quitGuard.mayQuit().then(ok => { if (ok) app.quit() })
    })
  }

  // electron-vite 2 sets ELECTRON_RENDERER_URL; without it, the fallback
  // below assumed port 5173, which is wrong whenever that port is taken.
  const devUrl = process.env['ELECTRON_RENDERER_URL'] ?? process.env['VITE_DEV_SERVER_URL']
  // E2E_TEST=1 (set by Playwright harness) forces the built renderer
  // so the spec doesn't depend on a running dev server.
  const e2e = process.env['E2E_TEST'] === '1'
  if (devUrl && !e2e) {
    win.loadURL(devUrl)
    win.webContents.openDevTools()
  } else if (!app.isPackaged && !e2e) {
    // Fallback for electron-vite dev when env var not injected
    win.loadURL('http://localhost:5173/')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// Keys from removed features (Auto-Apply scheduler, standalone search step);
// scrubbed so old configs stay clean (delete of a missing key is a no-op).
const REMOVED_KEYS = [
  'automationEnabled', 'automationPaused', 'automationRunIntervalMin',
  'automationFetchIntervalMin', 'automationMinRating', 'automationMaxPerRun',
  'automationAutoPauseFailures', 'automationConsecutiveFailures',
  'automationLastRunAt', 'automationNextRunAt', 'automationLastRunResult',
  'automationHistory',
  'searchResults', 'searchInputHash',
] as const

// The window cannot draw a frame while the main process is blocked, so a
// long block is a visible freeze. Say so in the log -- one line per 10 s
// that had one -- instead of leaving it to be guessed from a stuck screen.
const MAIN_STALL_LOG_MS = 250
function watchMainProcessStalls(): void {
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  setInterval(() => {
    const maxMs = delay.max / 1e6
    if (maxMs >= MAIN_STALL_LOG_MS) {
      console.warn(`[main] blocked up to ${Math.round(maxMs)} ms in the last 10 s (p99 ${Math.round(delay.percentile(99) / 1e6)} ms)`)
    }
    delay.reset()
  }, 10_000).unref()
}

app.whenReady().then(() => {
  watchMainProcessStalls()
  // Claude Code answers the AI calls: nothing of Codex's runs or is touched.
  const claudeMode = selectedEngineId() === 'claude'
  if (!claudeMode) truncateCodexWal()  // crash-recovery safety net before any codex.exe spawn
  // A run interrupted by the app closing does not carry into this one.
  // Runs before the window so the renderer never renders the stale board.
  try {
    discardInterruptedRun()
  } catch (e) {
    console.error('[startup] discarding the interrupted run failed:', e)
  }
  registerIpcHandlers()
  // Crash-safe boot normalization — MUST precede createWindow so the
  // renderer's first state:get sees final values.
  // Every launch lands on Resume (Auth if logged out); the last session's
  // screen is never restored. Stage data (candidates, ratings, hashes) is
  // kept, so walking forward again re-emits cached results instantly.
  setState(claudeMode || checkAuth() ? 'resume' : 'auth')
  for (const key of REMOVED_KEYS) store.delete(key as never)
  ensureProfiles() // migrate first launch to a "Default" profile + crash-heal snapshot
  // Loop mode is always off at launch. A round still marked active means the
  // app went down mid-round without the quit handler (a crash): say so. The
  // jobs it left in flight are excluded when the loop next starts.
  try {
    const ls = store.get('loopState') as LoopState | undefined
    if (ls?.active) {
      store.set('loopState', { ...ls, lastStopReason: `The app was closed during round ${ls.active.round}`, active: null })
    }
  } catch (e) {
    console.error('[startup] loop state check failed:', e)
  }
  loop = createLoop(createLoopDeps(() => win))
  registerLoopIpc(loop)
  createWindow()
  if (claudeMode) {
    // Claude Code's sign-in is checked by running it, so not before the
    // window: a launch never waits on it. Signed out, the sign-in screen
    // explains what to do -- unless the user has already moved on.
    void aiEngine().ready().then(ok => {
      if (!ok && store.get('appState') === 'resume') setState('auth')
    }).catch(() => { /* stays on Resume; AI steps report the problem */ })
    return
  }
  // Keep the Codex CLI current. Deferred and non-blocking: a bundled binary
  // ages out of being able to read the model list, but a slow or failed
  // registry check must never delay the window or break a launch.
  setBusyCheck(isPipelineActive)
  scheduleCodexUpdateCheck()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let loop: Loop | null = null

// A manual run in progress asks before the app quits (quit-guard.ts).
const quitGuard = createQuitGuard({
  runActive: () => isPipelineActive(),
  looping: () => loop?.isOn() === true,
  ask: async () => {
    const options = {
      type: 'warning' as const,
      buttons: ['Stop the run and quit', 'Keep the app open'],
      defaultId: 1,
      cancelId: 1,
      message: 'A run is still in progress.',
      detail: 'Quitting now stops it. Applications that were not submitted yet are not sent, '
        + 'and a form being filled right now is left where it is in Chrome.',
    }
    const parent = win && !win.isDestroyed() ? win : null
    const r = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    return r.response === 0 ? 'stop' : 'stay'
  },
})

let shutdownStarted = false
// macOS/Linux: jobscan's children lead their own process group (proc.ts), so
// a Ctrl+C or a closed terminal no longer reaches them on its own -- and a
// filler left running could still submit, with no app to record it. Stop
// the run's processes, then quit as usual.
if (process.platform !== 'win32') {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => {
      console.warn(`[main] ${sig}: stopping the run's processes`)
      quitGuard.skipAsking()   // a terminal Ctrl+C quits; nobody is there to answer
      void cancelActivePipeline(`signal:${sig}`).catch(() => {}).finally(() => app.quit())
    })
  }
}

app.on('before-quit', (event) => {
  // A second quit while cleanup runs (another click on the close button, a
  // second Cmd+Q) waits for it: the fillers are stopped already, but Codex
  // and a fetch get their chance to finish cleanly.
  if (shutdownStarted) { event.preventDefault(); return }
  // A manual run in progress: ask first. "Keep the app open" leaves it all
  // as it was; "Stop the run and quit" comes back here, confirmed.
  if (!quitGuard.confirmed && isPipelineActive() && loop?.isOn() !== true) {
    event.preventDefault()
    void quitGuard.mayQuit().then(ok => { if (ok) app.quit() })
    return
  }
  event.preventDefault()
  shutdownStarted = true

  // Quitting stops the loop. Recorded first, so the snapshot below keeps it.
  const looping = loop?.isOn() === true
  try { loop?.markClosedByQuit() } catch { /* best effort */ }

  // Capture the active profile's latest flat-key values (boot re-syncs too,
  // so crashes are covered — this just keeps snapshots fresh on clean exits).
  try { syncActiveSnapshot() } catch { /* best effort */ }

  ;(async () => {
    // A run's fillers must not outlive the app: nobody would see what they
    // submit. A loop round's jobs stay in flight and are excluded at next
    // start; a manual run was confirmed above.
    if (looping || isPipelineActive()) {
      try { await cancelActivePipeline('quit') } catch { /* best effort */ }
    }
    if (selectedEngineId() === 'claude') {
      // The detached rating engine is not under the run's token: stop it
      // first (so a batch that settles now saves nothing), then end every
      // Claude Code process -- none may outlive the app.
      try { ratingEngineCancel() } catch { /* best effort */ }
      try { await aiEngine().cancelAll('quit') } catch { /* best effort */ }
      disposeClaudeWorkDir()
    }
    // Graceful codex shutdown so SQLite checkpoints WAL — prevents unbounded WAL growth
    // that causes "Codex RPC timeout: initialize" after many sessions.
    try { await clearCodexClient() } catch { /* best effort */ }
    app.exit(0)
  })()
})
