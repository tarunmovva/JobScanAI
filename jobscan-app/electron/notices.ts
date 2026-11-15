/**
 * Notices: what an agent driving JobScan (through the jobscan harness) hears
 * about the app -- every step, every click in the window, every AI call.
 *
 * They carry numbers and fixed labels only. Job titles, companies, URLs,
 * descriptions, model replies and error text are written by employers or
 * by a model that read them, so none of it is ever in a notice: each event
 * maps to an explicit list of fields, and every string must also be one of
 * a fixed set of labels. The agent's session may have a shell and a
 * browser; a posting must not be able to talk to it.
 *
 * Pure (no Electron): unit-tested.
 */
export type NoticeValue = number | boolean | string
export interface Notice { seq: number; at: number; type: string; [field: string]: NoticeValue }

const LABEL = /^[a-z][a-z0-9_:-]{0,39}$/

const APP_STATES = new Set(['auth', 'resume', 'fetching', 'query_gen', 'rating', 'board', 'done'])
const FETCH_RESULTS = new Set(['success', 'failed', 'canceled'])
const LOOP_PHASES = new Set(['off', 'running', 'waiting', 'stopping', 'stopped'])
const LOOP_STAGES = new Set(['rebuild', 'search', 'rating', 'apply'])
const WAIT_REASONS = new Set(['', 'codex_5h', 'codex_weekly', 'codex_unknown'])
const AI_KINDS = new Set(['query_gen', 'rating', 'payload'])
const AI_OUTCOMES = new Set(['ok', 'error', 'exited', 'timeout', 'canceled'])
const APPLY_STATES = new Set(['working', 'done', 'submitted', 'failed', 'skipped', 'needs_you', 'error'])

/** The window's write actions, as named in its IPC channels. */
const USER_ACTIONS = new Set([
  'resume:upload', 'resume:browse', 'profile:save', 'pipeline:start-query-gen', 'pipeline:add-user-queries',
  'pipeline:start-rating', 'pipeline:start-extract', 'pipeline:start-payload-gen', 'pipeline:reset',
  'pipeline:goto-state', 'selection:confirm', 'settings:save', 'engine:set', 'fetch:start', 'fetch:cancel',
  'applied-jobs:clear', 'profiles:create', 'profiles:switch', 'profiles:rename', 'profiles:delete',
  'loop:start', 'loop:stop', 'loop:save-settings', 'imap:save-config', 'auth:login', 'auth:logout',
])

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const pick = (v: unknown, allowed: Set<string>): string | undefined =>
  (typeof v === 'string' && allowed.has(v) ? v : undefined)

/** Drops every field that is not a finite number, a boolean or a short label. */
export function clean(fields: Record<string, unknown>): Record<string, NoticeValue> {
  const out: Record<string, NoticeValue> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (!LABEL.test(k)) continue
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string' && (v === '' || LABEL.test(v))) out[k] = v
  }
  return out
}

export type NoticeInput = [type: string, fields: Record<string, unknown>]

/**
 * One window event as notices. Progress events become `progress` notices,
 * coalesced by the feed. Unknown channels, streaming text and per-line logs
 * produce nothing.
 */
export function noticesFromEvent(channel: string, payload: unknown): NoticeInput[] {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  switch (channel) {
    case 'user_action': {
      // The user clicked something in the window: which action, nothing more.
      const action = pick(p['action'], USER_ACTIONS)
      return action ? [['user_action', { action }]] : []
    }
    case 'state:change': return [['state', { state: pick(p['state'], APP_STATES) }]]
    case 'pipeline:idle': return [['idle', {}]]
    case 'pipeline:canceled': return [['canceled', {}]]
    case 'pipeline:error': return [['error', {}]]
    // A rebuild's boards fetched so far; the index steps after it have no count.
    case 'fetch:progress': return p['phase'] === 'fetch'
      ? [['progress', { step: 'rebuild', done: num(p['companiesDone']), total: num(p['companiesTotal']) }]]
      : []
    case 'fetch:done': return [['rebuild_done', {
      result: p['success'] === true ? 'success' : 'failed',
      jobs_added: num(p['jobsAdded']), board_errors: num(p['errorCount']), seconds: num(p['elapsedSec']),
    }]]
    case 'queryGen:valid': return [['search_written', { index: num(p['index']) }]]
    case 'queryGen:invalid': return [['search_retry', { index: num(p['index']) }]]
    case 'queryGen:error': return [['search_failed', { index: num(p['index']) }]]
    case 'queryGen:done': return [['searches_done', {
      searches: Array.isArray(p['queries']) ? p['queries'].length : undefined, pool: num(p['total']),
    }]]
    case 'rating:progress': return [['progress', { step: 'rating', done: num(p['done']), total: num(p['total']) }]]
    case 'rating:done': return [['rating_done', { rated: Array.isArray(p['jobs']) ? p['jobs'].length : undefined }]]
    case 'extract:progress': return [['progress', { step: 'extract', done: num(p['done']), total: num(p['total']) }]]
    case 'extract:done': return [['extract_done', { done: num(p['done']), failed: num(p['failed']) }]]
    case 'payload:progress': {
      const state = pick(p['state'], APPLY_STATES)
      return state ? [['tally', { step: 'apply', state }]] : []
    }
    case 'loop:status': {
      const today = (p['today'] ?? {}) as Record<string, unknown>
      return [['loop', {
        phase: pick(p['phase'], LOOP_PHASES), round: num(p['round']), stage: pick(p['stage'], LOOP_STAGES) ?? '',
        wait: pick(p['waitReason'], WAIT_REASONS), applied_today: num(today['attempted']), daily_limit: num(today['limit']),
      }]]
    }
    default: return []
  }
}

