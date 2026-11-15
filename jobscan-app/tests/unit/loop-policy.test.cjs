// Loop mode's decisions, with no Electron and no store: which jobs a round
// picks, what each job's result means for the loop, when a platform pauses,
// which searches may run, and when the next round starts.
//
// Every value here is a hand-checked literal. The statuses are the real ones
// the automator reports; the rate-limit shape is that of a real
// account/rateLimits/read response (codex 0.167.2), with made-up values.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  DEFAULT_LOOP_SETTINGS, MAX_ATTEMPTS,
  emptyLoopState, clampSettings, jobKey, localDay,
  isCodexLimit, isCodexFailure, classifyOutcome,
  isPaused, recordBreaker,
  markStarted, recordOutcome, sweepInterrupted, remainingToday, roundFailure, forgiveAttempts, MIXED_FINGERPRINT,
  leftOpenKeys, newPostingsTokens,
  selectForRound, nextRoundAt, carryForward, fingerprintMatches, queriesStale, ratingHealth, pushHistory,
  exhaustedWindow, parseTryAgainIn, codexWaitUntil,
} = require('../../out/unit/electron/loop-policy.js')

const NOW = new Date(2026, 10, 12, 22, 0)
const H = 3600e3

// ── outcomes ────────────────────────────────────────────────────────────────

test('outcomes are classified from the real statuses', () => {
  assert.equal(classifyOutcome('submitted', ''), 'submitted')
  assert.equal(classifyOutcome('blocked_captcha_puzzle', ''), 'captcha')
  assert.equal(classifyOutcome('blocked_captcha', 'Lever apply API CAPTCHA response'), 'captcha')
  assert.equal(classifyOutcome('not_confirmed', 'AI: captcha_puzzle'), 'captcha')
  assert.equal(classifyOutcome('otp_timeout', ''), 'needs_person')
  assert.equal(classifyOutcome('posting_closed', ''), 'closed')
  assert.equal(classifyOutcome('error', 'Error: Codex exited (code=0 signal=none)'), 'codex')
  assert.equal(classifyOutcome('error', "You've hit your usage limit"), 'codex')
  assert.equal(classifyOutcome('nav_failed', 'navigate: Page.goto: Timeout 25000ms exceeded.'), 'retryable')
  assert.equal(classifyOutcome('validation_errors', ''), 'retryable')
})

test('a submit that was clicked but never confirmed may have gone in: never retried', () => {
  // Verbatim unsettled statuses (jobscan submission_signals.UNSETTLED_STATUSES):
  // Greenhouse ends with 'clicked', Lever and Ashby with 'not_confirmed'.
  assert.equal(classifyOutcome('clicked', 'clicked'), 'unconfirmed')
  assert.equal(classifyOutcome('not_confirmed', 'not_confirmed'), 'unconfirmed')
  assert.equal(classifyOutcome('not_confirmed', 'not_confirmed AI: captcha_puzzle'), 'captcha', 'a CAPTCHA verdict still wins')
  const s = recordOutcome(emptyLoopState(), 'greenhouse:1', 'unconfirmed', 'clicked', NOW)
  assert.equal(s.excluded['greenhouse:1'].reason, 'unconfirmed')
  assert.deepEqual(s.attempts, {})
})

test('a job board rate limit is not mistaken for a Codex limit', () => {
  // Only a Codex usage limit may stop a whole round.
  assert.equal(isCodexLimit('Greenhouse returned 429: rate limit exceeded'), false)
  assert.equal(isCodexLimit('Codex: rate limit exceeded'), true)
  assert.equal(isCodexLimit('usageLimitExceeded'), true)
  assert.equal(isCodexFailure('Error: Codex exited (code=1 signal=none)'), true)
  assert.equal(isCodexFailure('Page.goto: Timeout 25000ms exceeded'), false)
})

// ── the platform breaker ────────────────────────────────────────────────────

