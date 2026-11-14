import { useEffect, useState } from 'react'
import { Asterisk } from 'lucide-react'
import { ipc } from '../ipc'
import Spark from '../components/Spark'

type Status = 'checking' | 'idle' | 'waiting' | 'error'
type Engine = 'codex' | 'claude'

interface AuthStatus { loggedIn: boolean; engine?: Engine; claudeFound?: boolean; codexFound?: boolean }

export default function AuthScreen() {
  const [status, setStatus] = useState<Status>('checking')
  const [error, setError] = useState('')
  const [engine, setEngine] = useState<Engine>('codex')
  const [claudeFound, setClaudeFound] = useState(true)
  const [codexFound, setCodexFound] = useState(true)

  // auth:status auto-advances to Resume when the engine is signed in.
  const check = (): void => {
    setStatus('checking')
    ipc.invoke<AuthStatus>('auth:status').then(r => {
      setEngine(r?.engine === 'claude' ? 'claude' : 'codex')
      setClaudeFound(r?.claudeFound !== false)
      setCodexFound(r?.codexFound !== false)
      if (!r?.loggedIn) setStatus('idle')
      // If logged in: auth:status handler calls setState('resume') → App.tsx transitions
    }).catch(() => setStatus('idle'))
  }

  useEffect(check, [])

  const login = async () => {
    setStatus('waiting')
    setError('')
    try {
      const result = await ipc.invoke<{ success: boolean; message?: string }>('auth:login')
      if (!result?.success) {
        setError(result?.message ?? 'Login failed. Try again.')
        setStatus('idle')
      }
      // On success: main process calls setState('resume') which emits state:change → App.tsx transitions
    } catch (e) {
      setError(String(e))
      setStatus('idle')
    }
  }

  const switchTo = async (next: Engine) => {
    setError('')
    const r = await ipc.invoke<{ ok: boolean; error?: string }>('engine:set', { engine: next })
    if (!r?.ok) { setError(r?.error ?? 'Could not switch right now.'); return }
    check()
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 p-8">
      <div className="w-20 h-20 rounded-full bg-orange-500/15 border border-orange-500/30 shadow-[0_0_40px_rgba(217,119,87,0.25)] flex items-center justify-center">
        <Asterisk size={44} strokeWidth={2} className="text-orange-400" />
      </div>
      <h1 className="text-4xl font-display font-semibold tracking-tight">JobScan AI</h1>
      <p className="text-gray-400 text-center max-w-md">
        Find jobs, rate matches with AI, and apply automatically.
      </p>

      {status === 'checking' && (
        <p className="text-gray-500 animate-pulse text-sm">Checking login status...</p>
      )}

      {engine === 'codex' && status === 'waiting' && (
        <div className="flex flex-col items-center gap-2 text-center">
          <Spark size={22} />
          <p className="text-orange-400 text-sm">Browser opened — sign in with ChatGPT there</p>
          <p className="text-gray-600 text-xs">Return here once you're signed in</p>
        </div>
      )}

      {engine === 'codex' && status === 'idle' && !codexFound && (
        <div className="flex flex-col items-center gap-3 text-center max-w-md">
          <p className="text-gray-300 text-sm">The Codex CLI was not found on this computer.</p>
          <p className="text-gray-500 text-sm">
            Install it with <code className="text-orange-300">npm install -g @openai/codex</code>, then check again.
          </p>
          <button
            onClick={check}
            className="bg-orange-500 hover:bg-orange-600 text-white px-8 py-3 rounded-full font-medium transition-all"
          >
            Check again
          </button>
        </div>
      )}

      {engine === 'codex' && status === 'idle' && codexFound && (
        <button
          onClick={login}
          className="bg-orange-500 hover:bg-orange-600 text-white px-8 py-3 rounded-full font-medium transition-all"
        >
          Login with ChatGPT →
        </button>
      )}

      {engine === 'claude' && status === 'idle' && (
        <div className="flex flex-col items-center gap-3 text-center max-w-md">
          {claudeFound ? (
            <>
              <p className="text-gray-300 text-sm">Claude Code is not signed in on this computer.</p>
              <p className="text-gray-500 text-sm">
                Open a terminal, run <code className="text-orange-300">claude</code>, then type{' '}
                <code className="text-orange-300">/login</code>. Come back here when you are done.
              </p>
            </>
          ) : (
            <>
              <p className="text-gray-300 text-sm">Claude Code was not found on this computer.</p>
              <p className="text-gray-500 text-sm">
                Install Claude Code, sign in once, then check again. If it is installed somewhere
                unusual, set its path in Settings.
              </p>
            </>
          )}
          <button
            onClick={check}
            className="bg-orange-500 hover:bg-orange-600 text-white px-8 py-3 rounded-full font-medium transition-all"
          >
            Check again
          </button>
        </div>
      )}

      {error && (
        <p className="text-red-400 text-sm text-center max-w-sm">{error}</p>
      )}

      {engine === 'codex' ? (
        <p className="text-xs text-gray-600 text-center max-w-xs">
          Uses your ChatGPT Plus or Pro account. No API key needed.
        </p>
      ) : (
        <p className="text-xs text-gray-600 text-center max-w-xs">
          Uses your own Claude Code and its plan. Each AI call runs it once, with no tools.
        </p>
      )}

      {status !== 'checking' && status !== 'waiting' && (
        <button
          onClick={() => void switchTo(engine === 'codex' ? 'claude' : 'codex')}
          className="text-xs text-orange-400 hover:text-orange-300 transition-colors"
        >
          {engine === 'codex' ? 'Use your Claude Code instead' : 'Use ChatGPT (Codex) instead'}
        </button>
      )}
    </div>
  )
}
