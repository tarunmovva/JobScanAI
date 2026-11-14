import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, X, Hand } from 'lucide-react'
import { ipc } from '../ipc'
import AppliedJobsPanel from '../components/AppliedJobsPanel'
import ApplicationRecord from '../components/ApplicationRecord'

interface AppResult {
  company: string
  jobId: string
  platform: string
  title: string
  applyUrl: string
  status: 'submitted' | 'failed'
  message: string
  detailsPath?: string
  // Set when the form is filled and correct but one step is left that the app
  // must not do for the user — clearing a CAPTCHA, finishing an email
  // verification. Carries the instruction, not just a flag.
  needsYou?: string
}

export default function DoneScreen() {
  const [submitted, setSubmitted] = useState<AppResult[]>([])
  const [needsYou, setNeedsYou]   = useState<AppResult[]>([])
  const [failed, setFailed]       = useState<AppResult[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [recordPath, setRecordPath] = useState<string | null>(null)

  useEffect(() => {
    ipc.invoke<AppResult[]>('done:get-summary').then(results => {
      const all = results ?? []
      setSubmitted(all.filter(r => r.status === 'submitted'))
      // A blocked-on-you application is NOT a failure — the work is done and one
      // human step remains. Listing it under Failed is what made people abandon
      // applications that were a single click from being submitted.
      setNeedsYou(all.filter(r => r.status === 'failed' && r.needsYou))
      setFailed(all.filter(r => r.status === 'failed' && !r.needsYou))
    })
  }, [])

  const reset = () => ipc.invoke('pipeline:reset')

  return (
    <div className="flex flex-col h-full">

      {/* Sticky header */}
      <div className="shrink-0 px-8 pt-6 pb-4 border-b border-white/[0.06] bg-gray-950/95 backdrop-blur-sm">
        <h2 className="text-xl font-semibold">Done</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          {submitted.length > 0 && <span className="text-green-400">{submitted.length} submitted</span>}
          {submitted.length > 0 && (needsYou.length > 0 || failed.length > 0) && <span className="text-gray-600 mx-2">·</span>}
          {needsYou.length > 0 && <span className="text-amber-400">{needsYou.length} need you</span>}
          {needsYou.length > 0 && failed.length > 0 && <span className="text-gray-600 mx-2">·</span>}
          {failed.length > 0 && <span className="text-red-400">{failed.length} failed</span>}
          {submitted.length === 0 && failed.length === 0 && 'No applications processed in this run.'}
        </p>
      </div>

      <div className="flex-1 overflow-auto px-8 py-4 flex flex-col gap-4">

        {submitted.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-gray-600 uppercase tracking-wide font-medium">Submitted</p>
            {submitted.map((r, i) => (
              <motion.div key={`${r.jobId}-${i}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: Math.min(i * 0.04, 0.3), ease: 'easeOut' }}
                className="flex items-center gap-3 border border-green-900 bg-green-950/30 rounded-2xl px-4 py-3">
                <Check size={15} className="text-green-400 shrink-0" />
                {r.platform && (
                  <span className="text-xs text-gray-600 shrink-0 w-20">{r.platform}</span>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-100 truncate">{r.title || r.company}</p>
                  <p className="text-xs text-gray-500 truncate">{r.company}</p>
                </div>
                {r.detailsPath && (
                  <button
                    onClick={() => setRecordPath(r.detailsPath!)}
                    className="text-xs text-purple-400 hover:text-purple-300 shrink-0 transition-colors"
                  >
                    Details
                  </button>
                )}
                {r.applyUrl && (
                  <button
                    onClick={() => ipc.invoke('shell:open', r.applyUrl)}
                    className="text-xs text-orange-400 hover:text-orange-300 shrink-0 transition-colors"
                  >
                    Open →
                  </button>
                )}
              </motion.div>
            ))}
          </div>
        )}

        {needsYou.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-amber-500/80 uppercase tracking-wide font-medium">
              Needs you — {needsYou.length} application{needsYou.length > 1 ? 's' : ''} filled, waiting on one step
            </p>
            {needsYou.map((r, i) => (
              <motion.div key={`needs-${r.jobId}-${i}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: Math.min(i * 0.04, 0.3), ease: 'easeOut' }}
                className="flex items-center gap-3 border border-amber-900/70 bg-amber-950/20 rounded-2xl px-4 py-3">
                <Hand size={15} className="text-amber-400 shrink-0" />
                {r.platform && (
                  <span className="text-xs text-gray-600 shrink-0 w-20">{r.platform}</span>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-100 truncate">{r.title || r.company}</p>
                  <p className="text-xs text-amber-500/90 truncate">{r.needsYou}</p>
                </div>
                {r.detailsPath && (
                  <button
                    onClick={() => setRecordPath(r.detailsPath!)}
                    className="text-xs text-purple-400 hover:text-purple-300 shrink-0 transition-colors"
                  >
                    Details
                  </button>
                )}
                {r.applyUrl && (
                  <button
                    onClick={() => ipc.invoke('chrome:focus-tab', r.applyUrl)}
                    title="Raises the tab this application was filled in"
                    className="text-xs font-medium text-amber-300 hover:text-amber-200 shrink-0 transition-colors"
                  >
                    Finish it →
                  </button>
                )}
              </motion.div>
            ))}
          </div>
        )}

        {failed.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-gray-600 uppercase tracking-wide font-medium">Failed</p>
            {failed.map((r, i) => (
              <motion.div key={`${r.jobId}-${i}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: Math.min(i * 0.04, 0.3), ease: 'easeOut' }}
                className="flex items-center gap-3 border border-red-900 bg-red-950/20 rounded-2xl px-4 py-3">
                <X size={15} className="text-red-400 shrink-0" />
                {r.platform && (
                  <span className="text-xs text-gray-600 shrink-0 w-20">{r.platform}</span>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-100 truncate">{r.title || r.company}</p>
                  <p className="text-xs text-gray-500 truncate">{r.company}</p>
                </div>
                {r.message && (
                  <p className="text-xs text-red-600 truncate max-w-xs">{r.message}</p>
                )}
                {r.detailsPath && (
                  <button
                    onClick={() => setRecordPath(r.detailsPath!)}
                    className="text-xs text-purple-400 hover:text-purple-300 shrink-0 transition-colors"
                  >
                    Details
                  </button>
                )}
                {r.applyUrl && (
                  <button
                    onClick={() => ipc.invoke('shell:open', r.applyUrl)}
                    className="text-xs text-orange-400 hover:text-orange-300 shrink-0 transition-colors"
                  >
                    Open →
                  </button>
                )}
              </motion.div>
            ))}
          </div>
        )}

        <div className="flex gap-2 mt-2">
          <button
            onClick={reset}
            className="bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] px-6 py-3 rounded-full text-sm font-medium transition-colors"
          >
            Start Over
          </button>
          <button
            onClick={() => setShowHistory(true)}
            className="bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-gray-400 hover:text-gray-200 px-6 py-3 rounded-full text-sm font-medium transition-colors"
          >
            View all applied jobs →
          </button>
        </div>
      </div>
      {showHistory && <AppliedJobsPanel onClose={() => setShowHistory(false)} />}
      {recordPath && <ApplicationRecord path={recordPath} onClose={() => setRecordPath(null)} />}
    </div>
  )
}