test('two CAPTCHAs with no submission between them pause the platform for 3 hours', () => {
  let b = recordBreaker({}, 'lever', 'captcha', NOW).breaker
  b = recordBreaker(b, 'lever', 'retryable', NOW).breaker          // a non-CAPTCHA failure between them
  const t = recordBreaker(b, 'lever', 'captcha', NOW)
  assert.equal(t.tripped, true)
  assert.equal(isPaused(t.breaker, 'lever', new Date(+NOW + 179 * 60e3)), true)
  assert.equal(isPaused(t.breaker, 'lever', new Date(+NOW + 181 * 60e3)), false)
  assert.equal(isPaused(t.breaker, 'greenhouse', NOW), false)
})

test('one CAPTCHA alone does not pause a platform', () => {
  const t = recordBreaker({}, 'lever', 'captcha', NOW)
  assert.equal(t.tripped, false)
  assert.equal(isPaused(t.breaker, 'lever', NOW), false)
})

test('after a pause one CAPTCHA re-pauses, doubling to a 24 hour cap', () => {
  let b = recordBreaker(recordBreaker({}, 'lever', 'captcha', NOW).breaker, 'lever', 'captcha', NOW).breaker
  let at = NOW
  let pause = 3
  const seen = [3]
  for (let i = 0; i < 4; i++) {
    at = new Date(+at + pause * H + 60e3)                          // just after the pause ended
    const r = recordBreaker(b, 'lever', 'captcha', at)
    assert.equal(r.tripped, true, `trip ${i + 2}`)
    b = r.breaker
    pause = Math.round((Date.parse(b.lever.pausedUntil) - +at) / H)
    seen.push(pause)
  }
  assert.deepEqual(seen, [3, 6, 12, 24, 24])
})

test('a CAPTCHA while paused changes nothing', () => {
  const b = recordBreaker(recordBreaker({}, 'lever', 'captcha', NOW).breaker, 'lever', 'captcha', NOW).breaker
  const r = recordBreaker(b, 'lever', 'captcha', new Date(+NOW + H))
  assert.equal(r.tripped, false)
  assert.deepEqual(r.breaker, b)
})

test('a successful submission clears the platform', () => {
  let b = recordBreaker(recordBreaker({}, 'lever', 'captcha', NOW).breaker, 'lever', 'captcha', NOW).breaker
  const later = new Date(+NOW + 4 * H)
  b = recordBreaker(b, 'lever', 'submitted', later).breaker
  assert.equal('lever' in b, false)
  // Cleared means back to needing two CAPTCHAs, not one.
  assert.equal(recordBreaker(b, 'lever', 'captcha', later).tripped, false)
})

// ── daily count, exclusions, attempts ───────────────────────────────────────

test('the daily count rolls over at local midnight', () => {
  const s = { ...emptyLoopState(), day: { date: '2026-11-12', attempted: 25 } }
  assert.equal(remainingToday(s, DEFAULT_LOOP_SETTINGS, new Date(2026, 10, 12, 23, 59)), 0)
  const next = markStarted(s, 'lever:a', new Date(2026, 10, 13, 0, 5))
  assert.deepEqual(next.day, { date: '2026-11-13', attempted: 1 })
  assert.equal(remainingToday(next, DEFAULT_LOOP_SETTINGS, new Date(2026, 10, 13, 1)), 24)
  assert.equal(localDay(new Date(2026, 0, 5, 9)), '2026-01-05')
})

test('a started filler is in flight until its result arrives', () => {
  const s = markStarted(emptyLoopState(), 'lever:a', NOW)
  assert.equal(s.inFlight['lever:a'], NOW.toISOString())
  const done = recordOutcome(s, 'lever:a', 'submitted', 'submitted', NOW)
  assert.deepEqual(done.inFlight, {})
})

