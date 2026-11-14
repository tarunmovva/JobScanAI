import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { Asterisk, ChevronDown, Settings as SettingsIcon } from 'lucide-react'
import { ipc, LOOP_REFUSED_EVENT } from './ipc'
import { profileDotColor } from './profileColor'
import type { AppState, LoopStatus, ProfileInfo } from './types'
import LoopChip from './components/LoopChip'
import LoopPanel from './components/LoopPanel'
import { LOOP_ON_MESSAGE } from '../electron/loop-copy'
import AuthScreen from './screens/AuthScreen'
import ResumeScreen from './screens/ResumeScreen'
import QueryGenScreen from './screens/QueryGenScreen'
import RatingScreen from './screens/RatingScreen'
import BoardScreen from './screens/BoardScreen'
import FetchScreen from './screens/FetchScreen'
import DoneScreen from './screens/DoneScreen'
import SettingsPanel from './components/SettingsPanel'
import ConfirmDialog from './components/ConfirmDialog'
import AmbientField, { type AmbientMode } from './components/AmbientField'

const SCREEN_NAMES: AppState[] = [
  'auth', 'resume', 'query_gen', 'rating',
  'board', 'done'
]

const STEP_LABELS: Record<AppState, string> = {
  auth: 'Login', resume: 'Resume', fetching: 'Fetch', query_gen: 'Find Jobs',
  rating: 'Rating', board: 'Applications', done: 'Done',
}

interface StageCounts {
  queryList: number
  candidates: number
  ratedJobs: number
  selectedJobs: number
  extractResults: number
  doneSummary: number
  boardSettled: boolean
}

interface GotoResult { ok: boolean; needsConfirm?: boolean; reason?: string }

function countFor(state: AppState, counts: StageCounts | null): number {
  if (!counts) return 0
  if (state === 'query_gen')   return counts.candidates   // merged step — chip shows the pool size
  if (state === 'rating')      return counts.ratedJobs
  if (state === 'board') return counts.selectedJobs
  return 0
}

// Trail shows pipeline steps only — 'auth' is not a step; logging out lives
// in Settings ("Sign Out"), so a clickable Login chip would just be a
// no-confirm logout trap.
const TRAIL_NAMES: AppState[] = SCREEN_NAMES.filter(s => s !== 'auth')

function StateTrail({ current, counts, onGo, locked = false }: {
  current: AppState
  counts: StageCounts | null
  onGo: (target: AppState) => void
  /** Loop mode drives the screens; nothing in the trail can be clicked. */
  locked?: boolean
}) {
  // 'fetching' has no trail slot — highlight Resume (its entry point) while
  // the rebuild runs, and freeze click-through (goto-state would reject it).
  const idx = TRAIL_NAMES.indexOf(current === 'fetching' ? 'resume' : current)
  return (
    <div
      className="flex items-center gap-1 text-xs flex-wrap min-w-0 justify-end"
      title={locked ? LOOP_ON_MESSAGE : undefined}
    >
      {TRAIL_NAMES.map((s, i) => {
        // Done is reachable forward from a settled board -- the run is over
        // and its result is sitting there unreachable otherwise.
        const canReturnToDone = s === 'done' && current === 'board' && !!counts?.boardSettled
        const clickable = !locked && (i < idx || canReturnToDone) && current !== 'fetching'
        const count = countFor(s, counts)
        const base = 'px-2 py-0.5 rounded-full transition-colors'
        const className = clickable
          ? `${base} text-orange-300 hover:text-white hover:bg-white/[0.08] cursor-pointer`
          : i === idx
            ? `${base} text-orange-400 font-bold bg-orange-900/30`
            : `${base} text-gray-600`

        const label = count > 0 && (clickable || i === idx)
          ? `${STEP_LABELS[s]} (${count})`
          : STEP_LABELS[s]

        const sep = i > 0 && (
          <span className="text-gray-700 select-none text-[10px]">›</span>
        )

        if (clickable) {
          return (
            <span key={s} className="flex items-center gap-1">
              {sep}
              <button onClick={() => onGo(s)} className={className} title={`Go back to ${STEP_LABELS[s]} — previous results are preserved`}>
                {label}
              </button>
            </span>
          )
        }
        return (
          <span key={s} className="flex items-center gap-1">
            {sep}
            <span className={className} aria-current={i === idx ? 'step' : undefined}>{label}</span>
          </span>
        )
      })}
    </div>
  )
}

