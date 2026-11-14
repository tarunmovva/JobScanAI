import http from 'http'

/**
 * Bring the tab an application was actually filled in back to the front.
 *
 * When a fill stops on something only a person can finish — a CAPTCHA
 * challenge, an email verification — the filler deliberately leaves that tab
 * open (close_policy.py) with every answer already in it. Opening the apply URL
 * again in the default browser would hand the user a BLANK form and throw all
 * of that away, so "Finish it" has to focus the existing tab, not the link.
 *
 * Uses Chrome's DevTools HTTP endpoint directly — /json/list to find the tab and
 * /json/activate to raise it — which needs no Playwright and no page evaluation.
 */

const CDP_HOST = process.env['JOB_AUTOMATOR_CDP_HOST'] ?? '127.0.0.1'
const CDP_PORT = process.env['JOB_AUTOMATOR_CDP_PORT'] ?? '9222'
const CDP = `http://${CDP_HOST}:${CDP_PORT}`

interface CdpTarget {
  id: string
  type: string
  url: string
  title: string
}

function cdpGet(path: string, timeoutMs = 1500): Promise<string | null> {
  return new Promise(resolve => {
    const req = http.get(`${CDP}${path}`, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null) }
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c as Buffer))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
  })
}

async function listTabs(): Promise<CdpTarget[]> {
  const body = await cdpGet('/json/list')
  if (!body) return []
  try {
    const parsed = JSON.parse(body) as CdpTarget[]
    return Array.isArray(parsed) ? parsed.filter(t => t?.type === 'page') : []
  } catch { return [] }
}

/**
 * Match on the identifying part of the URL rather than the whole string. The tab
 * has moved on since it was opened — query strings get rewritten, greenhouse
 * redirects boards.greenhouse.io to job-boards.greenhouse.io, and a submitted
 * form lands on a confirmation path — so an exact comparison finds nothing.
 */
function identity(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    // Greenhouse is the awkward one: the same posting appears as
    // boards.greenhouse.io/x/jobs/123?gh_jid=123, as job-boards.greenhouse.io/x/
    // jobs/123 after the redirect, and on the company's own careers domain with
    // only ?gh_jid=123. The numeric job id is the one stable thing across all
    // three, so key on it wherever it appears.
    // An embedded application form (/embed/job_app) carries the id as token=;
    // every embed shares that path, so without the token they would all look
    // like one job.
    const onGreenhouse = /greenhouse\.io$/i.test(url.hostname)
    const jid = url.searchParams.get('gh_jid')
      ?? (onGreenhouse ? (url.pathname.match(/\/jobs\/(\d+)/)?.[1] ?? null) : null)
      ?? (onGreenhouse && /\/embed\//.test(url.pathname) ? url.searchParams.get('token') : null)
    if (jid) return `gh:${jid}`
    const path = url.pathname.replace(/\/(apply|application)\/?$/, '').replace(/\/+$/, '')
    return `${url.hostname.replace(/^www\./, '')}${path}`.toLowerCase()
  } catch {
    return rawUrl.toLowerCase()
  }
}

export interface FocusResult {
  focused: boolean
  reason: 'focused' | 'no-chrome' | 'no-matching-tab' | 'activate-failed'
  url?: string
}

/**
 * Raise the open tab for this application. Returns focused:false with a reason
 * when there is nothing to raise, so the caller can fall back to opening the URL
 * — a blank form is a poor outcome but a dead button is a worse one.
 */
export async function focusApplicationTab(applyUrl: string): Promise<FocusResult> {
  const tabs = await listTabs()
  if (tabs.length === 0) return { focused: false, reason: 'no-chrome' }

  const wanted = identity(applyUrl)
  const match = tabs.find(t => identity(t.url) === wanted)
    ?? tabs.find(t => t.url && applyUrl && (t.url.includes(applyUrl) || applyUrl.includes(t.url)))
  if (!match) return { focused: false, reason: 'no-matching-tab' }

  const activated = await cdpGet(`/json/activate/${encodeURIComponent(match.id)}`)
  if (activated === null) return { focused: false, reason: 'activate-failed', url: match.url }
  return { focused: true, reason: 'focused', url: match.url }
}

/**
 * Close every tab of one application — its posting, its board page, its embed.
 *
 * Loop mode calls this after each job, whatever happened: a filler that was
 * killed or crashed can never close its own tab, and nobody is at the
 * computer to close it. Only tabs whose URL identifies this job are touched,
 * so the user's own tabs and other jobs' tabs stay open.
 */
export async function closeTabsFor(applyUrl: string): Promise<number> {
  if (!applyUrl) return 0
  const wanted = identity(applyUrl)
  let closed = 0
  for (const tab of await listTabs()) {
    if (identity(tab.url) !== wanted) continue
    if (await cdpGet(`/json/close/${encodeURIComponent(tab.id)}`) !== null) closed++
  }
  return closed
}

export const __testing = { identity }
