/**
 * What loop mode's chip, legend and start warning say. Pure, and shared with
 * the renderer, so it imports only types.
 */
import type { LoopPhase, LoopSettings, LoopStage, LoopStatus } from '../src/types'

/** What a refused action says while the loop runs (main refuses, the renderer shows it). */
export const LOOP_ON_MESSAGE = 'Loop mode is on — stop it first'

export const STAGE_LABELS: Record<LoopStage, string> = {
  rebuild: 'Rebuilding',
  search: 'Finding jobs',
  rate: 'Rating',
  apply: 'Applying',
}

/** One entry per chip state; the panel shows them as its legend. */
export const CHIP_LEGEND: Array<{ phase: LoopPhase; label: string; meaning: string }> = [
  { phase: 'off', label: 'Loop', meaning: 'Loop mode is off. Open it to choose what it applies to, then start it.' },
  { phase: 'running', label: 'Round 3 · Applying', meaning: 'A round is running: rebuilding, finding jobs, rating, or applying on its own.' },
  { phase: 'stopping', label: 'Stopping…', meaning: 'The current round finishes, then the loop turns off. Nothing new starts.' },
  { phase: 'waiting', label: 'Next 23:40', meaning: 'Between rounds — or waiting for a Codex usage limit to reset. Nothing is being sent.' },
  { phase: 'stopped', label: 'Stopped — why', meaning: 'The loop stopped itself and says why. Fix that, then start it again.' },
]

function clock(at: Date, now: Date): string {
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  return sameDay ? hhmm : `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm}`
}

export function chipLabel(s: LoopStatus, now: Date): string {
  switch (s.phase) {
    case 'running':
      return s.stage ? `Round ${s.round} · ${STAGE_LABELS[s.stage]}` : `Round ${s.round}`
    case 'stopping':
      return 'Stopping…'
    case 'waiting': {
      const at = s.nextAt ? clock(new Date(s.nextAt), now) : ''
      if (s.waitReason === 'codex_5h') return `Waiting — Codex 5-hour limit · resets ${at}`
      if (s.waitReason === 'codex_weekly') return `Waiting — Codex weekly limit · resets ${at}`
      if (s.waitReason === 'codex_unknown') return `Waiting — Codex usage limit · retry ${at}`
      return at ? `Next ${at}` : 'Waiting'
    }
    case 'stopped':
      return s.stopReason ? `Stopped — ${s.stopReason}` : 'Stopped'
    default:
      return 'Loop'
  }
}

/** The warning before the loop starts. Exact copy (spec). */
export function startConfirmCopy(settings: LoopSettings): string {
  return `Loop mode sends real applications without asking — up to ${settings.dailyLimit} a day, `
    + `to jobs rated ${settings.threshold} or higher from your saved searches. `
    + 'They cannot be withdrawn. Start?'
}
