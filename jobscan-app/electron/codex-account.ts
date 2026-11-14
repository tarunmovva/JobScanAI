/**
 * What the app reads from the user's Codex account. Pure: the client in
 * codex-client.ts does the talking.
 *
 * The account's usage limits come in a 5-hour (`primary`) and a weekly
 * (`secondary`) window. Loop mode reads them to wait out a limit instead of
 * failing against it. The same account holds reset credits; those are the
 * user's, and the app sends no request that could spend one -- the limits
 * read below is the only account request it makes.
 */
import type { RateLimitSnapshot, RateLimitWindow } from '../src/types'

export const RATE_LIMITS_READ = 'account/rateLimits/read'

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function windowFrom(raw: unknown): RateLimitWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const usedPercent = num(w['usedPercent'])
  if (usedPercent === null) return null
  return {
    usedPercent,
    windowDurationMins: num(w['windowDurationMins']) ?? 0,
    resetsAt: num(w['resetsAt']),
  }
}

/**
 * The read's answer as the loop uses it, or null when it holds no limits.
 * Anything missing reads as unknown, never as exhausted.
 */
export function mapRateLimits(raw: unknown): RateLimitSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const limits = r['rateLimits']
  if (!limits || typeof limits !== 'object') return null
  const l = limits as Record<string, unknown>
  const primary = windowFrom(l['primary'])
  const secondary = windowFrom(l['secondary'])
  const reached = typeof l['rateLimitReachedType'] === 'string' && l['rateLimitReachedType']
    ? String(l['rateLimitReachedType'])
    : null
  if (!primary && !secondary && !reached && r['ordinaryUsageAllowed'] !== false) return null
  return {
    ordinaryUsageAllowed: r['ordinaryUsageAllowed'] !== false,
    primary,
    secondary,
    rateLimitReachedType: reached,
  }
}

const SIGNED_OUT = /not logged in|login required|unauthenticated|not authenticated/i

/**
 * `codex login status`: true signed in, false signed out, null when its
 * answer says neither (it crashed, or never ran).
 */
export function loginStatusFrom(code: number | null, output: string): boolean | null {
  if (SIGNED_OUT.test(String(output ?? ''))) return false
  if (code === 0) return true
  return null
}
