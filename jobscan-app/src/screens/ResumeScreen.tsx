import { useState, useCallback, useEffect } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, FileText, FolderOpen } from 'lucide-react'
import { ipc } from '../ipc'

const SPONSORSHIP_OPTIONS = [
  { value: 'no-sponsorship',      label: 'Does not need sponsorship — fully authorized' },
  { value: 'future-sponsorship',  label: 'Might require sponsorship in the future (e.g. OPT → H1B)' },
  { value: 'need-sponsorship',    label: 'Needs sponsorship now' },
]

const CLEARANCE_OPTIONS = [
  { value: 'yes',          label: 'Yes — I hold an active security clearance' },
  { value: 'no-eligible',  label: 'No — but I am eligible to apply for clearance' },
  { value: 'no-ineligible',label: 'No — and I am not eligible / do not want clearance jobs' },
]

const IMAP_PRESETS: Record<string, { host: string; port: number }> = {
  gmail:   { host: 'imap.gmail.com',        port: 993 },
  outlook: { host: 'imap-mail.outlook.com', port: 993 },
  yahoo:   { host: 'imap.mail.yahoo.com',   port: 993 },
  icloud:  { host: 'imap.mail.me.com',      port: 993 },
  custom:  { host: '',                       port: 993 },
}

const inp = 'bg-[rgba(35,34,32,0.92)] border border-white/[0.08] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500 placeholder-gray-600 w-full'
const sel = inp + ' cursor-pointer'