test('outcomes decide exclusions and attempts', () => {
  for (const outcome of ['captcha', 'needs_person', 'closed', 'interrupted']) {
    const s = recordOutcome(markStarted(emptyLoopState(), 'lever:a', NOW), 'lever:a', outcome, 'x', NOW, { title: 'SWE', company: 'acme' })
    assert.deepEqual(s.excluded['lever:a'], { reason: outcome, at: NOW.toISOString(), title: 'SWE', company: 'acme' }, outcome)
    assert.deepEqual(s.inFlight, {})
  }
  const once = recordOutcome(emptyLoopState(), 'lever:a', 'retryable', 'nav_failed', NOW)
  assert.deepEqual(once.attempts['lever:a'], { count: 1, lastStatus: 'nav_failed', at: NOW.toISOString() })
  assert.equal('lever:a' in once.excluded, false)
  const twice = recordOutcome(once, 'lever:a', 'retryable', 'validation_errors', NOW)
  assert.equal(twice.attempts['lever:a'].count, MAX_ATTEMPTS)
  assert.equal(twice.excluded['lever:a'].reason, 'attempts')
  for (const outcome of ['codex', 'skipped', 'submitted']) {
    const s = recordOutcome(emptyLoopState(), 'lever:a', outcome, 'x', NOW)
    assert.deepEqual(s.excluded, {}, outcome)
    assert.deepEqual(s.attempts, {}, outcome)
  }
})

test('recording never changes the state it was given', () => {
  const s = emptyLoopState()
  recordOutcome(s, 'lever:a', 'captcha', 'x', NOW)
  markStarted(s, 'lever:b', NOW)
  assert.deepEqual(s, emptyLoopState())
})

test('jobs cut off mid-fill are swept into exclusions', () => {
  let s = markStarted(emptyLoopState(), 'lever:a', NOW)
  s = markStarted(s, 'ashby:b', NOW)
  const later = new Date(+NOW + H)
  const swept = sweepInterrupted(s, later)
  assert.deepEqual(swept.inFlight, {})
  assert.deepEqual(Object.keys(swept.excluded).sort(), ['ashby:b', 'lever:a'])
  assert.equal(swept.excluded['lever:a'].reason, 'interrupted')
  assert.equal(swept.excluded['lever:a'].at, later.toISOString())
})

test('a job a normal run left open for the user is never auto-selected', () => {
  const keys = leftOpenKeys([
    { platform: 'lever', jobId: 'a', status: 'failed', needsYou: 'CAPTCHA challenge — clear it in the open tab and submit' },
    { platform: 'greenhouse', jobId: 'b', status: 'failed', message: 'validation_errors — browser tab left open, finish manually' },
    { platform: 'greenhouse', jobId: 'c', status: 'failed', message: 'nav_failed: navigate: Timeout' },
    { platform: 'ashby', jobId: 'd', status: 'submitted', message: 'submitted' },
  ])
  assert.deepEqual([...keys].sort(), ['greenhouse:b', 'lever:a'])
})

// ── markets and searches ────────────────────────────────────────────────────

test('the new-postings pass replaces sort, since, limit and offset', () => {
  assert.deepEqual(
    newPostingsTokens(['--title-query', "'ai engineer'", '--market', 'usa', '--since', '30d', '--sort', 'relevance', '--limit', '50', '--offset', '10'], '2026-11-12'),
    ['--title-query', "'ai engineer'", '--market', 'usa', '--sort', 'newest', '--since', '2026-11-12', '--limit', '100'])
  assert.deepEqual(
    newPostingsTokens(['--market=usa', '--since=7d'], '2026-11-12'),
    ['--market=usa', '--sort', 'newest', '--since', '2026-11-12', '--limit', '100'])
})

// ── selection ───────────────────────────────────────────────────────────────

test('selection applies every rule, best first, within the day', () => {
  const job = (id, rating, extra = {}) => ({ id, job_id: id, platform: 'greenhouse', rating, ...extra })
  const rated = [
    job('B', 9, { posted_at: '2026-11-10' }), job('A', 10), job('C', 9, { posted_at: '2026-11-11' }),
    job('D', 8), job('E', 8), job('F', 8, { platform: 'lever' }), job('G', 8), job('H', 8), job('I', 7),
  ]
  const state = {
    ...emptyLoopState(),
    excluded: { 'greenhouse:E': { reason: 'captcha', at: NOW.toISOString() } },
    attempts: { 'greenhouse:G': { count: 2, lastStatus: 'nav_failed', at: NOW.toISOString() } },
    day: { date: localDay(NOW), attempted: 23 },                    // 25 − 23 = 2 left today
  }
  const breaker = { lever: { consecutive: 0, trips: 1, pausedUntil: new Date(+NOW + 3 * H).toISOString() } }
  const r = selectForRound(rated, {
    settings: DEFAULT_LOOP_SETTINGS, state, breaker, now: NOW,
    isApplied: (p, id) => p === 'greenhouse' && id === 'D',
    leftOpen: new Set(['greenhouse:H']),
  })
  assert.deepEqual(r.selected.map(j => j.id), ['A', 'C'])
  assert.deepEqual(r.skipped, { below: 1, applied: 1, left_open: 1, excluded: 1, paused: 1, attempts: 1, over_limit: 1 })
})

