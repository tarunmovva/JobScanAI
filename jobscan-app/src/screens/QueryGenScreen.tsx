import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { ipc } from '../ipc'
import Spark from '../components/Spark'
import TickerNumber from '../components/TickerNumber'

interface QueryCard {
  index: number
  state: 'generating' | 'valid' | 'invalid' | 'error'
  streaming: string
  name?: string
  flags?: string
  description?: string
  error?: string
  retrying?: boolean
  found?: number    // new unique jobs this query added to the pool
}

// Merged "Find Jobs" step: the AI writes queries one at a time; each query
// runs against the local DB the moment it validates, pooling unique results.
export default function QueryGenScreen() {
  const [cards, setCards]             = useState<QueryCard[]>([])
  const [done, setDone]               = useState(false)
  const [total, setTotal]             = useState(0)
  const [asking, setAsking]           = useState(false)
  const [askText, setAskText]         = useState('')
  const [expandedIndex, setExpanded]  = useState<number | null>(null)

  const upsert = (index: number, patch: Partial<QueryCard>) =>
    setCards(prev => {
      const next = [...prev]
      const i = next.findIndex(c => c.index === index)
      if (i === -1) next.push({ index, state: 'generating', streaming: '', ...patch })
      else next[i] = { ...next[i], ...patch }
      return next
    })

  useEffect(() => {
    // Rehydrate from store (so back→forward shows existing queries + pool without re-run)
    ipc.invoke<{
      cards: Array<{ index: number; query: { name: string; flags: string; description?: string }; found?: number }>
      done: boolean
      total: number
    }>('query_gen:get-state')
      .then(s => {
        if (s?.cards?.length) {
          setCards(s.cards.map(c => ({
            index: c.index,
            state: 'valid' as const,
            streaming: '',
            name: c.query.name,
            flags: c.query.flags,
            description: c.query.description ?? '',
            found: c.found,
          })))
        }
        if (s?.done) { setDone(true); setTotal(s.total ?? 0) }
      })
      .catch(() => { /* first run — no state yet */ })

    const onGenerating = (d: unknown) => {
      const { index } = d as { index: number }
      upsert(index, { state: 'generating', streaming: '', error: undefined })
    }
    const onStreaming = (d: unknown) => {
      const { index, text } = d as { index: number; text: string }
      upsert(index, { streaming: text })
    }
    const onValid = (d: unknown) => {
      const { index, query } = d as { index: number; query: { name: string; flags: string; description?: string } }
      upsert(index, { state: 'valid', name: query.name, flags: query.flags, description: query.description ?? '', streaming: '' })
    }
    const onSearched = (d: unknown) => {
      const { index, found, total: t } = d as { index: number; found: number; total: number }
      upsert(index, { found })
      setTotal(t)
    }
    const onInvalid = (d: unknown) => {
      const { index, error, retrying } = d as { index: number; error: string; retrying: boolean }
      upsert(index, { state: 'invalid', error, retrying, streaming: '' })
    }
    const onError = (d: unknown) => {
      const { index, error } = d as { index: number; error: string }
      upsert(index, { state: 'error', error, streaming: '' })
    }
    const onDone = (d: unknown) => {
      const { total: t } = (d ?? {}) as { total?: number }
      if (typeof t === 'number') setTotal(t)
      setDone(true)
      setAsking(false)
    }
    const onCanceled = () => {
      // Clear in-flight 'generating' cards so spinner stops; keep valid ones intact
      setCards(prev => prev.filter(c => c.state !== 'generating'))
      setAsking(false)
    }

    ipc.on('queryGen:generating', onGenerating)
    ipc.on('queryGen:streaming', onStreaming)
    ipc.on('queryGen:valid', onValid)
    ipc.on('queryGen:searched', onSearched)
    ipc.on('queryGen:invalid', onInvalid)
    ipc.on('queryGen:error', onError)
    ipc.on('queryGen:done', onDone)
    ipc.on('pipeline:canceled', onCanceled)

    return () => {
      ipc.off('queryGen:generating', onGenerating)
      ipc.off('queryGen:streaming', onStreaming)
      ipc.off('queryGen:valid', onValid)
      ipc.off('queryGen:searched', onSearched)
      ipc.off('queryGen:invalid', onInvalid)
      ipc.off('queryGen:error', onError)
      ipc.off('queryGen:done', onDone)
      ipc.off('pipeline:canceled', onCanceled)
    }
  }, [])

  const askForMore = (): void => {
    const prompt = askText.trim()
    if (!prompt || asking) return
    setAsking(true)
    setDone(false)
    setAskText('')
    void ipc.invoke('pipeline:add-user-queries', { prompt })
  }

  const validCount = cards.filter(c => c.state === 'valid').length

  return (
    <div className="p-8 max-w-2xl mx-auto flex flex-col gap-4">
      <h2 className="text-2xl font-semibold">Find Matching Jobs</h2>
      <p className="text-gray-400 text-sm">
        AI writes search queries and runs each one immediately — results pool up as they land.
        {done && ' Click any query to see full details.'}
      </p>

      <div className="flex flex-col gap-2.5">
        {cards.filter(card => !(done && card.state === 'generating')).map(card => {
          const isExpanded = expandedIndex === card.index
          const isValid    = card.state === 'valid'

          return (
            <motion.div key={card.index}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className={[
                'border rounded-2xl transition-all',
                isValid    ? 'border-green-800 bg-green-950/30' :
                card.state === 'invalid' ? 'border-yellow-800 bg-yellow-950/20' :
                card.state === 'error'   ? 'border-red-800 bg-red-950/20' :
                'border-white/[0.08] bg-gray-900/50',
              ].join(' ')}>

              {/* Clickable header row */}
              <div
                className={['flex items-center gap-2 px-4 py-3', isValid ? 'cursor-pointer select-none' : ''].join(' ')}
                onClick={() => isValid && setExpanded(isExpanded ? null : card.index)}
              >
                <span className="w-6 text-right text-[11px] tabular-nums font-medium text-gray-600 shrink-0">{card.index + 1}</span>

                {isValid && (
                  <>
                    <Check size={13} className="text-green-400 shrink-0" />
                    <span className="text-sm text-gray-200 flex-1 truncate">
                      {card.name?.replace(/_/g, ' ')}
                    </span>
                    {card.found !== undefined ? (
                      <span className={['text-xs font-medium shrink-0 tabular-nums',
                        card.found > 0 ? 'text-green-400' : 'text-gray-600'].join(' ')}>
                        +<TickerNumber value={card.found} /> new
                      </span>
                    ) : (
                      <Spark size={12} className="text-orange-400 shrink-0" />
                    )}
                    <span className="text-gray-600 shrink-0 ml-1">{isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                  </>
                )}

                {card.state === 'invalid' && (
                  <>
                    <AlertTriangle size={13} className="text-yellow-400 shrink-0" />
                    <span className="text-xs text-yellow-400">
                      {card.retrying ? 'Validation failed — retrying...' : 'Validation failed'}
                    </span>
                  </>
                )}

                {card.state === 'error' && (
                  <span className="text-xs text-red-400">Error: {card.error?.slice(0, 60)}</span>
                )}

                {card.state === 'generating' && (
                  <div className="flex gap-1.5 items-center">
                    <Spark size={14} />
                    <span className="text-xs text-gray-500">Generating...</span>
                  </div>
                )}
              </div>

              {/* Streaming preview — tail-anchored so the newest text is
                  always visible, with a soft fade at the top and a live
                  caret, like watching the model type */}
              {card.state === 'generating' && card.streaming && (
                <div className="px-4 pb-3">
                  <div className="relative rounded-xl bg-gray-950/50 border border-white/[0.04] px-3.5 py-2.5 max-h-28 overflow-hidden flex flex-col-reverse">
                    <pre className="text-xs text-gray-500 font-mono whitespace-pre-wrap leading-relaxed">
                      {card.streaming}
                      <span className="inline-block w-[7px] h-3 ml-1 bg-orange-400/80 rounded-[1px] align-middle animate-pulse" />
                    </pre>
                    <div className="absolute top-0 inset-x-0 h-8 bg-gradient-to-b from-[rgba(31,30,29,0.95)] to-transparent pointer-events-none" />
                  </div>
                </div>
              )}

              {/* Collapsed flags preview (valid, not expanded) */}
              {isValid && !isExpanded && card.flags && (
                <div className="px-4 pb-3 -mt-1">
                  <p className="text-xs text-gray-600 font-mono truncate">{card.flags}</p>
                </div>
              )}

              {/* Expanded detail */}
              {isValid && isExpanded && (
                <div className="px-4 pb-4 flex flex-col gap-3 border-t border-green-900/40 mt-0 pt-3">
                  {card.description && (
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Intent</p>
                      <p className="text-[15px] font-display text-gray-300 leading-relaxed">{card.description}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Full Query</p>
                    <pre className="text-xs text-green-300 font-mono bg-gray-950 border border-white/[0.06] rounded-xl p-3 whitespace-pre-wrap break-all select-all">
                      jobscan search {card.flags}
                    </pre>
                  </div>
                </div>
              )}

              {/* Validation error */}
              {card.state === 'invalid' && card.error && (
                <div className="px-4 pb-3 -mt-1">
                  <p className="text-xs text-yellow-600">{card.error.slice(0, 120)}</p>
                </div>
              )}
            </motion.div>
          )
        })}
      </div>

      {/* Done footer — pool total + Evaluate */}
      {done && (
        <div className="flex items-center gap-4 mt-2">
          <div>
            <p className="text-white font-medium"><TickerNumber value={total} className="font-display text-lg" /> unique candidates found</p>
            <p className="text-gray-500 text-xs">
              {total === 0
                ? 'No candidates found — ask for more below with a broader request.'
                : `${validCount} ${validCount === 1 ? 'query' : 'queries'} · AI will rate each candidate against your resume`}
            </p>
          </div>
          <button
            onClick={() => ipc.invoke('pipeline:start-rating')}
            disabled={total === 0}
            className="ml-auto bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white px-5 py-2.5 rounded-full font-medium transition-colors shrink-0"
          >
            Evaluate Matches →
          </button>
        </div>
      )}

      {/* Find-more ask box */}
      {done && (
        <div className="flex flex-col gap-1.5 mt-1 pt-4 border-t border-white/[0.06]">
          <div className="flex items-center gap-2">
            <input
              value={askText}
              onChange={e => setAskText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') askForMore() }}
              disabled={asking}
              placeholder='Ask for more — e.g. "also find ML infra roles in Austin"'
              className="flex-1 bg-[rgba(35,34,32,0.92)] border border-white/[0.08] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500 placeholder-gray-600 disabled:opacity-50"
            />
            <button
              onClick={askForMore}
              disabled={asking || !askText.trim()}
              className="px-4 py-2 rounded-full text-sm font-medium bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-gray-300 hover:text-white disabled:opacity-40 transition-colors shrink-0"
            >
              Find more →
            </button>
          </div>
          <p className="text-xs text-gray-600">Targeted queries are added to the pool — duplicates are filtered automatically.</p>
        </div>
      )}

      {!done && !asking && cards.length === 0 && (
        <div className="flex gap-1 items-center text-gray-500 text-sm">
          <span className="animate-pulse">Starting...</span>
        </div>
      )}
    </div>
  )
}