export default function ResumeScreen() {
  const [filename, setFilename]       = useState('')
  const [, setPreview]                 = useState('')
  const [dragging, setDragging]       = useState(false)
  const [loading, setLoading]         = useState(false)
  const [fetchAge, setFetchAge]       = useState<number | null>(null)

  // Profile state
  const [locations, setLocations]           = useState('')
  const [visaSituation, setVisaSituation]   = useState('')
  const [citizenship, setCitizenship]       = useState('')
  const [sponsorship, setSponsorship]       = useState('')
  const [clearance, setClearance]           = useState('')
  const [salary, setSalary]                 = useState('')
  const [searchInstructions, setSearchInstructions] = useState('')
  const [eeoGender, setEeoGender]           = useState('')
  const [eeoRace, setEeoRace]               = useState('')
  const [eeoVeteran, setEeoVeteran]         = useState('')
  const [eeoDisability, setEeoDisability]   = useState('')
  const [generateCoverLetter, setGenerateCoverLetter] = useState(false)
  const [showEeo, setShowEeo]               = useState(true)

  const [imapConfigured, setImapConfigured] = useState(false)
  const [imapUsername, setImapUsername]     = useState('')
  const [imapPassword, setImapPassword]     = useState('')
  const [imapHost, setImapHost]             = useState('imap.gmail.com')
  const [imapPort, setImapPort]             = useState(993)
  const [imapProvider, setImapProvider]     = useState('gmail')
  const [imapTesting, setImapTesting]       = useState(false)
  const [imapTestResult, setImapTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [showImapForm, setShowImapForm]     = useState(false)

  useEffect(() => {
    // Check if job data is stale (> 2h since last fetch)
    ipc.invoke<{ needsFetch: boolean; ageMinutes: number }>('fetch:check').then(r => {
      if (r?.needsFetch) setFetchAge(r.ageMinutes)
    })

    // Restore saved resume filename so button stays enabled across sessions
    ipc.invoke<{ resumePath?: string }>('settings:get').then(s => {
      if (s.resumePath) {
        const name = s.resumePath.split(/[\\/]/).pop() ?? s.resumePath
        setFilename(name)
      }
    })
    // Restore saved profile fields
    ipc.invoke<Record<string, string | boolean>>('profile:get').then(p => {
      if (p.targetLocations)  setLocations(String(p.targetLocations))
      if (p.visaSituation)    setVisaSituation(String(p.visaSituation))
      if (p.citizenship)      setCitizenship(String(p.citizenship))
      if (p.sponsorshipNeed)  setSponsorship(String(p.sponsorshipNeed))
      if (p.clearance)        setClearance(String(p.clearance))
      if (p.salaryExpectation) setSalary(String(p.salaryExpectation))
      if (p.searchInstructions) setSearchInstructions(String(p.searchInstructions))
      if (p.eeoGender)        setEeoGender(String(p.eeoGender))
      if (p.eeoRace)          setEeoRace(String(p.eeoRace))
      if (p.eeoVeteran)       setEeoVeteran(String(p.eeoVeteran))
      if (p.eeoDisability)    setEeoDisability(String(p.eeoDisability))
      // Unconditional, unlike the strings above: a saved false must be able
      // to overwrite a stale true.
      setGenerateCoverLetter(Boolean(p.generateCoverLetter))
    })
    ipc.invoke<{ configured: boolean; host?: string; username?: string }>('imap:get-config').then(r => {
      if (r?.configured) {
        setImapConfigured(true)
        setImapHost(r.host || 'imap.gmail.com')
        setImapUsername(r.username || '')
      } else {
        setShowImapForm(true)
      }
    })
  }, [])

  const handleFile = useCallback(async (filePath: string, name: string) => {
    setLoading(true)
    try {
      const result = await ipc.invoke<{ text: string; filename: string }>('resume:upload', { filePath })
      setFilename(result.filename || name)
      setPreview(result.text.slice(0, 500) + (result.text.length > 500 ? '...' : ''))
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile((file as File & { path: string }).path, file.name)
  }, [handleFile])

  const browse = useCallback(async () => {
    const fp = await ipc.invoke<string | null>('resume:browse')
    if (fp) handleFile(fp, fp.split(/[\\/]/).pop() ?? fp)
  }, [handleFile])

  const testImap = async () => {
    setImapTesting(true)
    setImapTestResult(null)
    const result = await ipc.invoke<{ ok: boolean; error?: string }>('imap:test-connection', {
      host: imapHost, port: imapPort, username: imapUsername, password: imapPassword,
    })
    setImapTestResult(result)
    setImapTesting(false)
    if (result.ok) {
      await ipc.invoke('imap:save-config', {
        host: imapHost, port: imapPort, username: imapUsername, password: imapPassword,
      })
      setImapConfigured(true)
      setShowImapForm(false)
    }
  }

  const canStart = !!filename && locations.trim().length > 0

  const start = async () => {
    // Save profile — don't block pipeline on failure
    try {
      await ipc.invoke('profile:save', {
        targetLocations:    locations.trim(),
        visaSituation:      visaSituation.trim(),
        citizenship:        citizenship.trim(),
        sponsorshipNeed:    sponsorship,
        clearance,
        salaryExpectation:  salary.trim(),
        searchInstructions: searchInstructions.trim(),
        eeoGender, eeoRace, eeoVeteran, eeoDisability,
        generateCoverLetter,
      })
    } catch (e) {
      console.error('[profile:save]', e)
    }
    ipc.invoke('pipeline:start-query-gen')
  }

  return (
    <div className="p-8 max-w-2xl mx-auto flex flex-col gap-6 pb-16">
      <h2 className="text-2xl font-semibold">Resume & Profile</h2>

      {/* ── Fetch staleness banner ── */}
      {fetchAge !== null && (
        <div className="flex items-center justify-between gap-4 bg-amber-950/40 border border-amber-700/60 rounded-2xl px-5 py-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-amber-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-amber-300 font-medium text-sm">
                {!isFinite(fetchAge)
                  ? 'Job database has never been built'
                  : `Job listings are ${fetchAge < 120 ? `${fetchAge}m` : `${Math.round(fetchAge / 60)}h`} old`}
              </p>
              <p className="text-amber-700 text-xs mt-0.5">
                {!isFinite(fetchAge)
                  ? 'Run the database rebuild before your first search to populate listings.'
                  : 'Rebuild the database before searching to surface the most recent openings.'}
              </p>
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => setFetchAge(null)}
              className="text-xs text-gray-500 hover:text-gray-300 px-3 py-1.5 rounded-full transition-colors"
            >
              Skip
            </button>
            <button
              onClick={() => ipc.invoke('fetch:start')}
              className="bg-amber-700 hover:bg-amber-600 text-white text-xs px-4 py-1.5 rounded-full font-medium transition-colors"
            >
              Rebuild DB →
            </button>
          </div>
        </div>
      )}

      {/* ── Resume ── */}
      <div
        onDrop={onDrop}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        className={['border-2 border-dashed rounded-2xl p-8 text-center transition-all',
          dragging
            ? 'border-orange-500 bg-orange-900/10 shadow-[0_0_28px_rgba(217,119,87,0.18)]'
            : 'border-white/[0.08] hover:border-white/[0.14]'].join(' ')}
      >
        {loading
          ? <p className="text-orange-400 animate-pulse text-sm">Parsing resume...</p>
          : filename
            ? <div className="flex flex-col items-center gap-1">
                <FileText size={26} className="text-green-400/90" />
                <p className="text-green-400 font-medium text-sm">{filename}</p>
                <p className="text-gray-600 text-xs">Drop another to replace</p>
              </div>
            : <div className="flex flex-col items-center gap-2">
                <FolderOpen size={26} className="text-orange-300/80" />
                <p className="text-gray-400 text-sm">Drag & drop your PDF or TXT resume</p>
              </div>}
      </div>
      <button onClick={browse} disabled={loading}
        className="flex items-center gap-1.5 bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] disabled:opacity-50 text-white px-4 py-2 rounded-full text-sm self-start transition-colors">
        <FolderOpen size={14} />Choose File…
      </button>

      <div className="h-px bg-white/[0.06]" />

      {/* ── Location — required ── */}
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium">
          Target Locations <span className="text-red-400">*</span>
        </label>
        <p className="text-xs text-gray-500">Cities, countries, remote preference. LLM uses this to generate precise search queries.</p>
        <input
          value={locations} onChange={e => setLocations(e.target.value)}
          placeholder='e.g. "Austin TX or Remote US" · "New York or San Francisco" · "Europe, remote-first"'
          className={inp}
        />
      </div>

      {/* ── Search Instructions ── */}
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium">Search Instructions
          <span className="text-gray-500 font-normal text-xs ml-2">(optional)</span>
        </label>
        <p className="text-xs text-gray-500">
          Tell the AI what to prioritize, target, or avoid when generating search queries for you.
        </p>
        <textarea
          value={searchInstructions} onChange={e => setSearchInstructions(e.target.value)}
          rows={3}
          placeholder={'e.g. "Find jobs posted this week only" · "Focus on West Coast + Remote" · "Don\'t miss Stripe, Anthropic, Databricks" · "No enterprise SaaS companies"'}
          className={inp + ' resize-none'}
        />
      </div>

      {/* ── Visa Situation — free text ── */}
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium">Your Visa / Work Authorization Situation
          <span className="text-gray-500 font-normal text-xs ml-2">(optional)</span>
        </label>
        <p className="text-xs text-gray-500">Describe your situation for the locations above. Used to answer work-auth questions in forms.</p>
        <textarea
          value={visaSituation} onChange={e => setVisaSituation(e.target.value)}
          rows={2}
          placeholder='e.g. "US citizen, no restrictions" · "On OPT in the US, eligible for H1B" · "EU citizen, work permit for Germany"'
          className={inp + ' resize-none'}
        />
      </div>

      {/* ── Citizenship — asked separately from work authorization ──
           Forms ask these as different questions, often for export-control or
           legal compliance. Being authorized to work says nothing about which
           country you are a citizen of, and guessing one from the other puts a
           wrong answer on a legal-compliance field. */}
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium">Citizenship
          <span className="text-gray-500 font-normal text-xs ml-2">(optional)</span>
        </label>
        <p className="text-xs text-gray-500">The country (or countries) you hold citizenship of. Asked by some employers for legal compliance — left blank, those questions get a guess.</p>
        <input
          value={citizenship} onChange={e => setCitizenship(e.target.value)}
          placeholder='e.g. "United States" · "Canada" · "Germany, permanent resident of the US"'
          className={inp}
        />
      </div>

      {/* ── Sponsorship need ── */}
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium">Sponsorship Requirement
          <span className="text-gray-500 font-normal text-xs ml-2">(optional — defaults to no sponsorship needed)</span>
        </label>
        <select value={sponsorship} onChange={e => setSponsorship(e.target.value)} className={sel}>
          <option value="">Select…</option>
          {SPONSORSHIP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {/* ── Security Clearance ── */}
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium">Security Clearance
          <span className="text-gray-500 font-normal text-xs ml-2">(optional)</span>
        </label>
        <p className="text-xs text-gray-500">Used to answer clearance questions in job forms. If no clearance, sets eligibility answer.</p>
        <select value={clearance} onChange={e => setClearance(e.target.value)} className={sel}>
          <option value="">Select…</option>
          {CLEARANCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {/* ── Cover letter ── */}
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
          <input type="checkbox" checked={generateCoverLetter}
            onChange={e => setGenerateCoverLetter(e.target.checked)}
            className="accent-white/80" />
          Write a cover letter for each application
        </label>
        <p className="text-xs text-gray-500 pl-6">
          Generates a letter from your resume and the job description, then fills every
          cover-letter field on the form &mdash; including optional ones. Uploaded as a PDF
          where the form takes a file, typed in where it takes text. Off by default.
        </p>
      </div>

      <div className="h-px bg-white/[0.06]" />

      {/* ── Email for OTP Verification ── */}
      <div className="flex flex-col gap-3">
        <button
          onClick={() => setShowImapForm(v => !v)}
          className="flex items-center gap-2 text-sm self-start"
        >
          <span className={imapConfigured ? 'text-green-400' : 'text-amber-400'}>
            {imapConfigured ? '✓' : '⚠'}
          </span>
          <span className="font-medium">Email for OTP Verification</span>
          <span className="text-gray-500 text-xs">
            {imapConfigured ? `Connected · ${imapUsername}` : 'Not set up — required for Greenhouse'}
          </span>
          <span className="text-gray-600">{showImapForm ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        </button>

        {showImapForm && (
          <div className="flex flex-col gap-3 pl-4 border-l border-white/[0.06]">
            <p className="text-xs text-gray-500">
              Used to auto-read OTP codes Greenhouse sends to your inbox.
              For Gmail: enable IMAP in Gmail settings, then create an App Password at
              <span className="text-orange-400 ml-1">myaccount.google.com/apppasswords</span>.
            </p>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Email Provider</label>
              <select
                value={imapProvider}
                onChange={e => {
                  const p = e.target.value
                  setImapProvider(p)
                  const preset = IMAP_PRESETS[p]
                  if (preset.host) { setImapHost(preset.host); setImapPort(preset.port) }
                }}
                className={sel}
              >
                <option value="gmail">Gmail</option>
                <option value="outlook">Outlook / Hotmail</option>
                <option value="yahoo">Yahoo Mail</option>
                <option value="icloud">iCloud Mail</option>
                <option value="custom">Custom / Other</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Email Address</label>
              <input
                value={imapUsername} onChange={e => setImapUsername(e.target.value)}
                placeholder="you@gmail.com"
                className={inp}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">
                App Password
                <span className="text-gray-500 font-normal text-xs ml-2">(not your regular password)</span>
              </label>
              <input
                type="password"
                value={imapPassword} onChange={e => setImapPassword(e.target.value)}
                placeholder="xxxx xxxx xxxx xxxx"
                className={inp}
              />
            </div>

            {imapProvider === 'custom' && (
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 flex flex-col gap-1">
                  <label className="text-sm font-medium">IMAP Host</label>
                  <input value={imapHost} onChange={e => setImapHost(e.target.value)} className={inp} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium">Port</label>
                  <input type="number" value={imapPort} onChange={e => setImapPort(Number(e.target.value))} className={inp} />
                </div>
              </div>
            )}

            {imapTestResult && (
              <p className={`text-xs ${imapTestResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                {imapTestResult.ok ? '✓ Connected successfully — credentials saved' : `✗ ${imapTestResult.error}`}
              </p>
            )}

            <div className="flex gap-2">
              <button
                onClick={testImap}
                disabled={imapTesting || !imapUsername || !imapPassword}
                className="bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white px-4 py-2 rounded-full text-sm font-medium transition-all"
              >
                {imapTesting ? 'Testing...' : 'Test & Save'}
              </button>
              {!imapConfigured && (
                <button
                  onClick={() => setShowImapForm(false)}
                  className="text-gray-500 hover:text-gray-300 px-3 py-2 text-sm transition-colors"
                >
                  Skip for now
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="h-px bg-white/[0.06]" />

      {/* ── Expected Salary ── */}
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium">Expected Salary Range
          <span className="text-gray-500 font-normal text-xs ml-2">(optional)</span>
        </label>
        <p className="text-xs text-gray-500">Used to answer salary expectation fields in forms. Leave blank to use a default range.</p>
        <input
          value={salary} onChange={e => setSalary(e.target.value)}
          placeholder='e.g. "$120,000 - $140,000" · "Competitive" · "Open to discussion"'
          className={inp}
        />
      </div>

      <div className="h-px bg-white/[0.06]" />

      {/* ── EEO — optional, collapsible ── */}
      <div className="flex flex-col gap-3">
        <button onClick={() => setShowEeo(v => !v)}
          className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-300 self-start">
          <span>{showEeo ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
          EEO / Demographic Info
          <span className="text-gray-600 text-xs">(optional — pre-fills EEO sections in forms)</span>
        </button>
        {showEeo && (
          <div className="grid grid-cols-2 gap-3 pl-4 border-l border-white/[0.06]">
            {[
              { label: 'Gender', val: eeoGender, set: setEeoGender,
                opts: ['Male','Female','Non-binary','Prefer not to answer','Decline To Self Identify'] },
              { label: 'Race / Ethnicity', val: eeoRace, set: setEeoRace,
                opts: ['American Indian or Alaska Native','Asian','Black or African American','Hispanic or Latino','White','Two or More Races','Decline To Self Identify','Prefer not to answer'] },
              { label: 'Veteran Status', val: eeoVeteran, set: setEeoVeteran,
                opts: ['I am not a protected veteran','I identify as a protected veteran',"I don't wish to answer",'Prefer not to answer'] },
              { label: 'Disability Status', val: eeoDisability, set: setEeoDisability,
                opts: ['No, I do not have a disability','Yes, I have a disability','Prefer not to answer','I do not want to answer'] },
            ].map(({ label, val, set, opts }) => (
              <div key={label} className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">{label}</label>
                <select value={val} onChange={e => set(e.target.value)} className={sel}>
                  <option value="">Leave blank</option>
                  {opts.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Start button ── */}
      <button
        onClick={start}
        disabled={!canStart}
        className="bg-orange-500 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed text-white px-6 py-3 rounded-full font-medium self-start transition-all"
      >
        {canStart ? 'Find Matching Jobs →' : 'Upload resume + enter location to continue'}
      </button>
    </div>
  )
}