test('nothing is selected when today is used up', () => {
  const state = { ...emptyLoopState(), day: { date: localDay(NOW), attempted: 25 } }
  const r = selectForRound([{ id: 'A', job_id: 'A', platform: 'greenhouse', rating: 10 }], {
    settings: DEFAULT_LOOP_SETTINGS, state, breaker: {}, now: NOW, isApplied: () => false, leftOpen: new Set(),
  })
  assert.deepEqual(r.selected, [])
  assert.equal(r.skipped.over_limit, 1)
})

// ── timing ──────────────────────────────────────────────────────────────────

test('the next round waits for the gap, never schedules in the past', () => {
  const start = new Date(2026, 10, 12, 10, 0)
  assert.equal(+nextRoundAt(start, DEFAULT_LOOP_SETTINGS, new Date(2026, 10, 12, 10, 20), 5), +new Date(2026, 10, 12, 11, 0))
  assert.equal(+nextRoundAt(start, DEFAULT_LOOP_SETTINGS, new Date(2026, 10, 12, 11, 30), 5), +new Date(2026, 10, 12, 11, 30))
})

test('a used-up day waits for midnight', () => {
  const start = new Date(2026, 10, 12, 14, 0)
  assert.equal(+nextRoundAt(start, DEFAULT_LOOP_SETTINGS, new Date(2026, 10, 12, 14, 30), 0), +new Date(2026, 10, 13, 0, 0))
})

// ── ratings ─────────────────────────────────────────────────────────────────

test('ratings carry over only under the same fingerprint', () => {
  const A = { platform: 'greenhouse', job_id: '1' }, B = { platform: 'lever', job_id: '2' }, C = { platform: 'ashby', job_id: '3' }
  const rated = [{ ...A, rating: 9 }, { ...B, rating: 4 }]
  const same = carryForward(rated, [A, C], true)
  assert.deepEqual(same.seed, [{ ...A, rating: 9 }])
  assert.deepEqual(same.toRate, [C])
  const changed = carryForward(rated, [A, C], false)
  assert.deepEqual(changed.seed, [])
  assert.deepEqual(changed.toRate, [A, C])
})

test('current ratings are adopted when no fingerprint was stored', () => {
  assert.equal(fingerprintMatches('', 'fp1', true), true)
  assert.equal(fingerprintMatches('', 'fp1', false), false)
  assert.equal(fingerprintMatches('fp0', 'fp1', true), false)
  assert.equal(fingerprintMatches('fp1', 'fp1', false), true)
})

test('saved searches with no recorded inputs are taken as current, not regenerated', () => {
  // Searches saved before loop mode carry no inputs hash. Regenerating them
  // on that alone would spend Codex turns and swap the pool for no reason.
  assert.equal(queriesStale('', 'q1'), false)
  assert.equal(queriesStale('q1', 'q1'), false)
  assert.equal(queriesStale('q0', 'q1'), true)
})

test('a round in which every application failed is the round\'s failure, not the jobs\'', () => {
  assert.equal(roundFailure(['retryable', 'retryable', 'retryable']), 'Every application failed')
  assert.equal(roundFailure(['retryable', 'interrupted', 'codex']), 'Every application failed')
  assert.equal(roundFailure(['retryable', 'retryable']), null, 'too few to tell a broken setup from bad jobs')
  assert.equal(roundFailure(['retryable', 'retryable', 'captcha']), null)
  assert.equal(roundFailure(['retryable', 'retryable', 'retryable', 'submitted']), null)
  assert.equal(roundFailure(['unconfirmed', 'unconfirmed', 'unconfirmed']), null, 'they may have gone in')
  assert.equal(roundFailure([]), null)
})

