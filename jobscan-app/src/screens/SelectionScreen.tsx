import { useEffect, useState } from 'react'
import { ipc } from '../ipc'
import type { RatedJob } from '../types'

export default function SelectionScreen() {
  const [jobs, setJobs] = useState<RatedJob[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    ipc.on('rating:done', (d: unknown) => {
      setJobs((d as { jobs: RatedJob[] }).jobs)
    })
  }, [])

  const toggle = (id: string) =>
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const apply = async (ids: string[]) => {
    setSubmitting(true)
    await ipc.invoke('selection:confirm', { jobIds: ids })
    await ipc.invoke('pipeline:start-fill')
    setSubmitting(false)
  }

  const ratingColor = (r: number) =>
    r >= 8 ? 'text-green-400' : r >= 5 ? 'text-yellow-400' : 'text-red-400'

  return (
    <div className="p-8 flex flex-col gap-4 max-w-3xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-2xl font-semibold">Select Jobs to Apply ({jobs.length})</h2>
        <div className="flex gap-2">
          {selected.size > 0 && (
            <button
              onClick={() => apply([...selected])}
              disabled={submitting}
              className="bg-green-600 hover:bg-green-500 disabled:opacity-50 px-4 py-2 rounded-full text-sm font-medium transition-colors"
            >
              Apply to Selected ({selected.size})
            </button>
          )}
          <button
            onClick={() => apply(jobs.map(j => j.id))}
            disabled={submitting || jobs.length === 0}
            className="bg-orange-500 hover:bg-orange-600 disabled:opacity-50 px-4 py-2 rounded-full text-sm font-medium transition-all"
          >
            Apply to All {jobs.length > 0 ? `(${jobs.length})` : ''}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2 overflow-auto max-h-[65vh] pr-1">
        {jobs.map(j => (
          <label
            key={j.id}
            className="flex items-start gap-3 bg-gray-900 hover:bg-gray-800 border border-white/[0.06] rounded-lg p-3 cursor-pointer transition-colors"
          >
            <input
              type="checkbox"
              checked={selected.has(j.id)}
              onChange={() => toggle(j.id)}
              className="mt-0.5 accent-orange-500 shrink-0"
            />
            <span className={`text-lg font-bold w-6 shrink-0 ${ratingColor(j.rating)}`}>
              {j.rating}
            </span>
            <div className="min-w-0">
              <p className="font-medium text-sm">
                {j.title}
                <span className="text-gray-500 font-normal ml-1.5">· {j.company}</span>
              </p>
              <p className="text-xs text-gray-400">{j.location} · {j.platform}</p>
              <p className="text-xs text-gray-500 mt-0.5">{j.reason}</p>
            </div>
          </label>
        ))}
      </div>
    </div>
  )
}
