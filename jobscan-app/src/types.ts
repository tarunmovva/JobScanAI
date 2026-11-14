export type AppState =
  | 'auth'
  | 'resume'
  | 'fetching'
  | 'query_gen'
  | 'rating'
  // One state for the whole application board. Extraction and filling used
  // to be separate steps; they now overlap and render the same screen, so
  // showing them as two is describing the implementation, not the work.
  | 'board'
  | 'done'

export interface Job {
  id: string           // "greenhouse:company:12345"
  job_id: string
  company: string
  title: string
  location: string
  workplace_type: string
  employment_type: string
  platform: string     // "greenhouse" | "lever" | "ashby"
  job_url: string
  apply_url: string
  description: string
  posted_at: string
  // Published by roughly 3 of every 5 postings. Optional because the CLI omits
  // the key entirely when the board did not state one.
  salary?: string
}

export interface RatedJob extends Job {
  rating: number       // 1-10, from the LLM rater
  reason: string
}

export interface FormField {
  id: string
  name?: string
  label: string
  type: string
  required: boolean
  selector: string
  // Shapes differ by extractor: greenhouse and ashby emit {text, value}, lever
  // emits plain strings. Anything reading an option must handle both.
  options?: Array<{ text: string; value: string } | string>
  // Set by the extractor when option collection hit its cap: the list above is
  // a SAMPLE of a typeahead's real options, not the whole set.
  options_truncated?: boolean
  accepted_types?: string
  supports_custom_input?: boolean
}

export interface ExtractedFields {
  platform: string
  apply_url: string
  fields: FormField[]
  job_title: string
  company_slug: string
  job_id: string
}

export interface ClaimedJob {
  application_id: number
  job_id: string
  platform: string
  company_slug: string
  job_title: string
  apply_url: string
  claim_token: string
  extracted_fields: ExtractedFields
}

export interface FillStatus {
  queued: number
  extracting: number
  extracted: number
  claimed: number
  filling: number
  submitted: number
  failed: number
}

export interface UserProfile {
  targetLocations: string      // required — free text: "Austin TX", "Remote US", "NYC or SF"
  visaCountry: string          // optional — country of residence
  visaStatus: string           // 'no-sponsorship' | 'future-sponsorship' | 'need-sponsorship' | ''
  eeoGender: string            // optional — exact dropdown text or ''
  eeoRace: string              // optional — exact dropdown text or ''
  eeoVeteran: string           // optional — exact dropdown text or ''
  eeoDisability: string        // optional — exact dropdown text or ''
}

export interface Settings {
  resumeText?: string
  resumePath?: string
  ratingAgents: number
  payloadAgents: number
  codexModel: string           // '' = Auto (Codex default / first-listed model)
  jobscanExePath: string
  pythonDir: string
  jobAutomatorHome: string
  // User profile (collected on resume screen)
  profile?: UserProfile
}

// One entry of the codex app-server model/list RPC, normalized.
export interface CodexModelOption {
  id: string
  label: string
}

// Which models the picker can offer is decided by the Codex CLI, so the app
// keeps it current and reports what it is running.
export interface CodexUpdateStatus {
  managedVersion: string | null
  managedPath: string | null
  bundledPath: string | null
  latestVersion: string | null
  checkedAt: string
  state: 'idle' | 'checking' | 'downloading' | 'verifying' | 'health-checking' | 'up-to-date' | 'updated' | 'failed' | 'skipped'
  message: string
}

// A local profile (persona): its own resume + application strategy.
export interface ProfileInfo {
  id: string
  name: string
  createdAt: string
}

export interface AgentSlotStatus {
  agentId: string
  state: 'idle' | 'working' | 'done' | 'failed'
  company?: string
  jobId?: string
  title?: string
  platform?: string
  applyUrl?: string
  message?: string
}

// ── Fetch / DB rebuild ──────────────────────────────────────────────────────

export type FetchPhase = 'load' | 'fetch' | 'fts' | 'index' | 'finalize' | 'done'

