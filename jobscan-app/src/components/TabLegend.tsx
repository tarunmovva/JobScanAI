import { useState } from 'react'
import { TAB_STAGES, TAB_STAGE_ORDER } from '../../electron/tab-stages'

// The automated Chrome tabs are labelled "[FILL] acme — Senior Engineer" with
// a coloured favicon, because nine of them are open at once and otherwise every
// one reads "Job Application for ...". A four-character code nobody can decode
// is just noise, so the meanings live here, next to the board the tabs belong
// to.
//
// Collapsed by default: it is reference material, needed once and then known.
export default function TabLegend() {
  const [open, setOpen] = useState(false)

  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-[11.5px] text-gray-500 hover:text-gray-300 transition-colors"
        aria-expanded={open}
      >
        <span className="font-mono text-[10px] leading-none">{open ? '▾' : '▸'}</span>
        Chrome tab labels
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-white/[0.05] bg-gray-900/40 px-3 py-2.5">
          <p className="text-[11.5px] text-gray-500 mb-2">
            Tabs this app opens are renamed so you can tell them apart at a glance.
            A tab that stays open after a run is one you can finish by hand.
          </p>
          <ul className="grid grid-cols-2 gap-x-5 gap-y-1.5">
            {TAB_STAGE_ORDER.map(stage => {
              const spec = TAB_STAGES[stage]
              return (
                <li key={stage} className="flex items-center gap-2 min-w-0">
                  <span
                    aria-hidden
                    className="size-2.5 rounded-sm shrink-0"
                    style={{ background: spec.color }}
                  />
                  <span className="font-mono text-[11px] text-gray-300 shrink-0">
                    [{spec.code}]
                  </span>
                  <span className="text-[11.5px] text-gray-500 truncate">
                    {spec.meaning}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
