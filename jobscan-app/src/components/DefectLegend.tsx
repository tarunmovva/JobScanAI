import { useState } from 'react'
import { DEFECT_TAGS } from '../../electron/board-tags'

// What each tag on a card in Defects means. "Skipped" arrived with loop mode
// and is easy to misread as an error, so the meanings live next to the board.
//
// Collapsed by default, like the Chrome tab legend beside it.
export default function DefectLegend() {
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
        What the tags mean
      </button>

      {open && (
        <ul className="mt-2 rounded-lg border border-white/[0.05] bg-gray-900/40 px-3 py-2.5 space-y-1.5">
          {DEFECT_TAGS.map(tag => (
            <li key={tag.id} className="flex items-baseline gap-2 min-w-0">
              <span className={[
                'inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none border',
                tag.id === 'needs_you' ? 'border-orange-400/50 text-orange-300' : 'border-white/10 text-gray-400',
              ].join(' ')}>
                {tag.label}
              </span>
              <span className="text-[11.5px] text-gray-500">{tag.meaning}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
