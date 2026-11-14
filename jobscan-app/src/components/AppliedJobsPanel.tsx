import { useEffect, useRef, useState } from 'react'
import { Check, X, ClipboardList } from 'lucide-react'
import { ipc } from '../ipc'
import ApplicationRecord from './ApplicationRecord'
import type { AppliedJobLogEntry } from '../types'

interface Props {
  onClose: () => void
}

function fmtAbs(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  } catch { return iso }
}

type FilterStatus = 'all' | 'submitted' | 'failed'

export default function AppliedJobsPanel({ onClose }: Props) {
  const [jobs, setJobs] = useState<AppliedJobLogEntry[]>([])
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')
  const [clearing, setClearing] = useState(false)
  const [recordPath, setRecordPath] = useState<string | null>(null)

  const refresh = (): void => {
    ipc.invoke<AppliedJobLogEntry[]>('applied-jobs:get-log').then(setJobs).catch(() => setJobs([]))
  }

  const recordOpenRef = useRef(false)
  recordOpenRef.current = recordPath !== null

  useEffect(() => {
    refresh()
    // Escape closes the panel — unless the record modal is open (it handles
    // its own Escape in the capture phase and closes itself first).
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !recordOpenRef.current) onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose])

  const clearAll = async () => {
    if (clearing) return
    setClearing(true)
    try {
      await ipc.invoke('applied-jobs:clear')
      refresh()
    } finally { setClearing(false) }
  }

  const filtered = jobs.filter(j =>
    filterStatus === 'all' || j.status === filterStatus
  )

  const submittedCount = jobs.filter(j => j.status === 'submitted').length
  const failedCount = jobs.filter(j => j.status === 'failed').length

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="modal-in bg-[rgba(38,38,36,0.96)] border border-white/[0.06] rounded-2xl p-6 w-full max-w-3xl flex flex-col gap-4 max-h-[90vh]"
      >

        {/* Header */}
        <div className="flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-lg font-semibold">Applied Jobs</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {jobs.length} total · <span className="text-green-400">{submittedCount} submitted</span>
              {failedCount > 0 && <> · <span className="text-red-400">{failedCount} failed</span></>}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-auto flex flex-col gap-5 pr-1">

          {/* Empty state — first-time users with no data */}
          {jobs.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <ClipboardList size={30} className="text-gray-600" />
              <p className="text-sm text-gray-300 font-medium">No applications yet</p>
              <p className="text-xs text-gray-500 max-w-sm">
                Once you run the pipeline, completed jobs will show here.
              </p>
            </div>
          )}

          {/* Applied jobs */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Applied Jobs ({filtered.length})</p>
              <select
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value as FilterStatus)}
                className="bg-gray-800 border border-white/[0.08] rounded px-2 py-1 text-xs focus:outline-none cursor-pointer"
              >
                <option value="all">All status</option>
                <option value="submitted">Submitted</option>
                <option value="failed">Failed</option>
              </select>
            </div>

            {filtered.length === 0 ? (
              <p className="text-xs text-gray-600">No jobs match the current filter.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {filtered.map((j, i) => (
                  <div
                    key={`${j.jobId}-${j.ts}-${i}`}
                    className={[
                      'flex items-center gap-3 border rounded-xl px-3 py-2 text-xs',
                      j.status === 'submitted'
                        ? 'border-green-900 bg-green-950/20'
                        : 'border-red-900 bg-red-950/15',
                    ].join(' ')}
                  >
                    {j.status === 'submitted'
                      ? <Check size={14} className="text-green-400 shrink-0" />
                      : <X size={14} className="text-red-400 shrink-0" />}
                    <span className={[
                      'text-xs px-1.5 py-0.5 rounded shrink-0',
                      j.via === 'auto'
                        ? 'bg-orange-900/40 text-orange-300 border border-orange-700/50'
                        : 'bg-gray-800 text-gray-400 border border-white/[0.08]',
                    ].join(' ')}>
                      {j.via}
                    </span>
                    <span className="text-gray-600 w-20 shrink-0">{j.platform}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-100 truncate">{j.title || j.company}</p>
                      <p className="text-xs text-gray-500 truncate">{j.company}</p>
                    </div>
                    <span className="text-gray-600 shrink-0">{fmtAbs(j.ts)}</span>
                    {j.detailsPath && (
                      <button
                        onClick={() => setRecordPath(j.detailsPath!)}
                        aria-label={`Details ${j.jobId}`}
                        className="text-xs text-purple-400 hover:text-purple-300 shrink-0"
                      >
                        Details
                      </button>
                    )}
                    {j.applyUrl && (
                      <button
                        onClick={() => ipc.invoke('shell:open', j.applyUrl)}
                        className="text-xs text-orange-400 hover:text-orange-300 shrink-0"
                      >
                        Open ↗
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-between items-center pt-2 border-t border-white/[0.06] shrink-0">
          <button
            onClick={clearAll}
            disabled={clearing || jobs.length === 0}
            className="text-xs px-3 py-1.5 rounded-full bg-red-900/30 hover:bg-red-800/40 border border-red-900/50 text-red-300 disabled:opacity-40 transition-colors"
          >
            {clearing ? 'Clearing…' : 'Clear history'}
          </button>
          <button
            onClick={onClose}
            className="text-xs px-4 py-1.5 rounded-full bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-gray-300 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
      {recordPath && <ApplicationRecord path={recordPath} onClose={() => setRecordPath(null)} />}
    </div>
  )
}
