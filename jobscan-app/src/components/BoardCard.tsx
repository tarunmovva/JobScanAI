import { ipc } from '../ipc'
import { DEFECT_TAGS, type Defect } from '../../electron/board-tags'

export type Column = 'todo' | 'extracted' | 'applying' | 'done' | 'defect'

export interface Card {
  key: string
  platform: string
  jobId: string
  company: string
  title: string
  applyUrl: string
  column: Column
  defect?: Defect
  detail?: string
  needsYou?: string
  detailsPath?: string
  agentId?: string
  updatedAt: string
}

// Columns where a browser tab for this job is on screen right now, so clicking
// the card should raise that tab rather than open a second copy of the page.
// Columns where a browser tab for this job is on screen right now.
const LIVE: ReadonlySet<Column> = new Set<Column>(['applying'])

interface Props {
  card: Card
  onOpenRecord: (path: string) => void
}

export default function BoardCard({ card, onOpenRecord }: Props) {
  const needsYou = card.defect === 'needs_you'

  const activate = () => {
    // chrome:focus-tab already opens the posting itself when no tab matches,
    // so this must not also open it -- that is how you get two windows.
    const wantsTab = LIVE.has(card.column) || card.defect === 'needs_you'
    if (wantsTab && card.applyUrl) {
      ipc.invoke('chrome:focus-tab', card.applyUrl)
      return
    }
    if (card.detailsPath) { onOpenRecord(card.detailsPath); return }
    if (card.applyUrl) ipc.invoke('shell:open', card.applyUrl)
  }

  return (
    <button
      onClick={activate}
      title={card.title ? `${card.title} — ${card.company}` : card.company}
      className={[
        'w-full text-left rounded-md border px-2.5 py-2 transition-colors',
        needsYou
          ? 'border-orange-400/60 bg-orange-400/[0.07] hover:bg-orange-400/[0.12]'
          : 'border-white/[0.07] bg-gray-800/40 hover:bg-gray-800/70',
      ].join(' ')}
    >
      <p className={`text-[13px] leading-snug truncate ${needsYou ? 'text-orange-200' : 'text-gray-100'}`}>
        {card.company || card.jobId}
      </p>
      {card.title && (
        <p className="text-[11.5px] leading-snug text-gray-400 truncate mt-0.5">{card.title}</p>
      )}

      {/* Defects holds two different things. The tag says which, so the column
          does not have to be read as one undifferentiated pile of problems. */}
      {card.column === 'defect' && (
        <span className={[
          'inline-block mt-1.5 rounded px-1.5 py-0.5 text-[10px] leading-none border',
          needsYou
            ? 'border-orange-400/50 text-orange-300'
            : 'border-white/10 text-gray-400',
        ].join(' ')}>
          {DEFECT_TAGS.find(t => t.id === card.defect)?.label ?? 'Error'}
        </span>
      )}

      {/* The reason a card needs a person is the only thing on this board worth
          interrupting for, so it is stated in full rather than truncated. */}
      {needsYou && card.needsYou && (
        <p className="text-[11.5px] leading-snug text-orange-300/90 mt-1.5">{card.needsYou}</p>
      )}

      {/* Which half of 'applying' this is -- generating answers or filling --
          lives here now that the two share a column. */}
      {!needsYou && card.detail && card.column !== 'done' && (
        // A skipped card's reason is the whole point of the card -- why the
        // loop left it, and that it can still be done by hand -- so it is
        // never cut off.
        <p className={`text-[11px] leading-snug text-gray-500 mt-1 ${card.defect === 'skipped' ? '' : 'truncate'}`}>
          {card.detail}
        </p>
      )}

      {/* Mono is for real data only: the identifier you would paste into a
          search box, and which agent is holding the job. */}
      <p className="font-mono text-[10px] text-gray-600 mt-1.5 truncate">
        {card.platform}/{card.jobId}
        {card.agentId && card.agentId !== 'system' ? `  ${card.agentId}` : ''}
      </p>
    </button>
  )
}
