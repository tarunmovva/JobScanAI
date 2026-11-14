import { useEffect, useRef, useState } from 'react'
import { Check, X, ChevronDown, ChevronRight } from 'lucide-react'
import { ipc } from '../ipc'
import Spark from '../components/Spark'
import TickerNumber from '../components/TickerNumber'
import type { FetchPhase, FetchSnapshot } from '../types'

const PHASES: Array<{ key: FetchPhase; label: string }> = [
  { key: 'load',     label: 'Load company data' },
  { key: 'fetch',    label: 'Fetch job boards' },
  { key: 'fts',      label: 'Build search index' },
  { key: 'index',    label: 'Create DB indexes' },
  { key: 'finalize', label: 'Finalize & swap' },
]

function emptySnapshot(): FetchSnapshot {
  return {
    status: 'idle', phase: 'load',
    companiesTotal: null, companiesDone: null, jobsSoFar: null,
    jobsAdded: null, errorCount: null, emptyBoards: null,
    durations: {}, startedAt: null, finishedAt: null, exitCode: null,
    errorMessage: null, lastDurationSec: null,
  }
}

function phaseDuration(s: FetchSnapshot, key: FetchPhase): string | null {
  switch (key) {
    case 'load':     return s.durations.load ?? null
    case 'fetch':    return s.durations.fetch ?? null
    case 'fts':      return s.durations.ftsRebuild ?? null
    case 'index':    return s.durations.index ?? null
    case 'finalize': return s.durations.swap ?? s.durations.checkpoint ?? null
    default:         return null
  }
}

