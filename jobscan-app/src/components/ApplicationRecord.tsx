import { useEffect, useState, type ReactNode } from 'react'
import { ipc } from '../ipc'

interface Props {
  path: string
  onClose: () => void
}

// Opens a file the record references (resume, cover letter). The main process
// re-checks the path against the job-automator home before opening anything.
function FileLink({ label, target }: { label: string; target: string }) {
  // Distinguish WHY it failed. 'file missing' was shown for every failure,
  // including a rejected IPC channel, which sent the diagnosis in exactly the
  // wrong direction -- the file was there the whole time.
  const [failure, setFailure] = useState<string | null>(null)
  return (
    <button
      type="button"
      title={failure ? `${target}
${failure}` : target}
      onClick={() => {
        // The writer encodes parentheses so they cannot terminate the link;
        // download filenames like "resume (4).pdf" contain them routinely.
        const real = target.replace(/%28/g, '(').replace(/%29/g, ')')
        setFailure(null)
        ipc.invoke<{ ok: boolean; error?: string }>('applied-jobs:open-file', { path: real })
          .then(r => { if (!r?.ok) setFailure(r?.error || 'could not open') })
          .catch(e => setFailure(String(e?.message || e) || 'could not open'))
      }}
      className={`underline underline-offset-2 ${failure
        ? 'text-amber-400'
        : 'text-purple-300 hover:text-purple-200'}`}
    >
      {failure ? `${label} — ${failure}` : label}
    </button>
  )
}

// Inline markup our generated records use: **bold** and [label](path) file
// links. Without link support a record's file reference rendered as literal
// markdown, which is why the resume and cover letter were not reachable.
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g

function inlineSpans(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  LINK_RE.lastIndex = 0
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last) out.push(...boldSpans(text.slice(last, m.index), `b-${last}`))
    out.push(<FileLink key={`l-${m.index}`} label={m[1]} target={m[2]} />)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(...boldSpans(text.slice(last), `b-${last}`))
  return out
}

function boldSpans(text: string, keyBase: string): ReactNode[] {
  return text.split('**').map((part, i) =>
    i % 2 === 1
      ? <strong key={`${keyBase}-${i}`} className="text-gray-100 font-medium">{part}</strong>
      : <span key={`${keyBase}-${i}`}>{part}</span>
  )
}

// Renders the app-generated application-record markdown subset as React
// elements (no dangerouslySetInnerHTML, no markdown dependency): the app
// writes these files itself, so only its own constructs need support.
function renderRecord(md: string): ReactNode[] {
  const out: ReactNode[] = []
  const lines = md.split('\n')
  let quote: string[] = []
  const flushQuote = (key: string) => {
    if (quote.length === 0) return
    out.push(
      <blockquote key={key} className="border-l-2 border-purple-700/60 bg-gray-900/50 rounded-r-lg px-3 py-2 my-1.5 text-[15px] font-display text-gray-300 whitespace-pre-wrap leading-relaxed">
        {quote.join('\n')}
      </blockquote>
    )
    quote = []
  }

  lines.forEach((line, i) => {
    if (line.startsWith('> ')) { quote.push(line.slice(2)); return }
    if (line.trim() === '>') { quote.push(''); return }
    flushQuote(`q-${i}`)

    if (line.startsWith('## ')) {
      out.push(<p key={i} className="text-xs text-gray-500 uppercase tracking-wide font-medium mt-4 mb-1">{line.slice(3)}</p>)
    } else if (line.startsWith('# ')) {
      out.push(<h2 key={i} className="text-lg font-semibold text-white">{line.slice(2)}</h2>)
    } else if (line.startsWith('- ')) {
      out.push(<p key={i} className="text-sm text-gray-300 pl-3">• {inlineSpans(line.slice(2))}</p>)
    } else if (line.trim() === '') {
      out.push(<div key={i} className="h-1.5" />)
    } else {
      out.push(<p key={i} className="text-sm text-gray-400 leading-relaxed">{inlineSpans(line)}</p>)
    }
  })
  flushQuote('q-end')
  return out
}

export default function ApplicationRecord({ path, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ipc.invoke<{ ok: boolean; content?: string; error?: string }>('applied-jobs:get-details', { path })
      .then(r => {
        if (r?.ok && r.content) setContent(r.content)
        else setError(r?.error ?? 'Could not load the record.')
      })
      .catch(() => setError('Could not load the record.'))
  }, [path])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    // Capture phase so the parent panel's Escape handler doesn't also fire.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[60] p-4"
      onClick={e => { e.stopPropagation(); onClose() }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="modal-in bg-[rgba(38,38,36,0.98)] border border-white/[0.08] rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl"
      >
        <div className="flex items-center justify-between px-6 pt-4 pb-3 border-b border-white/[0.06] shrink-0">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Application record</p>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none" aria-label="Close record">×</button>
        </div>
        <div className="flex-1 overflow-auto px-6 py-4">
          {error && <p className="text-sm text-amber-400">{error}</p>}
          {!error && content === null && (
            <p className="text-sm text-gray-500 animate-pulse">Loading…</p>
          )}
          {content !== null && renderRecord(content)}
        </div>
      </div>
    </div>
  )
}