test('Codex failing on every application fails the round, however few there were', () => {
  // Not the jobs' fault, so nothing is charged to them -- but a round that
  // could not write a single answer must count toward stopping the loop.
  assert.equal(roundFailure(['codex']), 'Codex failed on every application')
  assert.equal(roundFailure(['codex', 'codex', 'codex', 'codex']), 'Codex failed on every application')
  assert.equal(roundFailure(['codex', 'submitted']), null)
})

test('forgiving a round puts its attempts back as they were', () => {
  const before = emptyLoopState()
  before.attempts = { 'lever:a': { count: 1, lastStatus: 'nav_failed', at: 't0' } }
  before.excluded = { 'lever:c': { reason: 'attempts', at: 't0' } }
  let s = recordOutcome(before, 'lever:a', 'retryable', 'nav_failed', NOW)
  assert.equal(s.excluded['lever:a'].reason, 'attempts', 'the second attempt excluded it')
  s = recordOutcome(s, 'lever:b', 'retryable', 'nav_failed', NOW)
  const f = forgiveAttempts(s, ['lever:a', 'lever:b', 'lever:c'], before)
  assert.deepEqual(f.attempts, before.attempts)
  assert.deepEqual(f.excluded, { 'lever:c': { reason: 'attempts', at: 't0' } })
})

test('ratings of mixed provenance never pass for current or for legacy ones', () => {
  assert.notEqual(MIXED_FINGERPRINT, '')
  assert.equal(fingerprintMatches(MIXED_FINGERPRINT, 'fp1', true), false)
})

test('rating health', () => {
  assert.equal(ratingHealth({ enqueued: 0, newlyRated: 0, failedJobs: 0, lastError: '' }), 'ok')
  assert.equal(ratingHealth({ enqueued: 40, newlyRated: 30, failedJobs: 10, lastError: 'x' }), 'ok')
  assert.equal(ratingHealth({ enqueued: 40, newlyRated: 10, failedJobs: 30, lastError: 'timeout' }), 'failed')
  assert.equal(ratingHealth({ enqueued: 40, newlyRated: 0, failedJobs: 40, lastError: 'usage limit reached' }), 'codex_limit')
  // Codex answered, but with scores for almost none of the jobs: still a failure.
  assert.equal(ratingHealth({ enqueued: 40, newlyRated: 5, failedJobs: 0, lastError: '' }), 'failed')
})

// ── settings and history ────────────────────────────────────────────────────

test('settings are clamped to their ranges', () => {
  // A market list saved by an earlier build is dropped: the loop has no market rule.
  assert.deepEqual(clampSettings({ threshold: 0, dailyLimit: 0, minGapMin: 5, allowedMarkets: ['USA', 'usa', ' '] }),
    { threshold: 1, dailyLimit: 1, minGapMin: 15 })
  assert.deepEqual(clampSettings({ threshold: 11, dailyLimit: 9999, minGapMin: 9999 }),
    { threshold: 10, dailyLimit: 500, minGapMin: 1440 })
  assert.equal(clampSettings({ threshold: 7.6 }).threshold, 8)
  assert.deepEqual(clampSettings({}), { threshold: 8, dailyLimit: 25, minGapMin: 60 })
  assert.equal(clampSettings({ threshold: 'banana' }).threshold, 8)
})

test('history keeps the newest 100 rounds', () => {
  let s = emptyLoopState()
  for (let i = 0; i < 101; i++) s = pushHistory(s, { startedAt: String(i) })
  assert.equal(s.history.length, 100)
  assert.equal(s.history[0].startedAt, '100')
  assert.equal(s.history[99].startedAt, '1')
})

test('job keys are platform-qualified', () => {
  assert.equal(jobKey('lever', 'abc'), 'lever:abc')
})

// ── Codex usage limits ──────────────────────────────────────────────────────

const SNAP = { ordinaryUsageAllowed: true, rateLimitReachedType: null,
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1794552000 },
  secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1794720000 } }