function fmt(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`
}

function fmtApprox(s: number): string {
  return s >= 60 ? `~${Math.round(s / 60)}m` : `~${s}s`
}

function Dots({ size = 14 }: { size?: number }) {
  return <Spark size={size} />
}

type RowState = 'pending' | 'active' | 'done' | 'failed'

export default function FetchScreen() {
  const [snap, setSnap]               = useState<FetchSnapshot>(emptySnapshot)
  const [lines, setLines]             = useState<string[]>([])
  const [showDetails, setShowDetails] = useState(false)
  const [now, setNow]                 = useState(() => Date.now())
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Rehydrate — remount/reload mid-rebuild restores timer, phases and log.
    ipc.invoke<FetchSnapshot & { lines: string[] }>('fetch:get-state').then(r => {
      if (!r) return
      const { lines: buffered, ...snapshot } = r
      setSnap(snapshot)
      setLines(buffered ?? [])
    }).catch(() => { /* ignore */ })

    const onProgress = (d: unknown) => setSnap(d as FetchSnapshot)
    const onData = (d: unknown) => {
      const { line } = d as { line: string }
      setLines(prev => {
        const next = [...prev, line]
        if (next.length > 500) next.shift()
        return next
      })
    }
    ipc.on('fetch:progress', onProgress)
    ipc.on('fetch:data', onData)

    const tick = setInterval(() => setNow(Date.now()), 1000)

    return () => {
      ipc.off('fetch:progress', onProgress)
      ipc.off('fetch:data', onData)
      clearInterval(tick)
    }
  }, [])

  // Auto-open the log when the rebuild fails; auto-scroll while open.
  useEffect(() => {
    if (snap.status === 'failed') setShowDetails(true)
  }, [snap.status])
  useEffect(() => {
    if (showDetails && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines, showDetails])

  const running = snap.status === 'running'
  const endMs = snap.finishedAt ?? now
  const elapsed = snap.startedAt ? Math.max(0, Math.floor((endMs - snap.startedAt) / 1000)) : 0

  const phaseIdx = PHASES.findIndex(p => p.key === snap.phase)
  const rowState = (i: number): RowState => {
    if (snap.status === 'idle') return 'pending'
    if (snap.status === 'success' || snap.phase === 'done') return 'done'
    if (i < phaseIdx) return 'done'
    if (i > phaseIdx) return 'pending'
    return snap.status === 'failed' ? 'failed' : running ? 'active' : 'pending'
  }

  const cancel = () => { void ipc.invoke('fetch:cancel') }
  const retry  = () => { void ipc.invoke('fetch:start') }

  return (
    <div className="flex flex-col h-full">

      {/* Header */}
      <div className="shrink-0 px-8 pt-6 pb-4 border-b border-white/[0.06] bg-gray-950/95 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-white">Rebuilding Job Database</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Fetching all company boards and rebuilding the search index — keep the app open
            </p>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-2xl font-display font-bold tabular-nums text-gray-200">{fmt(elapsed)}</p>
              <p className="text-xs text-gray-600">
                elapsed{running && snap.lastDurationSec ? ` · usually takes ${fmtApprox(snap.lastDurationSec)}` : ''}
              </p>
            </div>

            {running ? (
              <Dots size={22} />
            ) : snap.status !== 'idle' ? (
              snap.status === 'success'
                ? <Check size={28} className="text-green-400" />
                : <X size={28} className="text-red-400" />
            ) : null}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        <div className="px-8 py-6 max-w-3xl mx-auto w-full flex flex-col gap-4">

          {snap.status === 'idle' ? (
            <div className="rounded-2xl border border-white/[0.06] bg-gray-900/40 p-8 text-center flex flex-col items-center gap-3">
              <p className="text-sm text-gray-400">No rebuild in progress.</p>
              <button
                onClick={cancel}
                className="text-sm px-4 py-2 rounded-full bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-gray-300 hover:text-white transition-colors"
              >
                ← Back to Resume
              </button>
            </div>
          ) : (
            <>
              {/* Phase timeline */}
              <div className="rounded-2xl border border-white/[0.06] bg-gray-900/40 p-4 flex flex-col gap-1">
                {PHASES.map((p, i) => {
                  const st = rowState(i)
                  return (
                    <div key={p.key} className="flex flex-col gap-1.5 px-2 py-2">
                      <div className="flex items-center gap-3">
                        <span className="w-5 flex justify-center shrink-0">
                          {st === 'done'   && <Check size={14} className="text-green-400" />}
                          {st === 'failed' && <X size={14} className="text-red-400" />}
                          {st === 'active' && <Dots />}
                          {st === 'pending' && <span className="w-1.5 h-1.5 rounded-full bg-gray-700" />}
                        </span>
                        <span className={[
                          'text-sm flex-1',
                          st === 'active' ? 'text-white font-medium'
                            : st === 'done' ? 'text-gray-300'
                            : st === 'failed' ? 'text-red-300'
                            : 'text-gray-600',
                        ].join(' ')}>
                          {p.label}
                        </span>
                        <span className="font-mono text-xs text-gray-500 tabular-nums">
                          {phaseDuration(snap, p.key) ?? ''}
                        </span>
                      </div>
                      {st === 'active' && p.key === 'fetch' && (
                        <div className="ml-8 flex flex-col gap-1.5 pr-1">
                          {snap.companiesDone != null && snap.companiesTotal ? (
                            <>
                              <p className="text-xs text-gray-500 tabular-nums">
                                <TickerNumber value={snap.companiesDone} /> / {snap.companiesTotal.toLocaleString()} company boards
                                {snap.jobsSoFar != null && <> · <TickerNumber value={snap.jobsSoFar} /> jobs collected</>}
                              </p>
                              <div className="bg-white/[0.06] rounded-full h-1.5 overflow-hidden">
                                <div
                                  className="h-1.5 bg-orange-500 rounded-full transition-all duration-500"
                                  style={{ width: `${Math.min(100, (snap.companiesDone / snap.companiesTotal) * 100)}%` }}
                                />
                              </div>
                            </>
                          ) : (
                            <>
                              <p className="text-xs text-gray-500">
                                {snap.companiesTotal
                                  ? `Fetching ${snap.companiesTotal.toLocaleString()} company boards…`
                                  : 'Fetching company boards…'}
                              </p>
                              <div className="bg-white/[0.06] rounded-full h-1.5 overflow-hidden">
                                <div className="w-1/3 h-1.5 bg-orange-500 rounded-full animate-indeterminate" />
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Success — stays until the user continues (no auto-redirect) */}
              {snap.status === 'success' && (
                <>
                  <div className="rounded-2xl px-4 py-2.5 text-sm font-medium border bg-green-950/50 border-green-800 text-green-300">
                    Rebuild complete in {snap.durations.total ?? fmt(elapsed)} — database is up to date
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: 'Jobs added',   value: snap.jobsAdded,   warn: false },
                      { label: 'Errors',       value: snap.errorCount ?? 0, warn: (snap.errorCount ?? 0) > 0 },
                      { label: 'Empty boards', value: snap.emptyBoards ?? 0, warn: false },
                    ].map(tile => (
                      <div key={tile.label} className="rounded-2xl border border-white/[0.06] bg-gray-900/60 px-4 py-3">
                        <p className={`text-2xl font-display font-bold tabular-nums ${tile.warn ? 'text-amber-400' : 'text-gray-100'}`}>
                          {tile.value !== null ? <TickerNumber value={tile.value} /> : '—'}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">{tile.label}</p>
                      </div>
                    ))}
                  </div>
                  <div>
                    <button
                      onClick={cancel}
                      className="text-sm font-medium px-5 py-2.5 rounded-full text-white bg-orange-500 transition-colors"
                    >
                      Continue →
                    </button>
                  </div>
                </>
              )}

              {/* Failure */}
              {snap.status === 'failed' && (
                <div className="flex flex-col gap-3">
                  <div className="rounded-2xl px-4 py-2.5 text-sm border bg-red-950/40 border-red-800 text-red-300">
                    <p className="font-medium">
                      Rebuild failed{snap.exitCode !== null && snap.exitCode !== 0 ? ` (exit code ${snap.exitCode})` : ''}
                    </p>
                    {snap.errorMessage && (
                      <p className="mt-1 text-xs text-red-200/80 whitespace-pre-wrap">{snap.errorMessage}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={cancel}
                      className="text-sm font-medium px-4 py-2 rounded-full text-white bg-orange-500 transition-colors"
                    >
                      ← Back to Resume
                    </button>
                    <button
                      onClick={retry}
                      className="text-sm px-4 py-2 rounded-full bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-gray-300 hover:text-white transition-colors"
                    >
                      Retry Rebuild
                    </button>
                  </div>
                </div>
              )}

              {/* Details log */}
              {lines.length > 0 && (
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => setShowDetails(v => !v)}
                    className="self-start flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    {showDetails ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {showDetails ? 'Hide details' : 'Show details'}
                  </button>
                  {showDetails && (
                    <div
                      ref={logRef}
                      className="font-mono text-[11px] leading-relaxed text-gray-400 bg-gray-950/80 border border-white/[0.06] rounded-2xl p-3 max-h-64 overflow-auto whitespace-pre-wrap"
                    >
                      {lines.join('\n')}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Footer — cancel while running */}
      {running && (
        <div className="shrink-0 px-8 pb-6 max-w-3xl mx-auto w-full">
          <button
            onClick={cancel}
            className="text-sm px-4 py-2 rounded-full bg-white/[0.06] border border-white/[0.08] text-gray-400 hover:bg-red-950/40 hover:border-red-800/60 hover:text-red-300 transition-colors"
          >
            Cancel Rebuild
          </button>
        </div>
      )}
    </div>
  )
}
