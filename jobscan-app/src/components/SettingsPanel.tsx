import { useEffect, useState, useRef } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import { ipc } from '../ipc'
import { profileDotColor } from '../profileColor'
import type { Settings, CodexModelOption, CodexUpdateStatus, ProfileInfo } from '../types'
import AppliedJobsPanel from './AppliedJobsPanel'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  onClose: () => void
}

async function handleLogout(onClose: () => void) {
  await ipc.invoke('auth:logout')
  onClose()
}

export default function SettingsPanel({ onClose }: Props) {
  const [s, setS] = useState<Partial<Settings>>({})
  const [saved, setSaved] = useState(false)
  const [imapInfo, setImapInfo] = useState<{ configured: boolean; host?: string; username?: string }>({ configured: false })
  const [models, setModels] = useState<CodexModelOption[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [codexUpdate, setCodexUpdate] = useState<CodexUpdateStatus | null>(null)
  const [checkingCodex, setCheckingCodex] = useState(false)
  const [engineMsg, setEngineMsg] = useState('')
  const [harness, setHarness] = useState<{ enabled: boolean; connected: boolean }>({ enabled: false, connected: false })
  const [harnessMsg, setHarnessMsg] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [profiles, setProfiles] = useState<ProfileInfo[]>([])
  const [activeProfileId, setActiveProfileId] = useState('')
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [newProfileName, setNewProfileName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<ProfileInfo | null>(null)
  const showHistoryRef = useRef(false)
  showHistoryRef.current = showHistory
  const deleteTargetRef = useRef<ProfileInfo | null>(null)
  deleteTargetRef.current = deleteTarget

  // Escape closes the panel (but only if no sub-modal is open — the History
  // panel handles its own Escape; the delete confirm closes itself first).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (deleteTargetRef.current) { setDeleteTarget(null); return }
      if (!showHistoryRef.current) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const loadProfiles = (): void => {
    ipc.invoke<{ profiles: ProfileInfo[]; activeId: string }>('profiles:list').then(r => {
      setProfiles(r?.profiles ?? [])
      setActiveProfileId(r?.activeId ?? '')
    }).catch(() => { /* ignore */ })
  }

  const createNewProfile = async (): Promise<void> => {
    const name = newProfileName.trim()
    if (!name) return
    await ipc.invoke('profiles:create', { name })
    setNewProfileName('')
    loadProfiles()
  }

  const saveRename = async (): Promise<void> => {
    if (!renameId || !renameVal.trim()) { setRenameId(null); return }
    await ipc.invoke('profiles:rename', { id: renameId, name: renameVal })
    setRenameId(null)
    loadProfiles()
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    await ipc.invoke('profiles:delete', { id: deleteTarget.id })
    setDeleteTarget(null)
    loadProfiles()
  }

  // Codex's model list and version: only while Codex is the engine (both
  // start Codex, which Claude mode never does).
  const aliveRef = useRef(true)
  const loadCodexInfo = (): void => {
    const alive = (): boolean => aliveRef.current
    ipc.invoke<CodexUpdateStatus>('codex:update-status')
      .then(r => { if (alive()) setCodexUpdate(r ?? null) })
      .catch(() => { /* version line just stays hidden */ })
    ipc.invoke<{ models: CodexModelOption[]; error: string | null; clearedModel?: string }>('codex:list-models')
      .then(r => {
        if (!alive()) return
        setModels(r?.models ?? [])
        setModelsLoaded(true)
        // The main process resets a saved model the API no longer offers —
        // mirror that here so the <select> doesn't keep showing the dead one.
        if (r?.clearedModel) setS(prev => ({ ...prev, codexModel: '' }))
      })
      .catch(() => { if (alive()) setModelsLoaded(true) })
  }

  useEffect(() => {
    aliveRef.current = true
    ipc.invoke<Settings>('settings:get').then(r => {
      if (!aliveRef.current) return
      setS(r)
      if (r?.aiEngine !== 'claude') loadCodexInfo()
    })
    ipc.invoke<{ configured: boolean; host?: string; username?: string }>('imap:get-config').then(setImapInfo)
    ipc.invoke<{ enabled: boolean; connected: boolean }>('harness:get-status')
      .then(r => { if (aliveRef.current && r) setHarness({ enabled: r.enabled, connected: r.connected }) })
      .catch(() => { /* switch shows off */ })
    loadProfiles()
    return () => { aliveRef.current = false }
  }, [])

  const engine = s.aiEngine ?? 'codex'
  const toggleHarness = async (enabled: boolean): Promise<void> => {
    setHarnessMsg('')
    const r = await ipc.invoke<{ ok: boolean; error?: string; enabled: boolean; connected: boolean }>('harness:set', { enabled })
    if (!r?.ok) setHarnessMsg(r?.error ?? 'Could not change this right now.')
    if (r) setHarness({ enabled: r.enabled, connected: r.connected })
  }
  const switchEngine = async (next: 'codex' | 'claude'): Promise<void> => {
    if (next === engine) return
    setEngineMsg('')
    const r = await ipc.invoke<{ ok: boolean; error?: string; ready?: boolean; claudeFound?: boolean }>('engine:set', { engine: next })
    if (!r?.ok) { setEngineMsg(r?.error ?? 'Could not switch right now.'); return }
    setS(prev => ({ ...prev, aiEngine: next, ...(next === 'claude' ? { claudeFound: r.claudeFound } : {}) }))
    if (next === 'claude') {
      setEngineMsg(r.claudeFound === false
        ? 'Claude Code was not found on this computer. Install it, or set its path under Paths.'
        : r.ready ? 'Claude Code is signed in.' : 'Claude Code is not signed in: run claude in a terminal, then /login.')
    } else {
      setEngineMsg(r.ready ? '' : 'Codex is not signed in.')
      loadCodexInfo()
    }
  }

  const save = async () => {
    await ipc.invoke('settings:save', s)
    setSaved(true)
    setTimeout(() => { setSaved(false); onClose() }, 800)
  }

  const field = (
    key: keyof Settings,
    label: string,
    type: 'text' | 'password' | 'number' = 'text',
    placeholder = ''
  ) => (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-400 font-medium">{label}</label>
      <input
        type={type}
        placeholder={placeholder}
        value={String(s[key] ?? '')}
        onChange={e =>
          setS(prev => ({
            ...prev,
            [key]: type === 'number' ? Math.max(1, Number(e.target.value)) : e.target.value,
          }))
        }
        className="bg-[rgba(35,34,32,0.92)] border border-white/[0.08] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500 placeholder-gray-600"
      />
    </div>
  )

  const storedModel = String(s.codexModel ?? '')
  const storedInList = storedModel === '' || models.some(m => m.id === storedModel)

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="modal-in bg-[rgba(38,38,36,0.96)] border border-white/[0.06] rounded-2xl p-6 w-full max-w-lg flex flex-col gap-4 max-h-[90vh] overflow-auto"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Settings</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">×</button>
        </div>

        <div className="flex flex-col gap-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Profiles</p>
          <div className="flex flex-col gap-1.5">
            {profiles.map(p => {
              const isActive = p.id === activeProfileId
              const isLast = profiles.length <= 1
              return (
                <div key={p.id} className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-gray-900/40 px-3 py-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: profileDotColor(p.id) }} />
                  {renameId === p.id ? (
                    <input
                      autoFocus
                      value={renameVal}
                      onChange={e => setRenameVal(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') void saveRename()
                        if (e.key === 'Escape') { e.stopPropagation(); setRenameId(null) }
                      }}
                      onBlur={() => void saveRename()}
                      className="flex-1 bg-gray-800 border border-white/[0.08] rounded px-2 py-1 text-sm focus:outline-none focus:border-orange-500"
                    />
                  ) : (
                    <span className="flex-1 text-sm text-gray-200 truncate">{p.name}</span>
                  )}
                  {isActive && <span className="text-xs text-orange-400 shrink-0">Active</span>}
                  <button
                    onClick={() => { setRenameId(p.id); setRenameVal(p.name) }}
                    aria-label={`Rename ${p.name}`}
                    className="text-xs text-gray-500 hover:text-gray-300 transition-colors shrink-0"
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => setDeleteTarget(p)}
                    disabled={isActive || isLast}
                    aria-label={`Delete ${p.name}`}
                    title={isActive ? 'Switch to another profile first' : isLast ? 'At least one profile is required' : undefined}
                    className="text-xs text-gray-500 hover:text-red-300 disabled:opacity-40 disabled:hover:text-gray-500 transition-colors shrink-0"
                  >
                    Delete
                  </button>
                </div>
              )
            })}
            <div className="flex items-center gap-2 mt-1">
              <input
                value={newProfileName}
                onChange={e => setNewProfileName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void createNewProfile() }}
                placeholder="New profile name…"
                className="flex-1 bg-[rgba(35,34,32,0.92)] border border-white/[0.08] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500 placeholder-gray-600"
              />
              <button
                onClick={() => void createNewProfile()}
                disabled={!newProfileName.trim()}
                className="px-3 py-2 rounded-full text-sm bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] disabled:opacity-40 transition-colors shrink-0"
              >
                Create profile
              </button>
            </div>
            <p className="text-xs text-gray-600">Starts empty — upload a resume and set preferences after switching. Nothing is shared between profiles.</p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">AI Configuration</p>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400 font-medium">AI engine</label>
            <div className="flex gap-2" role="group" aria-label="AI engine">
              {(['codex', 'claude'] as const).map(id => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={engine === id}
                  onClick={() => void switchEngine(id)}
                  className={[
                    'px-3 py-1.5 rounded-full text-sm border transition-colors',
                    engine === id
                      ? 'bg-orange-500/20 border-orange-500/50 text-orange-300'
                      : 'bg-white/[0.04] border-white/[0.08] text-gray-400 hover:bg-white/[0.08]',
                  ].join(' ')}
                >
                  {id === 'codex' ? 'ChatGPT (Codex)' : 'Your Claude Code'}
                </button>
              ))}
            </div>
            {engineMsg && <p className="text-xs text-gray-400">{engineMsg}</p>}
          </div>
          {engine === 'claude' && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400 font-medium" htmlFor="claude-model">Claude model</label>
              <input
                id="claude-model"
                list="claude-model-options"
                value={String(s.claudeModel ?? '')}
                placeholder="Default (Claude Code's own choice)"
                onChange={e => setS(prev => ({ ...prev, claudeModel: e.target.value }))}
                className="bg-[rgba(35,34,32,0.92)] border border-white/[0.08] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500 placeholder-gray-600"
              />
              <datalist id="claude-model-options">
                <option value="sonnet" />
                <option value="opus" />
                <option value="haiku" />
              </datalist>
              <p className="text-xs text-gray-500">
                Each AI call runs your own Claude Code once, with no tools and none of your settings.
                Form repair is off with this engine.
              </p>
              {s.claudeFound === false && (
                <p className="text-xs text-amber-400">Claude Code was not found. Install it, or set its path under Paths.</p>
              )}
            </div>
          )}
          {engine !== 'claude' && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400 font-medium">Codex Model</label>
            <select
              value={storedModel}
              onChange={e => setS(prev => ({ ...prev, codexModel: e.target.value }))}
              className="bg-[rgba(35,34,32,0.92)] border border-white/[0.08] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500 cursor-pointer"
            >
              <option value="">Auto (Codex default)</option>
              {/* Keep a stored value selectable/rendered even when it's not in
                  the fetched list (list unavailable, still loading, or stale
                  saved model) — a <select> whose value has no matching option
                  misrenders. */}
              {!storedInList && <option value={storedModel}>{storedModel} (saved)</option>}
              {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            {modelsLoaded && models.length === 0 && (
              <p className="text-xs text-amber-400">
                Model list unavailable — is Codex signed in? Auto and your saved choice still work.
              </p>
            )}
            {/* Which models appear above is decided by the Codex CLI, not by
                this app — an out-of-date CLI cannot decode the current model
                list and silently falls back to its own built-in one. */}
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-gray-500">
                Codex CLI {codexUpdate?.managedVersion ?? 'bundled'}
                {codexUpdate?.latestVersion && codexUpdate.latestVersion !== codexUpdate.managedVersion
                  ? ` — ${codexUpdate.latestVersion} available`
                  : ''}
              </span>
              <button
                type="button"
                disabled={checkingCodex}
                onClick={async () => {
                  setCheckingCodex(true)
                  try {
                    const r = await ipc.invoke<CodexUpdateStatus>('codex:check-update')
                    setCodexUpdate(r ?? null)
                    const list = await ipc.invoke<{ models: CodexModelOption[] }>('codex:list-models')
                    setModels(list?.models ?? [])
                  } finally { setCheckingCodex(false) }
                }}
                className="text-xs text-orange-400 hover:text-orange-300 disabled:text-gray-600 disabled:cursor-default"
              >
                {checkingCodex ? 'Updating…' : 'Check for update'}
              </button>
            </div>
            {codexUpdate && ['failed', 'downloading', 'health-checking', 'verifying', 'updated'].includes(codexUpdate.state) && (
              <p className={`text-xs ${codexUpdate.state === 'failed' ? 'text-amber-400' : 'text-gray-500'}`}>
                {codexUpdate.message}
              </p>
            )}
          </div>
          )}
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                id="harness-enabled"
                type="checkbox"
                checked={harness.enabled}
                onChange={e => void toggleHarness(e.target.checked)}
                className="accent-orange-500"
              />
              Let Claude Code drive JobScan
            </label>
            <p className="text-xs text-gray-500">
              A Claude Code session with the JobScan plugin can then rebuild, find jobs, rate them and stop the loop,
              and hears every step as it happens. It can never apply, change settings or open anything.
              {harness.enabled && (harness.connected ? ' Connected now.' : ' Waiting: run /jobscan:jobscan in Claude Code.')}
            </p>
            {harnessMsg && <p className="text-xs text-amber-400">{harnessMsg}</p>}
          </div>
          {field('ratingAgents', 'Rating Agents (parallel threads)', 'number')}
          {field('payloadAgents', 'Payload Agents (parallel threads)', 'number')}
        </div>

        <div className="flex flex-col gap-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Application Settings</p>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400 font-medium">OTP Email (IMAP)</label>
            {imapInfo.configured ? (
              <div className="flex items-center gap-2 text-sm">
                <Check size={14} className="text-green-400 shrink-0" />
                <span className="text-gray-300">{imapInfo.username}</span>
                <span className="text-gray-600 text-xs">via {imapInfo.host}</span>
                <button
                  onClick={onClose}
                  className="text-orange-400 hover:text-orange-300 text-xs ml-auto transition-colors"
                >
                  Reconfigure →
                </button>
              </div>
            ) : (
              <p className="flex items-center gap-1.5 text-xs text-amber-400">
                <AlertTriangle size={12} className="shrink-0" /> Not configured — set up in Resume &amp; Profile screen
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400 font-medium">Applied jobs</label>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500 text-xs">Everything submitted or failed so far.</span>
              <button
                onClick={() => setShowHistory(true)}
                className="text-orange-400 hover:text-orange-300 text-xs ml-auto transition-colors"
              >
                View history →
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Paths</p>
          {field('jobscanExePath', 'jobscan.exe path')}
          {field('pythonDir', 'Python package dir (JOB_AUTOMATOR_PYTHON_DIR)')}
          {field('jobAutomatorHome', 'Job automator home (JOB_AUTOMATOR_HOME)')}
          {engine === 'claude' && field('claudePath', 'Claude Code path (optional)', 'text', 'Found automatically when empty')}
        </div>

        <div className="flex gap-2 justify-between mt-2 pt-2 border-t border-white/[0.06]">
          {engine === 'claude' ? <span /> : <button
            onClick={() => handleLogout(onClose)}
            className="px-4 py-2 rounded-full bg-red-900/50 hover:bg-red-800 text-red-300 text-sm transition-colors"
            title="Sign out of ChatGPT and return to login screen"
          >
            Sign Out
          </button>}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-full bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-sm transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={save}
              className={[
                'px-4 py-2 rounded-full text-sm font-medium transition-colors',
                saved ? 'bg-green-600 text-white' : 'bg-orange-500 hover:bg-orange-600 text-white',
              ].join(' ')}
            >
              {saved ? '✓ Saved' : 'Save Settings'}
            </button>
          </div>
        </div>
      </div>
      {showHistory && <AppliedJobsPanel onClose={() => setShowHistory(false)} />}
      {deleteTarget && (
        <ConfirmDialog
          // Applied-job history is per profile (no cross-profile dedupe): it goes
          // with the profile, and nothing else remembers where it applied.
          message={`Delete profile "${deleteTarget.name}"? Its resume, answers, searches, ratings, OTP email and applied-job history `
            + `are removed, and this cannot be undone. History is kept per profile, so no other profile will know `
            + `which jobs "${deleteTarget.name}" already applied to.`}
          confirmLabel="Delete profile"
          cancelLabel="Keep profile"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
