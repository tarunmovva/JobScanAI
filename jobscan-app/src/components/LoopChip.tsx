import { chipLabel } from '../../electron/loop-copy'
import type { LoopStatus } from '../types'

// The header's "Loop" chip: whether the app is applying on its own right now,
// at a glance. Opens the loop panel.
export default function LoopChip({ status, onOpen }: { status: LoopStatus | null; onOpen: () => void }) {
  const phase = status?.phase ?? 'off'
  const label = status ? chipLabel(status, new Date()) : 'Loop'
  const tone =
    phase === 'running' || phase === 'stopping' ? 'border-emerald-500/40 text-emerald-200 bg-emerald-900/20'
      : phase === 'waiting' ? 'border-sky-500/40 text-sky-200 bg-sky-900/20'
        : phase === 'stopped' ? 'border-amber-500/40 text-amber-200 bg-amber-900/20'
          : 'border-white/[0.08] text-gray-400 bg-white/[0.04] hover:text-gray-200'
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Loop mode"
      aria-label={`Loop mode: ${label}`}
      className={`flex items-center gap-1.5 shrink-0 max-w-[340px] rounded-full border px-2.5 py-1 text-xs transition-colors ${tone}`}
    >
      {(phase === 'running' || phase === 'stopping') && (
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" aria-hidden />
      )}
      <span className="truncate">{label}</span>
    </button>
  )
}
