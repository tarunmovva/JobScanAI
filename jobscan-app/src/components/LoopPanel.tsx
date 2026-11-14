import { useEffect, useState } from 'react'
import { ipc } from '../ipc'
import ConfirmDialog from './ConfirmDialog'
import { CHIP_LEGEND, chipLabel, startConfirmCopy } from '../../electron/loop-copy'
import type { LoopSettings, LoopStatus } from '../types'

const REASON_TEXT: Record<string, string> = {
  captcha: 'CAPTCHA',
  needs_person: 'needed a person',
  closed: 'posting closed',
  interrupted: 'cut off mid-fill',
  unconfirmed: 'submit not confirmed',
  attempts: 'failed twice',
}

const time = (iso: string): string =>
  new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

const isOn = (s: LoopStatus | null): boolean =>
  !!s && (s.phase === 'running' || s.phase === 'stopping' || s.phase === 'waiting')

// Loop mode: what it applies to, what it is doing, and the switch. Styled
// like Settings. Settings stay editable while it runs; they apply from the
// next round.
export default function LoopPanel({ status, onClose }: { status: LoopStatus | null; onClose: () => void }) {
  const [form, setForm] = useState<LoopSettings | null>(status?.settings ?? null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [savedNote, setSavedNote] = useState(false)
  const [showExcluded, setShowExcluded] = useState(false)

  useEffect(() => { if (!form && status) setForm(status.settings) }, [status, form])

  const on = isOn(status)
  const dirty = !!form && !!status && JSON.stringify(form) !== JSON.stringify(status.settings)

  const save = async (): Promise<LoopSettings | null> => {
    if (!form) return null
    const saved = await ipc.invoke<LoopSettings>('loop:save-settings', form)
    if (saved) setForm(saved)
    setSavedNote(true)
    setTimeout(() => setSavedNote(false), 1500)
    return saved ?? null
  }

  const askToStart = async (): Promise<void> => {
    setError(null)
    if (dirty) await save()
    setConfirming(true)
  }

  const start = async (): Promise<void> => {
    setConfirming(false)
    setBusy(true)
    const r = await ipc.invoke<{ ok: boolean; reason?: string }>('loop:start')
    setBusy(false)
    if (!r?.ok) setError(r?.reason ?? 'Loop mode could not start.')
  }

  const stop = async (mode: 'after-round' | 'now'): Promise<void> => {
    setBusy(true)
    await ipc.invoke('loop:stop', { mode })
    setBusy(false)
  }

  const setNum = (key: 'threshold' | 'dailyLimit' | 'minGapMin', v: string): void =>
    setForm(f => (f ? { ...f, [key]: Number(v) } : f))


  return (
    <>
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Loop mode"
        className="modal-in bg-[rgba(38,38,36,0.96)] border border-white/[0.06] rounded-2xl p-6 w-full max-w-xl flex flex-col gap-5 max-h-[90vh] overflow-auto"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Loop mode</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none" aria-label="Close">×</button>
        </div>

        <p className="text-sm text-gray-400 leading-relaxed">
          Repeats the whole run on its own: rebuild, find jobs, rate, and apply to the best ones.
          {status && <> Now: <span className="text-gray-200" data-testid="loop-now">{status.phase === 'off' ? 'off' : chipLabel(status, new Date())}</span>.</>}
        </p>
        {!on && status?.stopReason && status.phase !== 'stopped' && (
          <p className="text-xs text-gray-500">Last stopped: {status.stopReason}</p>
        )}

        {/* ── settings ── */}
        {form && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Applies to</p>
            <div className="grid grid-cols-3 gap-3">
              <label className="flex flex-col gap-1 text-xs text-gray-400 font-medium">
                Rated at least
                <select
                  aria-label="Rated at least"
                  value={form.threshold}
                  onChange={e => setNum('threshold', e.target.value)}
                  className="bg-[rgba(35,34,32,0.92)] border border-white/[0.08] rounded-lg px-2 py-2 text-sm text-gray-100 focus:outline-none focus:border-orange-500"
                >
                  {Array.from({ length: 10 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-gray-400 font-medium">
                Jobs a day, at most
                <input
                  aria-label="Jobs a day, at most"
                  type="number" min={1} max={500} value={form.dailyLimit}
                  onChange={e => setNum('dailyLimit', e.target.value)}
                  className="bg-[rgba(35,34,32,0.92)] border border-white/[0.08] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-gray-400 font-medium">
                Minutes between rounds
                <input
                  aria-label="Minutes between rounds"
                  type="number" min={15} max={1440} value={form.minGapMin}
                  onChange={e => setNum('minGapMin', e.target.value)}
                  className="bg-[rgba(35,34,32,0.92)] border border-white/[0.08] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500"
                />
              </label>
            </div>
            {dirty && (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => void save()}
                  className="self-start text-sm px-3 py-1.5 rounded-full bg-white/[0.08] hover:bg-white/[0.12] border border-white/[0.1]"
                >
                  {on ? 'Save — applies from the next round' : 'Save'}
                </button>
              </div>
            )}
            {savedNote && <span className="text-xs text-emerald-300">Saved</span>}
          </div>
        )}

        {/* ── the switch ── */}
        <div className="flex items-center gap-2 flex-wrap">
          {!on ? (
            <button
              onClick={() => void askToStart()}
              disabled={!form || busy}
              className="px-4 py-2 rounded-full text-sm font-medium bg-orange-600 hover:bg-orange-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Start
            </button>
          ) : (
            <>
              <button
                onClick={() => void stop('after-round')}
                disabled={busy || status?.phase === 'stopping'}
                className="px-4 py-2 rounded-full text-sm bg-white/[0.08] hover:bg-white/[0.12] border border-white/[0.1] disabled:opacity-40"
              >
                Stop after this round
              </button>
              <button
                onClick={() => void stop('now')}
                disabled={busy}
                className="px-4 py-2 rounded-full text-sm bg-red-800 hover:bg-red-700 text-white disabled:opacity-40"
              >
                Stop now
              </button>
            </>
          )}
          {error && <span className="text-sm text-amber-300" role="alert">{error}</span>}
        </div>

        {/* ── facts ── */}
        {status && (
          <div className="flex flex-col gap-1.5 text-sm text-gray-300">
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Today</p>
            <p>{status.today.attempted} of {status.today.limit} started today.</p>
            {(status.codexUsage.fiveHour != null || status.codexUsage.weekly != null) && (
              <p className="text-gray-400">
                Codex used: 5-hour {status.codexUsage.fiveHour ?? '–'}% · weekly {status.codexUsage.weekly ?? '–'}%
              </p>
            )}
            {status.paused.map(p => (
              <p key={p.platform} className="text-amber-200">
                {p.platform} paused until {time(p.until)} after repeated CAPTCHAs.
              </p>
            ))}
            {status.excluded.length > 0 && (
              <div>
                <button onClick={() => setShowExcluded(v => !v)} className="text-gray-400 hover:text-gray-200" aria-expanded={showExcluded}>
                  {showExcluded ? '▾' : '▸'} {status.excluded.length} job{status.excluded.length === 1 ? '' : 's'} the loop will not pick again
                </button>
                {showExcluded && (
                  <ul className="mt-1.5 max-h-40 overflow-auto flex flex-col gap-1 text-xs text-gray-400">
                    {status.excluded.map(e => (
                      <li key={e.key}>
                        {(e.company || e.key)}{e.title ? ` — ${e.title}` : ''} · {REASON_TEXT[e.reason] ?? e.reason} · {time(e.at)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── rounds ── */}
        {status && status.history.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Last rounds</p>
            <table className="text-xs text-gray-300 w-full">
              <thead className="text-gray-500">
                <tr>
                  <th className="text-left font-normal">Started</th>
                  <th className="text-right font-normal">New</th>
                  <th className="text-right font-normal">Rated</th>
                  <th className="text-right font-normal">Picked</th>
                  <th className="text-right font-normal">Sent</th>
                  <th className="text-right font-normal">Failed</th>
                  <th className="text-right font-normal">Skipped</th>
                  <th className="text-left font-normal pl-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {status.history.map(r => (
                  <tr key={r.startedAt}>
                    <td>{time(r.startedAt)}</td>
                    <td className="text-right">{r.newJobs}</td>
                    <td className="text-right">{r.newlyRated}</td>
                    <td className="text-right">{r.selected}</td>
                    <td className="text-right">{r.submitted}</td>
                    <td className="text-right">{r.failed}</td>
                    <td className="text-right">{r.skipped}</td>
                    <td className={`pl-2 ${r.error && !r.codexLimit ? 'text-amber-300' : 'text-gray-500'}`}>{r.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── legend ── */}
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">What the chip says</p>
          <ul className="flex flex-col gap-1.5" data-testid="loop-legend">
            {CHIP_LEGEND.map(e => (
              <li key={e.phase} className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-gray-300">{e.label}</span>
                <span className="text-gray-500">{e.meaning}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-500">
            On the board, jobs the loop did not finish carry a grey Skipped tag with the reason. Their tabs are closed.
          </p>
        </div>

        <p className="text-xs text-gray-500">
          While the loop is on the PC is kept awake, and the pipeline screens follow it on their own. A closed laptop lid can still put it to sleep.
        </p>
      </div>
    </div>
    {/* A sibling, not a child: a click on its backdrop must not close the panel too. */}
    {confirming && form && (
      <ConfirmDialog
        message={startConfirmCopy(form)}
        confirmLabel="Start loop"
        cancelLabel="Cancel"
        onConfirm={() => void start()}
        onCancel={() => setConfirming(false)}
      />
    )}
    </>
  )
}
