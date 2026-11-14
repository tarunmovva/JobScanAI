import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { ipc } from '../ipc'
import Spark from '../components/Spark'
import TickerNumber from '../components/TickerNumber'
import type { RatedJob } from '../types'

const ratingColor = (r: number) =>
  r >= 8 ? 'text-green-400 bg-green-950/60 border-green-800'
  : r >= 5 ? 'text-yellow-400 bg-yellow-950/60 border-yellow-800'
  : 'text-red-400 bg-red-950/40 border-red-900'

const ratingDot = (r: number) =>
  r >= 8 ? 'bg-green-400' : r >= 5 ? 'bg-yellow-400' : 'bg-red-400'

function relativeDate(iso: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return months === 1 ? '1mo ago' : `${months}mo ago`
}

function openUrl(url: string) {
  if (url) ipc.invoke('shell:open', url)
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function DetailPanel({ job, selected, onToggle, onClose }: {
  job: RatedJob
  selected: boolean
  onToggle: () => void
  onClose: () => void
}) {
  const descRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Scroll description to top when job changes
    if (descRef.current) descRef.current.scrollTop = 0
  }, [job.id])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const meta = [
    job.location,
    job.workplace_type,
    job.employment_type,
    job.platform,
  ].filter(Boolean)

  return (
    <div className="flex flex-col h-full border-l border-white/[0.06] bg-[rgba(31,30,29,0.95)]">

      {/* Header */}
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-white/[0.06]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-white leading-snug">{job.title}</h3>
            <p className="text-sm text-gray-400 mt-0.5">{job.company}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`text-sm font-display font-bold border rounded-md px-2 py-1 ${ratingColor(job.rating)}`}>
              {job.rating}/10
            </span>
            <button
              onClick={onClose}
              aria-label="Close preview"
              className="text-gray-600 hover:text-gray-300 transition-colors leading-none"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Meta row */}
        <div className="flex flex-wrap gap-1.5 mt-3">
          {meta.map((m, i) => (
            <span key={i} className="text-xs bg-gray-800 text-gray-400 rounded px-2 py-0.5">
              {m}
            </span>
          ))}
          {job.posted_at && (
            <span className="text-xs text-gray-600 px-1 py-0.5">
              {relativeDate(job.posted_at)}
            </span>
          )}
        </div>
      </div>

      {/* Scrollable body */}
      <div ref={descRef} className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">

        {/* AI Assessment */}
        {job.reason && (
          <div className="rounded-2xl bg-[rgba(38,38,36,0.96)] border border-white/[0.06] p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${ratingDot(job.rating)}`} />
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">AI Assessment</p>
            </div>
            <p className="text-[15px] font-display text-gray-300 leading-relaxed">{job.reason}</p>
          </div>
        )}

        {/* Description */}
        {job.description ? (
          <div>
            <p className="text-xs text-gray-600 uppercase tracking-wide font-medium mb-2">Description</p>
            <p className="text-sm text-gray-400 leading-relaxed whitespace-pre-wrap">
              {job.description}
            </p>
          </div>
        ) : (
          <p className="text-xs text-gray-600">No description available.</p>
        )}
      </div>

      {/* Action bar */}
      <div className="shrink-0 px-6 py-4 border-t border-white/[0.06] flex items-center gap-3">
        <button
          onClick={onToggle}
          className={[
            'flex-1 py-2 rounded-full text-sm font-medium transition-colors border',
            selected
              ? 'bg-orange-900/30 border-orange-700 text-orange-300 hover:bg-orange-900/50'
              : 'bg-gray-800 border-white/[0.08] text-gray-300 hover:bg-gray-700',
          ].join(' ')}
        >
          {selected ? '✓ Selected' : '+ Select'}
        </button>
        {job.job_url && (
          <button
            onClick={() => openUrl(job.job_url)}
            className="px-4 py-2 rounded-full text-sm text-gray-400 hover:text-gray-200 border border-white/[0.08] hover:border-white/[0.15] transition-colors"
          >
            Listing ↗
          </button>
        )}
        {job.apply_url && (
          <button
            onClick={() => openUrl(job.apply_url)}
            className="px-4 py-2 rounded-full text-sm text-gray-300 hover:text-white border border-white/[0.08] hover:border-white/[0.15] hover:bg-white/[0.06] transition-colors"
            title="Open the application form in browser (does not submit)"
          >
            Apply form ↗
          </button>
        )}
      </div>
    </div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function RatingScreen() {
  const [jobs, setJobs]         = useState<RatedJob[]>([])
  const [evalDone, setEvalDone]   = useState(0)   // jobs processed by the rater
  const [evalTotal, setEvalTotal] = useState(0)   // jobs in the pool (ever enqueued)
  const [done, setDone]         = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [detailJob, setDetailJob]   = useState<RatedJob | null>(null)
  // How many rated jobs were withheld because they have already been applied
  // to. The list itself never contains them -- main filters them out -- but a
  // list that silently shrinks between visits reads as data loss, so the count
  // is shown.
  const [hiddenApplied, setHiddenApplied] = useState(0)

  useEffect(() => {
    // Rehydrate cached rated jobs (back→forward shows existing without re-run);
    // when the background rater is mid-stream, progress carries the real
    // counters so the header is correct the moment the screen mounts.
    ipc.invoke<{ jobs: RatedJob[]; done: boolean; hiddenApplied?: number; progress?: { done: number; total: number } | null }>('rating:get-state')
      .then(s => {
        setHiddenApplied(s?.hiddenApplied ?? 0)
        if (s?.jobs?.length) {
          setJobs([...s.jobs])
          if (s.done) {
            setDone(true)
            setSelected(new Set(s.jobs.filter(j => j.rating >= 8).map(j => j.id)))
          }
        }
        if (s?.progress) {
          setEvalDone(s.progress.done)
          setEvalTotal(s.progress.total)
        }
      })
      .catch(() => { /* first run */ })

    const onProgress = (d: unknown) => {
      const data = d as { done: number; total: number; partialResults: RatedJob[] }
      setEvalDone(data.done)
      setEvalTotal(data.total)
      setJobs([...data.partialResults])
    }

    const onDone = (d: unknown) => {
      const data = d as { jobs: RatedJob[] }
      setJobs([...data.jobs])
      setDone(true)
      setSelected(new Set(data.jobs.filter(j => j.rating >= 8).map(j => j.id)))
    }

    const onCanceled = () => {
      // Reset apply-in-flight so user can retry
      setApplying(false)
    }

    ipc.on('rating:progress', onProgress)
    ipc.on('rating:done', onDone)
    ipc.on('pipeline:canceled', onCanceled)

    return () => {
      ipc.off('rating:progress', onProgress)
      ipc.off('rating:done', onDone)
      ipc.off('pipeline:canceled', onCanceled)
    }
  }, [])

  const pct = evalTotal ? Math.round((evalDone / evalTotal) * 100) : 0

  const toggle = (id: string) => setSelected(s => {
    const n = new Set(s)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  const apply = async (ids: string[]) => {
    setApplying(true)
    await ipc.invoke('selection:confirm', { jobIds: ids })
    ipc.invoke('pipeline:start-extract')
  }


  return (
    <div className="flex h-full w-full overflow-hidden min-w-0">

      {/* ── Left: job list ── */}
      <div className={[
        'flex flex-col h-full transition-all duration-200 min-w-0 overflow-hidden',
        detailJob ? 'w-[42%] min-w-[300px]' : 'flex-1',
      ].join(' ')}>

        {/* Sticky header */}
        <div className="shrink-0 px-6 pt-5 pb-3 border-b border-white/[0.06] bg-gray-950/95 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h2 className="text-xl font-semibold">
                {done ? 'Select Jobs to Apply' : 'Evaluating Matches'}
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {done
                  ? `${jobs.length} rated — ${selected.size} selected · click a card to preview`
                  : <>Evaluated <TickerNumber value={evalDone} />/{evalTotal} jobs · {jobs.length} rated · live-sorting</>}
              </p>
            </div>
            {!done && <span className="text-2xl font-display font-bold text-gray-300"><TickerNumber value={pct} />%</span>}

            {hiddenApplied > 0 && (
              <span className="text-xs text-gray-500">
                {hiddenApplied} already applied to, hidden
              </span>
            )}

            {done && jobs.length > 0 && (
              <div className="flex gap-2 flex-wrap justify-end">
                {selected.size > 0 && (
                  <button
                    onClick={() => setSelected(new Set())}
                    className="text-gray-400 hover:text-white px-3 py-1.5 rounded-full text-sm transition-colors bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08]"
                  >
                    Deselect All
                  </button>
                )}
                {/* Apply always renders so the user sees the affordance even when
                    nothing is selected yet — disabled until they pick at least one. */}
                <button
                  onClick={() => apply([...selected])}
                  disabled={applying || selected.size === 0}
                  className="bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-full text-sm font-medium transition-colors"
                  title={selected.size === 0 ? 'Pick at least one job to enable Apply' : `Apply to ${selected.size} selected job(s)`}
                >
                  Apply ({selected.size})
                </button>
                <button
                  onClick={() => apply(jobs.map(j => j.id))}
                  disabled={applying || jobs.length === 0}
                  className="bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-full text-sm font-medium transition-all"
                >
                  All ({jobs.length})
                </button>
              </div>
            )}
          </div>

          {!done && (
            <div className="bg-white/[0.06] rounded-full h-1.5">
              <div className="bg-purple-500 h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>

        {/* Job list */}
        <div className="flex-1 overflow-auto px-4 py-3 flex flex-col gap-1.5">
          {jobs.map((j, i) => {
            const isDetail   = detailJob?.id === j.id
            const isSelected = selected.has(j.id)
            return (
              <motion.div
                key={`${j.platform}:${j.job_id}`}
                layout="position"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
                onClick={() => setDetailJob(isDetail ? null : j)}
                className={[
                  'flex items-start gap-2.5 border rounded-2xl px-3 py-2.5 cursor-pointer transition-all select-none',
                  isDetail
                    ? 'border-orange-600 bg-orange-950/20 ring-1 ring-orange-700/40'
                    : isSelected
                    ? 'border-orange-800/40 bg-orange-950/10 hover:border-orange-600'
                    : 'border-white/[0.06] bg-[rgba(38,38,36,0.96)] hover:border-white/[0.12]',
                ].join(' ')}
              >
                {/* Checkbox */}
                {done && (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(j.id)}
                    onClick={e => e.stopPropagation()}
                    className="mt-1 accent-orange-500 shrink-0"
                  />
                )}

                {/* Rating badge — fixed-width column so 1-digit and 2-digit
                    ranks and scores line up down the list */}
                <div className="flex flex-col items-center gap-0.5 shrink-0 w-8">
                  <span className="text-[11px] tabular-nums text-gray-600">{i + 1}</span>
                  <span className={`w-7 text-center text-sm font-display font-bold tabular-nums border rounded-md py-0.5 ${ratingColor(j.rating)}`}>
                    {j.rating}
                  </span>
                </div>

                {/* Info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-100 truncate">{j.title}</p>
                  </div>
                  <p className="text-xs text-gray-500 truncate">
                    {j.company}
                    {j.location ? ` · ${j.location}` : ''}
                    {j.workplace_type ? ` · ${j.workplace_type}` : ''}
                  </p>
                  {!detailJob && (
                    <p className="text-xs text-gray-600 mt-0.5 line-clamp-1">{j.reason}</p>
                  )}
                </div>
              </motion.div>
            )
          })}

          {jobs.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-gray-600">
              <Spark size={22} className="text-purple-400" />
              <p className="text-sm">Rating first batch...</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Right: detail panel ── */}
      {detailJob && (
        <div className="flex-1 h-full overflow-hidden">
          <DetailPanel
            job={detailJob}
            selected={selected.has(detailJob.id)}
            onToggle={() => toggle(detailJob.id)}
            onClose={() => setDetailJob(null)}
          />
        </div>
      )}
    </div>
  )
}