const SCREENS: Record<AppState, React.ComponentType> = {
  auth: AuthScreen, resume: ResumeScreen, fetching: FetchScreen, query_gen: QueryGenScreen,
  rating: RatingScreen,
  // One board covers everything from selection to done. Extraction, answering
  // and filling are columns on it, not screens, because they overlap.
  board: BoardScreen,
  done: DoneScreen,
}

export default function App() {
  const [state, setState] = useState<AppState>('auth')
  const [showSettings, setShowSettings] = useState(false)
  const [pipelineError, setPipelineError] = useState<string | null>(null)
  const [cancelToast, setCancelToast] = useState<string | null>(null)
  const [counts, setCounts] = useState<StageCounts | null>(null)
  const [confirmGoto, setConfirmGoto] = useState<{ target: AppState; reason: string } | null>(null)
  const [profiles, setProfiles] = useState<ProfileInfo[]>([])
  const [activeProfileId, setActiveProfileId] = useState('')
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [profileMenuPos, setProfileMenuPos] = useState({ top: 0, left: 0 })
  const [profileToast, setProfileToast] = useState<string | null>(null)
  const [thinking, setThinking] = useState(false)
  const [ambientPulse, setAmbientPulse] = useState(0)
  const [loopStatus, setLoopStatus] = useState<LoopStatus | null>(null)
  const [showLoop, setShowLoop] = useState(false)
  const [loopToast, setLoopToast] = useState<string | null>(null)
  const profileChipRef = useRef<HTMLButtonElement>(null)
  // While the loop is on it drives the screens; manual navigation is locked.
  const loopOn = !!loopStatus && ['running', 'stopping', 'waiting'].includes(loopStatus.phase)

  // The header is overflow-hidden (wide-header layout fix), so the menu is
  // rendered position:fixed from the chip's measured rect to escape the clip.
  const toggleProfileMenu = (): void => {
    const rect = profileChipRef.current?.getBoundingClientRect()
    if (rect) setProfileMenuPos({ top: rect.bottom + 6, left: rect.left })
    setProfileMenuOpen(v => !v)
  }

  const refreshCounts = (): void => {
    ipc.invoke<StageCounts>('state:get-counts').then(setCounts).catch(() => { /* ignore */ })
  }

  const refreshProfiles = (): void => {
    ipc.invoke<{ profiles: ProfileInfo[]; activeId: string }>('profiles:list').then(r => {
      setProfiles(r?.profiles ?? [])
      setActiveProfileId(r?.activeId ?? '')
    }).catch(() => { /* ignore */ })
  }

  const showProfileToast = (msg: string): void => {
    setProfileToast(msg)
    setTimeout(() => setProfileToast(null), 3000)
  }

  const switchProfileTo = async (p: ProfileInfo): Promise<void> => {
    setProfileMenuOpen(false)
    if (p.id === activeProfileId) return
    const r = await ipc.invoke<{ ok: boolean; error?: string }>('profiles:switch', { id: p.id })
    if (r?.ok) {
      setShowSettings(false)
      refreshProfiles()
      showProfileToast(`Switched to "${p.name}"`)
    } else {
      showProfileToast(r?.error ?? 'Could not switch profiles.')
    }
  }

  useEffect(() => {
    ipc.invoke<{ state: AppState }>('state:get').then(r => { if (r?.state) setState(r.state) })
    refreshCounts()
    refreshProfiles()

    const handler = (data: unknown) => {
      const p = data as { state: AppState }
      if (p?.state) {
        setState(p.state)
        refreshCounts()
        if (p.state === 'done') setAmbientPulse(x => x + 1)
      }
    }
    ipc.on('state:change', handler)

    const errHandler = (data: unknown) => {
      const { message } = data as { message: string }
      setPipelineError(message)
      setTimeout(() => setPipelineError(null), 8000)
    }
    ipc.on('pipeline:error', errHandler)

    const cancelHandler = (data: unknown) => {
      const { reason } = (data ?? {}) as { reason?: string }
      setCancelToast(reason ? `Pipeline canceled (${reason})` : 'Pipeline canceled')
      setTimeout(() => setCancelToast(null), 3000)
    }
    ipc.on('pipeline:canceled', cancelHandler)

    const idleHandler = () => { refreshCounts(); setThinking(false) }
    ipc.on('pipeline:idle', idleHandler)

    // Ambient-layer signals (listen-only — no behavior): AI activity tints
    // the background field purple; completions fire a brief pulse.
    const thinkHandler = () => setThinking(true)
    ipc.on('queryGen:generating', thinkHandler)
    ipc.on('rating:progress', thinkHandler)
    ipc.on('payload:progress', thinkHandler)
    const pulseHandler = () => { setThinking(false); setAmbientPulse(p => p + 1) }
    ipc.on('rating:done', pulseHandler)

    ipc.invoke<LoopStatus>('loop:get-status').then(s => { if (s) setLoopStatus(s) }).catch(() => { /* ignore */ })
    const loopHandler = (data: unknown) => { if (data) setLoopStatus(data as LoopStatus) }
    ipc.on('loop:status', loopHandler)
    let loopToastTimer: ReturnType<typeof setTimeout> | null = null
    const refusedHandler = () => {
      setLoopToast(LOOP_ON_MESSAGE)
      if (loopToastTimer) clearTimeout(loopToastTimer)
      loopToastTimer = setTimeout(() => setLoopToast(null), 3000)
    }
    window.addEventListener(LOOP_REFUSED_EVENT, refusedHandler)

    return () => {
      ipc.off('loop:status', loopHandler)
      window.removeEventListener(LOOP_REFUSED_EVENT, refusedHandler)
      if (loopToastTimer) clearTimeout(loopToastTimer)
      ipc.off('state:change', handler)
      ipc.off('pipeline:error', errHandler)
      ipc.off('pipeline:canceled', cancelHandler)
      ipc.off('pipeline:idle', idleHandler)
      ipc.off('queryGen:generating', thinkHandler)
      ipc.off('rating:progress', thinkHandler)
      ipc.off('payload:progress', thinkHandler)
      ipc.off('rating:done', pulseHandler)
    }
  }, [])

  const goTo = async (target: AppState, confirmed = false): Promise<void> => {
    const r = await ipc.invoke<GotoResult>('pipeline:goto-state', { target, confirmed })
    if (r?.needsConfirm) setConfirmGoto({ target, reason: r.reason ?? 'Continue?' })
  }

  // Esc closes the profile menu (outside clicks handled by the backdrop div)
  useEffect(() => {
    if (!profileMenuOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setProfileMenuOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [profileMenuOpen])

  const activeProfile = profiles.find(p => p.id === activeProfileId)

  const ambientMode: AmbientMode =
    state === 'auth' ? 'auth' :
    state === 'fetching' ? 'fetching' :
    thinking ? 'thinking' : 'idle'

  const Screen = SCREENS[state]
  const currentIdx = SCREEN_NAMES.indexOf(state)
  // Back only exists past Resume — one step at a time. Logout lives in
  // Settings ("Sign Out"), not behind a back button. 'fetching' (idx -1),
  // 'auth' (0) and 'resume' (1) all render without a back button.
  const showBack = currentIdx > 1 && !loopOn
  const backTarget: AppState = SCREEN_NAMES[Math.max(0, currentIdx - 1)]

  return (
    <MotionConfig reducedMotion="user">
    <div className="h-screen w-screen overflow-hidden bg-transparent text-gray-100 flex flex-col">
      <AmbientField mode={ambientMode} pulse={ambientPulse} />
      <header className="relative z-10 border-b border-white/[0.06] px-6 py-3 flex items-center justify-between shrink-0 bg-gray-950/95 backdrop-blur-sm gap-3 min-w-0 overflow-hidden">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 font-display font-semibold text-lg text-white">
            <Asterisk size={18} strokeWidth={2.5} className="text-orange-500" aria-hidden />
            JobScan AI
          </span>
          {state !== 'auth' && activeProfile && (
            <button
              ref={profileChipRef}
              onClick={toggleProfileMenu}
              disabled={loopOn}
              title={loopOn ? LOOP_ON_MESSAGE : 'Switch profile'}
              className="flex items-center gap-1.5 bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] focus:border-orange-500 focus:outline-none rounded-full px-2.5 py-1 text-xs text-gray-300 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white/[0.06]"
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: profileDotColor(activeProfile.id) }} />
              <span className="max-w-[140px] truncate">{activeProfile.name}</span>
              <ChevronDown size={12} className="text-gray-600" />
            </button>
          )}
          {showBack && (
            <button
              onClick={() => goTo(backTarget)}
              className="text-gray-400 hover:text-white px-2.5 py-1 rounded-full text-xs bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] transition-colors"
              title={`Go back to ${STEP_LABELS[backTarget]}`}
            >
              ← Back
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {state !== 'auth' && <StateTrail current={state} counts={counts} onGo={goTo} locked={loopOn} />}
          {state !== 'auth' && <LoopChip status={loopStatus} onOpen={() => setShowLoop(true)} />}
          <button
            onClick={() => setShowSettings(true)}
            className="text-gray-500 hover:text-gray-300 transition-colors"
            title="Settings"
            aria-label="Open settings"
          >
            <SettingsIcon size={18} />
          </button>
        </div>
      </header>
      <main className="relative z-10 flex-1 overflow-auto min-w-0 max-w-full">
        {/* key includes profile id: screens load their data into local state
            on mount only — a profile switch while staying on the same screen
            (e.g. Resume) must remount it, or the previous profile's data
            stays painted and can even be saved into the new profile. */}
        <AnimatePresence mode="wait">
          <motion.div
            key={`${state}:${activeProfileId}`}
            className="h-full"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
          >
            <Screen />
          </motion.div>
        </AnimatePresence>
      </main>
      {/* Profile menu lives OUTSIDE the header: the header's backdrop-filter
          makes it the containing block even for fixed descendants, and its
          overflow-hidden would clip the dropdown. */}
      {profileMenuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setProfileMenuOpen(false)} />
          <motion.div
            style={{ top: profileMenuPos.top, left: profileMenuPos.left }}
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            className="fixed min-w-[220px] bg-[rgba(38,38,36,0.98)] border border-white/[0.08] rounded-2xl shadow-xl z-50 py-1.5"
          >
            {profiles.map(p => (
              <button
                key={p.id}
                onClick={() => void switchProfileTo(p)}
                disabled={p.id === activeProfileId}
                className={[
                  'w-full flex items-center gap-2 px-3 py-2 text-xs text-left',
                  p.id === activeProfileId
                    ? 'text-white cursor-default'
                    : 'text-gray-300 hover:bg-white/[0.06] hover:text-white',
                ].join(' ')}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: profileDotColor(p.id) }} />
                <span className="flex-1 truncate">{p.name}</span>
                {p.id === activeProfileId && <span className="text-orange-400">✓</span>}
              </button>
            ))}
            <div className="border-t border-white/[0.06] mt-1 pt-1">
              <button
                onClick={() => { setProfileMenuOpen(false); setShowSettings(true) }}
                className="w-full px-3 py-2 text-xs text-left text-gray-500 hover:bg-white/[0.06] hover:text-gray-300"
              >
                Manage profiles…
              </button>
            </div>
          </motion.div>
        </>
      )}
      {showSettings && <SettingsPanel onClose={() => { setShowSettings(false); refreshProfiles() }} />}
      {showLoop && <LoopPanel status={loopStatus} onClose={() => setShowLoop(false)} />}
      {loopToast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-gray-800 border border-sky-500/40 rounded-xl px-4 py-2.5 text-sm text-sky-100 z-50" role="status">
          {loopToast}
        </div>
      )}
      {pipelineError && (
        <div className="fixed bottom-4 right-4 bg-red-900 border border-red-700 rounded-xl px-4 py-3 text-sm text-red-200 max-w-md z-50">
          ⚠ {pipelineError}
        </div>
      )}
      {cancelToast && (
        <div className="fixed bottom-4 left-4 bg-gray-800 border border-white/[0.12] rounded-xl px-4 py-2.5 text-sm text-gray-300 z-50">
          {cancelToast}
        </div>
      )}
      {profileToast && (
        <div className="fixed bottom-4 left-4 bg-gray-800 border border-white/[0.12] rounded-xl px-4 py-2.5 text-sm text-gray-300 z-50">
          {profileToast}
        </div>
      )}
      {confirmGoto && (
        <ConfirmDialog
          message={confirmGoto.reason}
          confirmLabel="Go back anyway"
          cancelLabel="Stay here"
          onConfirm={() => { const t = confirmGoto.target; setConfirmGoto(null); void goTo(t, true) }}
          onCancel={() => setConfirmGoto(null)}
        />
      )}
    </div>
    </MotionConfig>
  )
}
