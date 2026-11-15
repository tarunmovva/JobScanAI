/**
 * The six things an agent driving JobScan may do, each the same as a button
 * in the window and allowed only where and when that button is.
 *
 * None of them can lead to an application: confirming a selection, filling,
 * applying, starting the loop, changing settings, resetting, opening files
 * or URLs all stay window-only. Each action starts its step and returns at
 * once; how the step went arrives as notices.
 *
 * Pure: the app's functions are passed in (wired in main.ts).
 */
export type ActionResult = { ok: true } | { ok: false; reason: AgentRefusal }
export type AgentRefusal =
  | 'unknown_action' | 'bad_args' | 'loop_on' | 'loop_off' | 'busy' | 'wrong_screen' | 'nothing_to_rate'

export interface AgentActionDeps {
  loopIsOn(): boolean
  isPipelineActive(): boolean
  isRatingEngineActive(): boolean
  appState(): string
  fetchStatus(): string                 // 'idle' | 'running' | 'success' | 'failed' | 'canceled'
  queriesReady(): boolean               // Find Jobs finished: saved searches exist
  poolSize(): number
  setState(state: string): void
  runFetch(): void
  cancelRebuild(): void
  runQueryGen(): void
  runUserQueryGen(ask: string): void
  runRating(): void
  stopLoop(mode: 'after-round' | 'now'): void
}

export const AGENT_ACTIONS = ['rebuild_db', 'cancel_rebuild', 'find_jobs', 'find_more', 'rate_jobs', 'stop_loop'] as const

const refuse = (reason: AgentRefusal): ActionResult => ({ ok: false, reason })
const OK: ActionResult = { ok: true }

/** Text the user asked for, as plain text: no control characters, at most 500 chars. */
function cleanAsk(v: unknown): string {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
}

export function createAgentActions(d: AgentActionDeps): (name: string, args: unknown) => ActionResult {
  return (name, args) => {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
    const state = d.appState()
    // A rebuild finished and its screen not yet dismissed counts as Resume,
    // as its Continue button would.
    const onResume = state === 'resume'
      || (state === 'fetching' && d.fetchStatus() !== 'running' && !d.isPipelineActive())
    const busy = d.isPipelineActive() || d.isRatingEngineActive()

    switch (name) {
      case 'rebuild_db':
        if (d.loopIsOn()) return refuse('loop_on')
        if (busy) return refuse('busy')
        if (!onResume) return refuse('wrong_screen')
        d.runFetch()
        return OK

      case 'cancel_rebuild':
        // Only a rebuild: the same lock is held by an application run, and
        // cancelling that would kill fillers mid-submit.
        if (d.loopIsOn()) return refuse('loop_on')
        if (state !== 'fetching' || d.fetchStatus() !== 'running') return refuse('wrong_screen')
        d.cancelRebuild()
        return OK

      case 'find_jobs':
        if (d.loopIsOn()) return refuse('loop_on')
        if (busy) return refuse('busy')
        if (!onResume) return refuse('wrong_screen')
        if (state === 'fetching') d.setState('resume')
        d.runQueryGen()
        return OK

      case 'find_more': {
        const ask = cleanAsk(a['ask'])
        if (!ask) return refuse('bad_args')
        if (d.loopIsOn()) return refuse('loop_on')
        // The window offers "Find more" on the searches screen once they are done;
        // a rating engine still scoring is joined, as the window's button does.
        if (d.isPipelineActive()) return refuse('busy')
        if (state !== 'query_gen' || !d.queriesReady()) return refuse('wrong_screen')
        d.runUserQueryGen(ask)
        return OK
      }

      case 'rate_jobs':
        // "Evaluate Matches": searches done, a pool to rate.
        if (d.loopIsOn()) return refuse('loop_on')
        if (d.isPipelineActive()) return refuse('busy')
        if (state !== 'query_gen' || !d.queriesReady()) return refuse('wrong_screen')
        if (d.poolSize() === 0) return refuse('nothing_to_rate')
        d.runRating()
        return OK

      case 'stop_loop': {
        if (!d.loopIsOn()) return refuse('loop_off')
        const mode = a['mode'] === 'now' ? 'now' : 'after-round'
        d.stopLoop(mode)
        return OK
      }

      default:
        return refuse('unknown_action')
    }
  }
}