test('a healthy account has no exhausted window', () => { assert.equal(exhaustedWindow(SNAP), null) })

test('each window is recognised when it runs out', () => {
  assert.deepEqual(exhaustedWindow({ ...SNAP, primary: { ...SNAP.primary, usedPercent: 100 } }), { window: '5-hour', resetsAt: 1794552000 })
  assert.deepEqual(exhaustedWindow({ ...SNAP, secondary: { ...SNAP.secondary, usedPercent: 100 } }), { window: 'weekly', resetsAt: 1794720000 })
  assert.deepEqual(exhaustedWindow({ ...SNAP, primary: { ...SNAP.primary, usedPercent: 100 }, secondary: { ...SNAP.secondary, usedPercent: 100 } }), { window: 'weekly', resetsAt: 1794720000 })
  assert.deepEqual(exhaustedWindow({ ...SNAP, ordinaryUsageAllowed: false }), { window: 'unknown', resetsAt: null })
  assert.equal(exhaustedWindow(null), null)
})

test('the wait ends 2 minutes after the window resets', () => {
  const r = codexWaitUntil({ snap: { ...SNAP, secondary: { ...SNAP.secondary, usedPercent: 100 } }, errorText: '', now: NOW, backoffStep: 0 })
  assert.equal(+r.until, (1794720000 + 120) * 1000); assert.equal(r.window, 'weekly'); assert.equal(r.nextBackoffStep, 0)
})

test('a reset time already in the past never schedules the wait in the past', () => {
  const stale = { ...SNAP, primary: { ...SNAP.primary, usedPercent: 100, resetsAt: Math.floor(+NOW / 1000) - 3600 } }
  const r = codexWaitUntil({ snap: stale, errorText: '', now: NOW, backoffStep: 0 })
  assert.ok(+r.until > +NOW, 'the wait must end in the future')
})

test('without limits data, the error text gives the reset', () => {
  const now = new Date(2026, 10, 12, 22, 0)
  const msg = "You've hit your usage limit. Upgrade your plan to continue using Codex, or try again in 2 days 3 hours 52 minutes."
  assert.equal(+parseTryAgainIn(msg, now), +now + ((2 * 24 + 3) * 60 + 52) * 60e3)
  assert.equal(+parseTryAgainIn('try again in 45 minutes', now), +now + 45 * 60e3)
  assert.equal(parseTryAgainIn('Codex exited (code=0 signal=none)', now), null)
  const r = codexWaitUntil({ snap: null, errorText: msg, now, backoffStep: 3 })
  assert.equal(+r.until, +now + ((2 * 24 + 3) * 60 + 52) * 60e3 + 120e3)
  assert.equal(r.nextBackoffStep, 0)
})

test('with no reset known, the wait backs off and caps at a day', () => {
  const hours = [0, 1, 2, 3, 4, 5, 6].map(step => (codexWaitUntil({ snap: null, errorText: '', now: NOW, backoffStep: step }).until - NOW) / H)
  assert.deepEqual(hours, [1, 2, 4, 8, 16, 24, 24])
  assert.equal(codexWaitUntil({ snap: null, errorText: '', now: NOW, backoffStep: 2 }).nextBackoffStep, 3)
})

test('a form that merely mentions Claude never stops a Codex round', () => {
  // Reviewer's case: a filler's own failure text that names Claude. On main
  // this was 'retryable'; it must not read as an AI usage limit.
  assert.equal(isCodexLimit('failed: Rate limit exceeded on question "Why do you want to work at Claude?"'), false)
  assert.equal(isCodexLimit('Claude hit your limit of characters for this answer'), false)
  // The Claude engine's own reports still do.
  assert.equal(isCodexLimit("Error: Claude: You've hit your limit · resets 5pm"), true)
  assert.equal(isCodexLimit('Claude: spend limit reached'), true)
  assert.equal(isCodexLimit('Claude: rate limit exceeded'), true)
})

test('no Codex installed is the engine failing, not the job', () => {
  assert.equal(isCodexFailure('Error: Codex CLI was not found. Install it with: npm install -g @openai/codex'), true)
})