// Structured progress for the DB rebuild, parsed in main from the CLI's
// milestone lines. Renderer receives it via fetch:progress events and the
// fetch:get-state rehydrate call.
export interface FetchSnapshot {
  status: 'idle' | 'running' | 'success' | 'failed' | 'canceled'
  phase: FetchPhase
  companiesTotal: number | null
  companiesDone: number | null   // live PROGRESS lines from the CLI
  jobsSoFar: number | null       // live job count while fetching
  jobsAdded: number | null
  errorCount: number | null
  emptyBoards: number | null
  durations: Partial<Record<
    'load' | 'fetch' | 'ftsTable' | 'ftsRebuild' | 'ftsTriggers' |
    'index' | 'checkpoint' | 'swap' | 'total', string>>
  startedAt: number | null      // epoch ms — renderer computes true elapsed
  finishedAt: number | null
  exitCode: number | null
  errorMessage: string | null
  lastDurationSec: number | null  // previous successful run → "usually takes ~Xm"
}

export interface AppliedJobLogEntry {
  company: string
  jobId: string
  platform: string
  title: string
  applyUrl: string
  status: 'submitted' | 'failed'
  message: string
  via: 'auto' | 'manual'
  ts: string
  detailsPath?: string   // per-application Q&A record (.md) — absent on old entries
}

// ── Loop mode ────────────────────────────────────────────────────────────────

export interface LoopSettings {
  threshold: number          // auto-select jobs rated at or above this (1–10)
  dailyLimit: number         // jobs the loop starts working on per local day
  minGapMin: number          // minutes between round starts
}

/** What one job's result means for the loop. */
export type Outcome =
  | 'submitted' | 'captcha' | 'needs_person' | 'closed'
  | 'codex' | 'retryable' | 'skipped' | 'interrupted'
  /** Submit clicked, no confirmation seen: it may have gone in. */
  | 'unconfirmed'

export interface ExclusionEntry {
  reason: Outcome | 'attempts'
  at: string
  title?: string
  company?: string
}

export interface RoundRecord {
  startedAt: string
  endedAt: string
  newJobs: number
  newlyRated: number
  selected: number
  submitted: number
  failed: number
  skipped: number
  error?: string
  codexLimit?: boolean
  /** The round got through its searches — the next round's new-postings pass starts from here. */
  searched?: boolean
}

export interface LoopState {
  excluded: Record<string, ExclusionEntry>
  attempts: Record<string, { count: number; lastStatus: string; at: string }>
  inFlight: Record<string, string>          // job key → when its filler started
  day: { date: string; attempted: number }  // local YYYY-MM-DD
  history: RoundRecord[]                    // newest first
  lastStopReason: string
  active: { round: number; since: string } | null
}

export type BreakerState = Record<string, { consecutive: number; trips: number; pausedUntil: string }>

export interface SelectableJob {
  id: string
  job_id: string
  platform: string
  rating: number
  posted_at?: string
  title?: string
  company?: string
}

/** One Codex usage window, as account/rateLimits/read reports it. */
export interface RateLimitWindow {
  usedPercent: number
  windowDurationMins: number
  resetsAt: number | null   // epoch seconds
}

export interface RateLimitSnapshot {
  ordinaryUsageAllowed: boolean
  primary: RateLimitWindow | null     // the 5-hour window
  secondary: RateLimitWindow | null   // the weekly window
  rateLimitReachedType: string | null
}

export type CodexWindow = '5-hour' | 'weekly' | 'unknown'

/** Off: never started, or stopped by you. Stopped: it stopped itself, with a reason. */
export type LoopPhase = 'off' | 'running' | 'stopping' | 'waiting' | 'stopped'

export type LoopStage = 'rebuild' | 'search' | 'rate' | 'apply'

export interface LoopStatus {
  phase: LoopPhase
  round: number
  stage: LoopStage | null
  nextAt: string | null
  waitReason: '' | 'codex_5h' | 'codex_weekly' | 'codex_unknown'
  codexUsage: { fiveHour: number | null; weekly: number | null }
  stopReason: string
  today: { attempted: number; limit: number }
  paused: Array<{ platform: string; until: string }>
  excluded: Array<{ key: string; reason: string; at: string; title?: string; company?: string }>
  history: RoundRecord[]
  settings: LoopSettings
}
