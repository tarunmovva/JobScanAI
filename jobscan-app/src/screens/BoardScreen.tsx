import { useEffect, useState } from 'react'
import { ipc } from '../ipc'
import BoardCard, { type Card, type Column } from '../components/BoardCard'
import ApplicationRecord from '../components/ApplicationRecord'
import TabLegend from '../components/TabLegend'
import DefectLegend from '../components/DefectLegend'

type Board = Record<string, Card>

// Five columns, left to right in the order work moves, so position alone says
// how far along a job is. The pipeline's finer states (extracting vs waiting to
// be picked, generating vs filling) are one thing each to a reader; the
// distinction stays on the card.
const COLUMNS: Array<{ id: Column; label: string; hint: string }> = [
  { id: 'todo',      label: 'To do',     hint: 'selected, not started' },
  { id: 'extracted', label: 'Extracted', hint: 'form read, waiting for an agent' },
  { id: 'applying',  label: 'Applying',  hint: 'answering and filling' },
  { id: 'done',      label: 'Done',      hint: 'submitted' },
  { id: 'defect',    label: 'Defects',   hint: 'needs you, or failed' },
]

function useBoard(): Board {
  const [board, setBoard] = useState<Board>({})

  useEffect(() => {
    let alive = true
    const refresh = () => {
      ipc.invoke<Board>('board:get-state')
        .then(b => { if (alive) setBoard(b ?? {}) })
        .catch(() => { /* the board is a view; a failed read is not fatal */ })
    }
    refresh()

    // The reducer runs in main and owns the state, so the renderer re-reads
    // rather than keeping a second copy that could disagree with it.
    const onEvent = () => refresh()
    for (const ch of ['extract:clear', 'extract:job', 'extract:start', 'payload:progress', 'board:seeded']) {
      ipc.on(ch, onEvent)
    }
    return () => {
      alive = false
      for (const ch of ['extract:clear', 'extract:job', 'extract:start', 'payload:progress', 'board:seeded']) {
        ipc.off(ch, onEvent)
      }
    }
  }, [])

  return board
}

function ColumnView({
  label, hint, cards, signal, onOpenRecord,
}: {
  label: string
  hint: string
  cards: Card[]
  signal: boolean
  onOpenRecord: (p: string) => void
}) {
  return (
    <div className="flex flex-col min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2 px-1 pb-2">
        <span className={`text-[12.5px] ${signal ? 'text-orange-300' : 'text-gray-300'}`} title={hint}>
          {label}
        </span>
        <span className="font-mono text-[11px] text-gray-500 tabular-nums">{cards.length}</span>
      </div>
      <div
        className={[
          'flex-1 min-h-0 overflow-y-auto rounded-lg border p-1.5 space-y-1.5',
          signal
            ? 'border-orange-400/25 bg-orange-400/[0.03]'
            : 'border-white/[0.05] bg-gray-900/40',
        ].join(' ')}
      >
        {cards.map(c => <BoardCard key={c.key} card={c} onOpenRecord={onOpenRecord} />)}
        {cards.length === 0 && (
          <p className="text-[11.5px] text-gray-600 px-1.5 py-1">—</p>
        )}
      </div>
    </div>
  )
}

export default function BoardScreen() {
  const board = useBoard()
  const [recordPath, setRecordPath] = useState<string | null>(null)

  const cards = Object.values(board)
  const byColumn = (c: Column) =>
    cards
      .filter(x => x.column === c)
      // Inside Defects, the cards asking for a person come first: they are the
      // only ones on the board that are waiting on the user rather than on us.
      .sort((a, b) =>
        (a.defect === 'needs_you' ? 0 : 1) - (b.defect === 'needs_you' ? 0 : 1)
        || b.updatedAt.localeCompare(a.updatedAt))

  const settled = byColumn('done').length + byColumn('defect').length
  const needsYou = cards.filter(c => c.defect === 'needs_you').length

  return (
    <div className="flex flex-col h-full p-6 gap-4 min-h-0">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-xl font-semibold text-gray-100">Applications</h2>
        <div className="flex items-baseline gap-4">
          {needsYou > 0 && (
            <p className="text-[12.5px] text-orange-300">
              {needsYou} waiting on you
            </p>
          )}
          <p className="font-mono text-[11.5px] text-gray-500 tabular-nums">
            {settled}/{cards.length} settled
          </p>
        </div>
      </div>

      <div className="flex gap-2.5 flex-1 min-h-0">
        {COLUMNS.map(c => (
          <ColumnView
            key={c.id}
            label={c.label}
            hint={c.hint}
            cards={byColumn(c.id)}
            signal={c.id === 'defect' && needsYou > 0}
            onOpenRecord={setRecordPath}
          />
        ))}
      </div>

      <div className="flex items-start gap-6">
        <TabLegend />
        <DefectLegend />
      </div>

      {recordPath && (
        <ApplicationRecord path={recordPath} onClose={() => setRecordPath(null)} />
      )}
    </div>
  )
}
