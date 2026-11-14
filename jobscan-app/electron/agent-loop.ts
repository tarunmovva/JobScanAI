/**
 * When an application agent may stop asking for work.
 *
 * Extraction and the agent pool used to run one after the other, so an agent
 * that found an empty queue could safely stop: nothing else was coming. Now
 * they run concurrently, and an empty queue usually means only that the
 * extractor has not caught up yet.
 *
 * This is the single decision that strands a run if it is wrong — too eager and
 * agents quit while jobs are still being extracted, leaving applications nobody
 * makes; too patient and they poll forever and the run never ends. It lives
 * here, apart from the loop, so it can be tested without a pipeline, a database
 * or a browser.
 */

export interface AgentLoopState {
  /** How many jobs the last claim returned. */
  claimedCount?: number
  /** True once extraction has finished — including when it failed or was cancelled. */
  extractionComplete?: boolean
  canceled?: boolean
}

export function shouldAgentExit(state: AgentLoopState): boolean {
  if (state.canceled) return true
  // Work in hand is always processed. An agent holding a claimed job that
  // stopped here would leave that job leased and never applied to.
  if ((state.claimedCount ?? 0) > 0) return false
  // Absent flags default to "keep waiting". Reading an undefined
  // extractionComplete as finished would drain the pool early and silently
  // skip jobs, which is the worse of the two failures.
  return state.extractionComplete === true
}

/** How long an agent waits before asking for work again. */
export const AGENT_POLL_MS = 1500
