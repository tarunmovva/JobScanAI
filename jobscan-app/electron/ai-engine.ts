/**
 * The AI engine behind JobScan's three AI calls (writing searches, rating
 * jobs, answering forms).
 *
 * pipeline.ts only talks to this interface. The built-in engine is Codex,
 * unchanged (ai-engine-codex.ts). The other engine runs the user's own
 * Claude Code (ai-engine-claude.ts). Which one runs is the machine-wide
 * `aiEngine` setting, changed only from the window.
 *
 * Pure: no Electron imports, so it loads in unit tests. The engines are
 * registered once at startup (main.ts).
 */
import type { RateLimitSnapshot } from '../src/types'

export type AiKind = 'query_gen' | 'rating' | 'payload'
export type EngineId = 'codex' | 'claude'

export interface AiCall {
  kind: AiKind
  /** Sent exactly as today: `${system}\n\n---\n\n${user}`. */
  system: string
  user: string
  /**
   * Whose call this is: the pipeline's CancelToken, or the rating engine.
   * cancelOwner(owner) ends that owner's calls; Codex ignores it.
   */
  owner?: object
  /** Streamed reply text, where the engine can stream. */
  onToken?: (t: string) => void
}

export interface AiEngine {
  readonly id: EngineId
  /** The reply text. Rejects only when the call itself failed. */
  complete(call: AiCall): Promise<string>
  /**
   * What the cached stages hash as "the model". Codex returns exactly the
   * string it always did, so switching to this seam invalidates nothing.
   */
  hashModel(): string
  /** Signed in and able to answer (the loop's precondition). */
  ready(): Promise<boolean>
  /** Usage windows, when the engine can read them; else null. */
  limits(): Promise<RateLimitSnapshot | null>
  /** End every call in flight (pipeline cancel, quit). */
  cancelAll(reason: string): Promise<void>
  /** End one owner's calls; later calls by that owner fail at once. */
  cancelOwner(owner: object): void
}

export function engineIdFrom(value: unknown): EngineId {
  return value === 'claude' ? 'claude' : 'codex'
}

/** The hash input the Codex stages always used: the raw setting, '' for Auto. */
export function codexHashModel(get: (key: string) => unknown): string {
  return String(get('codexModel') ?? '')
}

let engines: Partial<Record<EngineId, AiEngine>> = {}
let readSetting: () => unknown = () => 'codex'

export function registerEngines(map: Partial<Record<EngineId, AiEngine>>, setting: () => unknown): void {
  engines = { ...map }
  readSetting = setting
}

/** The engine selected now; Codex when the selected one is unavailable. */
export function aiEngine(): AiEngine {
  const engine = engines[engineIdFrom(readSetting())] ?? engines.codex
  if (!engine) throw new Error('AI engine not ready')
  return engine
}

export function selectedEngineId(): EngineId {
  return engineIdFrom(readSetting())
}