export function aiCallNotice(info: { kind: string; outcome: string; ms: number; usage: { input: number; cacheWrite: number; cacheRead: number; output: number } | null }): NoticeInput {
  const u = info.usage
  return ['ai_call', {
    kind: pick(info.kind, AI_KINDS), outcome: pick(info.outcome, AI_OUTCOMES), ms: num(info.ms),
    tokens_in: u ? u.input + u.cacheWrite + u.cacheRead : undefined, tokens_out: u ? u.output : undefined,
  }]
}

export interface Since { notices: Notice[]; next: number; missed: boolean }

export class NoticeFeed {
  private buf: Notice[] = []
  private seq = 0
  private waiters = new Set<() => void>()
  private lastLoop = ''
  private progressAt = new Map<string, number>()
  private pendingProgress = new Map<string, Record<string, unknown>>()
  private tallies = new Map<string, Map<string, number>>()
  private tallyAt = new Map<string, number>()
  /** When the driving agent last asked for notices (its presence). */
  lastPollAt = 0

  constructor(
    private readonly cap = 500,
    private readonly now: () => number = Date.now,
    private readonly everyMs = 30_000,
  ) {}

  /** Add one event; progress and per-job tallies are coalesced. */
  add([type, fields]: NoticeInput): void {
    if (type === 'progress') return this.progress(fields)
    if (type === 'tally') return this.tally(fields)
    if (type === 'loop') {
      // Only when something the agent would act on changed.
      const key = `${fields['phase']}|${fields['stage']}|${fields['wait']}|${fields['applied_today']}`
      if (key === this.lastLoop) return
      this.lastLoop = key
    }
    if (type === 'idle' || type === 'canceled') this.flushAll()
    this.push(type, fields)
  }

  since(after: number): Since {
    const first = this.buf[0]?.seq ?? this.seq + 1
    const notices = this.buf.filter(n => n.seq > after)
    return { notices, next: this.seq, missed: after < first - 1 }
  }

  /** since(), waiting up to `ms` for something new. */
  wait(after: number, ms: number): Promise<Since> {
    if (this.seq > after || ms <= 0) return Promise.resolve(this.since(after))
    return new Promise(resolve => {
      const done = (): void => { clearTimeout(timer); this.waiters.delete(done); resolve(this.since(after)) }
      const timer = setTimeout(done, ms)
      this.waiters.add(done)
    })
  }

  private push(type: string, fields: Record<string, unknown>): void {
    if (!LABEL.test(type)) return
    this.buf.push({ ...clean(fields), seq: ++this.seq, at: this.now(), type })
    if (this.buf.length > this.cap) this.buf.shift()
    for (const w of [...this.waiters]) w()
  }

  private progress(fields: Record<string, unknown>): void {
    const step = String(fields['step'] ?? '')
    const finished = typeof fields['done'] === 'number' && fields['done'] === fields['total']
    const last = this.progressAt.get(step)
    if (finished || last === undefined || this.now() - last >= this.everyMs) {
      this.progressAt.set(step, this.now())
      this.pendingProgress.delete(step)
      this.push('progress', fields)
    } else {
      this.pendingProgress.set(step, fields)
    }
  }

  private tally(fields: Record<string, unknown>): void {
    const step = String(fields['step'] ?? '')
    const counts = this.tallies.get(step) ?? new Map<string, number>()
    const state = String(fields['state'] ?? '')
    counts.set(state, (counts.get(state) ?? 0) + 1)
    this.tallies.set(step, counts)
    const last = this.tallyAt.get(step)
    if (last === undefined || this.now() - last >= this.everyMs) this.flushTally(step)
  }

  private flushTally(step: string): void {
    const counts = this.tallies.get(step)
    if (!counts || counts.size === 0) return
    this.tallyAt.set(step, this.now())
    this.push('progress', { step, ...Object.fromEntries(counts) })
    this.tallies.set(step, new Map())
  }

  private flushAll(): void {
    for (const [step, fields] of this.pendingProgress) { this.progressAt.set(step, this.now()); this.push('progress', fields) }
    this.pendingProgress.clear()
    for (const step of this.tallies.keys()) this.flushTally(step)
  }
}
