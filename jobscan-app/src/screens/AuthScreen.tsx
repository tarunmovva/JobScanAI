import { useEffect, useState } from 'react'
import { Asterisk } from 'lucide-react'
import { ipc } from '../ipc'
import Spark from '../components/Spark'

type Status = 'checking' | 'idle' | 'waiting' | 'error'

export default function AuthScreen() {
  const [status, setStatus] = useState<Status>('checking')
  const [error, setError] = useState('')

  useEffect(() => {
    // Check if already logged in — auth:status handler auto-advances state if true
    ipc.invoke<{ loggedIn: boolean }>('auth:status').then(r => {
      if (!r?.loggedIn) {
        setStatus('idle')  // Not logged in — show login button
      }
      // If logged in: auth:status handler calls setState('resume') → App.tsx transitions
      // setStatus stays 'checking' briefly then App unmounts this screen
    }).catch(() => setStatus('idle'))
  }, [])

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

      {status === 'waiting' && (
        <div className="flex flex-col items-center gap-2 text-center">
          <Spark size={22} />
          <p className="text-orange-400 text-sm">Browser opened — sign in with ChatGPT there</p>
          <p className="text-gray-600 text-xs">Return here once you're signed in</p>
        </div>
      )}

      {status === 'idle' && (
        <button
          onClick={login}
          className="bg-orange-500 hover:bg-orange-600 text-white px-8 py-3 rounded-full font-medium transition-all"
        >
          Login with ChatGPT →
        </button>
      )}

      {error && (
        <p className="text-red-400 text-sm text-center max-w-sm">{error}</p>
      )}

      <p className="text-xs text-gray-600 text-center max-w-xs">
        Uses your ChatGPT Plus or Pro account. No API key needed.
      </p>
    </div>
  )
}
