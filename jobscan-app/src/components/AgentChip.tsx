import { useEffect, useRef, useState } from 'react'
import { ipc } from '../ipc'

interface Note { text: string; at: string; from: 'agent' | 'app' }
interface HarnessStatus { enabled: boolean; connected: boolean; notes: Note[] }

/**
 * Shown only while "Let Claude Code drive JobScan" is on: whether a Claude
 * Code session is listening, and what it has said or started. Notes are the
 * agent's own words, shown as plain text and labelled as such.
 */
export default function AgentChip() {
  const [status, setStatus] = useState<HarnessStatus | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      ipc.invoke<HarnessStatus>('harness:get-status')
        .then(s => { if (alive) setStatus(s ?? null) })
        .catch(() => { /* chip stays as it was */ })
    }
    load()
    const timer = setInterval(load, 10_000)
    const onNote = (): void => load()
    ipc.on('agent:note', onNote)
    return () => { alive = false; clearInterval(timer); ipc.off('agent:note', onNote) }
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  if (!status?.enabled) return null
  const label = status.connected ? 'Claude Code connected' : 'Waiting for Claude Code'
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={`${label}. Show its notes`}
        className={[
          'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
          status.connected
            ? 'border-orange-500/40 text-orange-200 bg-orange-900/20'
            : 'border-white/[0.08] text-gray-400 bg-white/[0.04] hover:text-gray-200',
        ].join(' ')}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.connected ? 'bg-orange-400' : 'bg-gray-500'}`} aria-hidden />
        <span className="truncate">{label}</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-80 overflow-auto rounded-xl border border-white/[0.08] bg-[rgba(38,38,36,0.98)] p-3 shadow-xl z-50">
          <p className="text-xs text-gray-500 mb-2">
            {status.connected
              ? 'A Claude Code session is driving JobScan. It can start a rebuild, find jobs, rate them and stop the loop. It cannot apply or change settings.'
              : 'Open Claude Code and run /jobscan:jobscan to let it drive JobScan.'}
          </p>
          {status.notes.length === 0 ? (
            <p className="text-xs text-gray-600">Nothing from your agent yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {[...status.notes].reverse().map(n => (
                <li key={n.at + n.text} className="text-xs">
                  <span className="text-gray-500">{n.from === 'agent' ? 'From your agent' : 'JobScan'} · {new Date(n.at).toLocaleTimeString()}</span>
                  <p className="text-gray-300 whitespace-pre-wrap break-words">{n.text}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
