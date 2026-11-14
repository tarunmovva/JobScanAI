// The loop's conductor, driven through fake stages, a manual clock and
// manual timers. Every stage the real app runs is a dep here, so each rule --
// order, stops, failures, Codex limits, the per-job hooks -- runs in
// milliseconds without Chrome, Codex or a database.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const unit = path.join(__dirname, '..', '..', 'out', 'unit', 'electron')
const { createLoop } = require(path.join(unit, 'loop-runner.js'))
const { DEFAULT_LOOP_SETTINGS, emptyLoopState, localDay } = require(path.join(unit, 'loop-policy.js'))

const T0 = new Date(2026, 10, 12, 9, 0)   // local time
const MIN = 60e3
const HOUR = 60 * MIN

const tick = () => new Promise(r => setImmediate(r))
async function until(pred, what) {
  for (let i = 0; i < 2000; i++) { if (pred()) return; await tick() }
  throw new Error(`gave up waiting for ${what}`)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const rated = (platform, id, rating) => ({
  id: `${platform.slice(0, 2)}:co:${id}`, job_id: id, platform, rating,
  posted_at: '2026-11-10', title: `Job ${id}`, company: 'co',
})
const USA = { name: 'backend', flags: `--title-query "'backend'" --market usa` }
const job = (platform, id) => ({ platform, job_id: id, title: `Job ${id}`, company: 'co', apply_url: `https://jobs.example/${platform}/${id}` })
const limits = (o = {}) => ({
  ordinaryUsageAllowed: true,
  primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: Math.round(+T0 / 1000) + 3600 },
  secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: Math.round(+T0 / 1000) + 86400 },
  rateLimitReachedType: null,
  ...o,
})

/** customize(h) returns dep overrides; it can close over h. */
function harness(customize = () => ({})) {
  const h = {
    now: new Date(T0), timers: new Map(), seq: 0,
    calls: [], research: [], applied: [], sweeps: [], cancels: [], closed: [], flags: [], awake: [], statuses: [],
    hooks: null,
    stored: { settings: { ...DEFAULT_LOOP_SETTINGS }, state: emptyLoopState(), breaker: {} },
  }
  h.deps = {
    now: () => new Date(h.now),
    setTimer: (fn, ms) => { const id = ++h.seq; h.timers.set(id, { fn, ms, at: +h.now + ms }); return id },
    clearTimer: id => { h.timers.delete(id) },
    signedIn: async () => true,
    codexLimits: async () => null,
    hasResume: () => true,
    exeExists: () => true,
    isBusy: () => false,
    savedQueries: () => [USA],
    queriesStale: () => false,
    rebuild: async () => { h.calls.push('rebuild'); return 'success' },
    regenerate: async () => { h.calls.push('regenerate'); return { ok: true, newJobs: 0 } },
    research: async o => { h.calls.push('research'); h.research.push(o); return { ok: true, newJobs: 2 } },
    rate: async () => { h.calls.push('rate'); return { health: 'ok', enqueued: 2, newlyRated: 2, failedJobs: 0, lastError: '' } },
    ratedJobs: () => [rated('lever', 'a', 9), rated('ashby', 'b', 8), rated('lever', 'c', 5)],
    isApplied: () => false,
    appliedLog: () => [],
    // Like the board: every picked job reaches an agent, which asks the loop about it.
    apply: async ids => {
      h.calls.push('apply'); h.applied.push(ids)
      for (const id of ids) {
        const j = h.deps.ratedJobs().find(x => x.id === id)
        if (j && h.hooks) h.hooks.beforeFill({ platform: j.platform, job_id: j.job_id })
      }
      return { ok: true, extractFailed: [] }
    },
    cancelPipeline: async reason => { h.cancels.push(reason) },
    sweepPlatform: (platform, reason) => { h.sweeps.push({ platform, reason }) },
    closeTabsFor: url => { h.closed.push(url) },
    load: () => JSON.parse(JSON.stringify(h.stored)),
    saveSettings: s => { h.stored.settings = s },
    saveState: s => { h.stored.state = s },
    saveBreaker: b => { h.stored.breaker = b },
    setUnattended: on => { h.flags.push(['unattended', on]) },
    setHooks: x => { h.hooks = x; h.flags.push(['hooks', !!x]) },
    keepAwake: on => { h.awake.push(on) },
    emit: s => { h.statuses.push(s) },
  }
  Object.assign(h.deps, customize(h))
  h.last = () => h.statuses[h.statuses.length - 1]
  h.phase = () => h.last()?.phase
  h.waitTimer = () => [...h.timers.values()].sort((a, b) => a.at - b.at)[0]
  /** Let time pass to the earliest timer and fire it. */
  h.fireNext = () => {
    const entry = [...h.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (!entry) throw new Error('no timer set')
    h.timers.delete(entry[0])
    h.now = new Date(Math.max(+h.now, entry[1].at))
    entry[1].fn()
  }
  h.settled = what => until(() => ['waiting', 'stopped', 'off'].includes(h.phase()) && !h.inRound(), what)
  h.inRound = () => h.last()?.stage != null
  return h
}

async function startedLoop(customize) {
  const h = harness(customize)
  const loop = createLoop(h.deps)
  assert.deepEqual(await loop.start(), { ok: true })
  await h.settled('round 1')
  return { h, loop }
}

/** An apply that hands the test the hooks and waits to be released. */
function heldApply(h) {
  const release = deferred()
  const entered = deferred()
  return {
    release, entered,
    apply: async ids => {
      h.calls.push('apply'); h.applied.push(ids)
      // Like the board: each picked job reaches an agent, which asks the loop about it.
      for (const id of ids) {
        const j = h.deps.ratedJobs().find(x => x.id === id)
        if (j && h.hooks) h.hooks.beforeFill({ platform: j.platform, job_id: j.job_id })
      }
      entered.resolve()
      return release.promise
    },
  }
}

// ── order and timing ────────────────────────────────────────────────────────

test('a round runs rebuild, search, rate, apply in that order, best jobs first', async () => {
  const { h } = await startedLoop()
  assert.deepEqual(h.calls, ['rebuild', 'research', 'rate', 'apply'])
  assert.deepEqual(h.applied[0], ['le:co:a', 'as:co:b'])
  assert.equal(h.phase(), 'waiting')
  assert.equal(h.stored.state.history.length, 1)
  assert.equal(h.stored.state.history[0].selected, 2)
  assert.equal(h.stored.state.history[0].searched, true)
})

test('the first round has no new-postings pass; later rounds pass the previous start date', async () => {
  const { h } = await startedLoop()
  h.fireNext()
  await until(() => h.research.length === 2, 'round 2 search')
  await h.settled('round 2')
  assert.deepEqual(h.research.map(r => r.sinceDate), [null, localDay(T0)])
})

test('the new-postings pass starts from the last round that got through its searches', async () => {
  let fail = false
  const { h } = await startedLoop(h => ({
    rebuild: async () => { h.calls.push('rebuild'); return fail ? 'failed' : 'success' },
  }))
  fail = true
  h.now = new Date(+T0 + 26 * HOUR)
  h.fireNext()
  await until(() => h.stored.state.history.length === 2, 'round 2')
  fail = false
  h.now = new Date(+T0 + 50 * HOUR)
  h.fireNext()
  await until(() => h.research.length === 2, 'round 3 search')
  assert.equal(h.research[1].sinceDate, localDay(T0))
})

test('queries are regenerated only when their inputs changed', async () => {
  let stale = true
  const { h } = await startedLoop(() => ({ queriesStale: () => stale }))
  assert.deepEqual(h.calls, ['rebuild', 'regenerate', 'research', 'rate', 'apply'])
  stale = false
  h.fireNext()
  await until(() => h.calls.length === 9, 'round 2')
  assert.deepEqual(h.calls.slice(5), ['rebuild', 'research', 'rate', 'apply'])
})

test('every saved search runs as the agent wrote it, whatever its market -- as in a manual run', async () => {
  // The market comes from the target location, through the query agent and
  // the rater, exactly as in a manual run. The loop adds no rule of its own.
  const REMOTE = { name: 'remote', flags: '--title-query x --market remote-global' }
  const { h } = await startedLoop(h => ({ savedQueries: () => [REMOTE] }))
  assert.deepEqual(h.research, [{ sinceDate: null }])
  assert.equal(h.stored.state.history[0].error, undefined)
  assert.equal('skippedSearches' in h.stored.state.history[0], false)
  assert.equal(h.calls.at(-1), 'apply')
  assert.equal('allowedMarkets' in createLoop(h.deps).status().settings, false)
})

test('a regeneration cut short by a Codex usage limit waits for the limit, not counted as a failure', async () => {
  const { h } = await startedLoop(h => ({
    queriesStale: () => true,
    regenerate: async () => { h.calls.push('regenerate'); return { ok: false, newJobs: 0, error: "Search generation failed: Codex: You've hit your usage limit." } },
  }))
  assert.deepEqual(h.calls, ['rebuild', 'regenerate'])
  assert.equal(h.stored.state.history[0].codexLimit, true)
  assert.equal(h.last().waitReason, 'codex_unknown')
})

test('the next round starts no sooner than the gap after this one started', async () => {
  const { h } = await startedLoop(h => ({
    apply: async ids => { h.calls.push('apply'); h.now = new Date(+h.now + 10 * MIN); return { ok: true, extractFailed: [] } },
  }))
  assert.equal(h.waitTimer().ms, 50 * MIN)
  assert.equal(h.last().nextAt, new Date(+T0 + 60 * MIN).toISOString())
})

test('a timer firing while a round runs is ignored', async () => {
  const { h } = await startedLoop()
  const held = heldApply(h)
  h.deps.apply = held.apply
  const wake = h.waitTimer().fn
  h.timers.clear()
  h.now = new Date(+T0 + HOUR)
  wake()
  await held.entered.promise
  wake()   // the PC woke late and fired again
  await tick()
  held.release.resolve({ ok: true, extractFailed: [] })
  await h.settled('round 2')
  assert.equal(h.calls.filter(c => c === 'rebuild').length, 2)
})

// ── failures ────────────────────────────────────────────────────────────────

test('a failed rebuild fails the round and schedules the next', async () => {
  const { h } = await startedLoop(() => ({ rebuild: async () => 'failed' }))
  assert.equal(h.phase(), 'waiting')
  assert.equal(h.stored.state.history[0].error, 'Rebuild failed')
  assert.equal(h.applied.length, 0)
  assert.ok(h.waitTimer())
})

test('a stage that did not run aborts the round instead of continuing', async () => {
  const { h } = await startedLoop(h => ({ rebuild: async () => { h.calls.push('rebuild'); return 'canceled' } }))
  assert.deepEqual(h.calls, ['rebuild'])
  assert.equal(h.stored.state.history[0].error, 'Rebuild failed')
})

test('a stage that throws fails the round with that stage\'s error', async () => {
  const { h } = await startedLoop(h => ({ rate: async () => { h.calls.push('rate'); throw new Error('boom') } }))
  assert.deepEqual(h.calls, ['rebuild', 'research', 'rate'])
  assert.equal(h.stored.state.history[0].error, 'Rating failed')
})

test('failed stages never count as empty rounds', async () => {
  const a = await startedLoop(h => ({
    research: async () => { h.calls.push('research'); return { ok: false, newJobs: 0, error: 'Searches returned no jobs' } },
  }))
  assert.deepEqual(a.h.calls, ['rebuild', 'research'])
  assert.equal(a.h.stored.state.history[0].error, 'Searches returned no jobs')
  const b = await startedLoop(h => ({
    rate: async () => { h.calls.push('rate'); return { health: 'failed', enqueued: 10, newlyRated: 2, failedJobs: 8, lastError: 'Codex exited' } },
  }))
  assert.deepEqual(b.h.calls, ['rebuild', 'research', 'rate'])
  assert.equal(b.h.stored.state.history[0].error, 'Rating failed')
})

test('three failed rounds in a row stop the loop with the last error', async () => {
  const { h } = await startedLoop(() => ({ rebuild: async () => 'failed' }))
  h.fireNext(); await until(() => h.stored.state.history.length === 2, 'round 2')
  h.fireNext(); await until(() => h.phase() === 'stopped', 'auto-stop')
  assert.equal(h.last().stopReason, 'Rebuild failed')
  assert.equal(h.timers.size, 0)
  assert.equal(h.awake.at(-1), false)
})

test('a complete round resets the count of failed rounds', async () => {
  let fail = true
  const { h } = await startedLoop(() => ({ rebuild: async () => (fail ? 'failed' : 'success') }))
  h.fireNext(); await until(() => h.stored.state.history.length === 2, 'round 2')
  fail = false
  h.fireNext(); await until(() => h.stored.state.history.length === 3, 'round 3')
  fail = true
  h.fireNext(); await until(() => h.stored.state.history.length === 4, 'round 4')
  h.fireNext(); await until(() => h.stored.state.history.length === 5, 'round 5')
  await h.settled('round 5')
  assert.equal(h.phase(), 'waiting')
})

test('nothing above threshold is a complete round, not a failure', async () => {
  let fail = true
  const { h } = await startedLoop(() => ({
    rebuild: async () => (fail ? 'failed' : 'success'),
    ratedJobs: () => [rated('lever', 'a', 7), rated('ashby', 'b', 3)],
  }))
  h.fireNext(); await until(() => h.stored.state.history.length === 2, 'round 2')
  fail = false
  h.fireNext(); await until(() => h.stored.state.history.length === 3, 'round 3')
  assert.equal(h.applied.length, 0)
  assert.equal(h.stored.state.history[0].selected, 0)
  assert.equal(h.stored.state.history[0].error, undefined)
  fail = true
  h.fireNext(); await until(() => h.stored.state.history.length === 4, 'round 4')
  h.fireNext(); await until(() => h.stored.state.history.length === 5, 'round 5')
  await h.settled('round 5')
  assert.equal(h.phase(), 'waiting')
})

test('a round where every application failed fails, and does not use up those jobs', async () => {
  const many = ['a', 'b', 'c'].map(id => rated('lever', id, 9))
  const { h } = await startedLoop(h => ({
    ratedJobs: () => many,
    apply: async ids => {
      h.calls.push('apply')
      for (const id of ['a', 'b', 'c']) {
        h.hooks.onFillStart(job('lever', id))
        h.hooks.onResult({ ...job('lever', id), submitted: false, status: 'nav_failed', detail: 'nav_failed', timedOut: false })
      }
      return { ok: true, extractFailed: [] }
    },
  }))
  assert.equal(h.stored.state.history[0].error, 'Every application failed')
  assert.deepEqual(h.stored.state.attempts, {})
  assert.deepEqual(h.stored.state.excluded, {})
})

test('one failed application counts against that job, not the round', async () => {
  const { h } = await startedLoop(h => ({
    apply: async ids => {
      h.calls.push('apply')
      h.hooks.onFillStart(job('lever', 'a'))
      h.hooks.onResult({ ...job('lever', 'a'), submitted: false, status: 'validation_errors', detail: 'validation_errors', timedOut: false })
      h.hooks.onFillStart(job('ashby', 'b'))
      h.hooks.onResult({ ...job('ashby', 'b'), submitted: true, status: 'submitted', detail: 'submitted', timedOut: false })
      return { ok: true, extractFailed: [] }
    },
  }))
  assert.equal(h.stored.state.history[0].error, undefined)
  assert.equal(h.stored.state.history[0].submitted, 1)
  assert.equal(h.stored.state.history[0].failed, 1)
  assert.equal(h.stored.state.attempts['lever:a'].count, 1)
})

test('a form that could not be read counts as an attempt', async () => {
  const { h } = await startedLoop(h => ({
    apply: async ids => { h.calls.push('apply'); return { ok: true, extractFailed: [{ platform: 'lever', jobId: 'a' }] } },
  }))
  assert.equal(h.stored.state.attempts['lever:a'].count, 1)
  h.fireNext()
  await until(() => h.stored.state.history.length === 2, 'round 2')
  assert.equal(h.stored.state.excluded['lever:a'].reason, 'attempts')
})

test('a round past 3 hours is cancelled and fails', async () => {
  const h = harness()
  const held = heldApply(h)
  h.deps.apply = held.apply
  h.deps.cancelPipeline = async reason => { h.cancels.push(reason); held.release.resolve({ ok: false, extractFailed: [] }) }
  const loop = createLoop(h.deps)
  await loop.start()
  await held.entered.promise
  h.fireNext()   // the only timer during a round: its deadline
  await h.settled('timed-out round')
  assert.deepEqual(h.cancels, ['loop:round-timeout'])
  assert.equal(h.stored.state.history[0].error, 'Round took longer than 3 hours')
  assert.equal(h.phase(), 'waiting')
})

test('a round that cannot be cancelled still ends at its deadline', async () => {
  const h = harness()
  const held = heldApply(h)   // never released
  h.deps.apply = held.apply
  const loop = createLoop(h.deps)
  await loop.start()
  await held.entered.promise
  h.fireNext()
  await h.settled('abandoned round')
  assert.equal(h.stored.state.history[0].error, 'Round took longer than 3 hours')
})

// ── Codex usage limits ──────────────────────────────────────────────────────

test('a Codex usage limit waits without counting toward auto-stop', async () => {
  const { h } = await startedLoop(h => ({
    rate: async () => { h.calls.push('rate'); return { health: 'codex_limit', enqueued: 10, newlyRated: 0, failedJobs: 10, lastError: 'Codex: usage limit' } },
  }))
  for (let i = 2; i <= 5; i++) {
    h.fireNext()
    await until(() => h.stored.state.history.length === i, `round ${i}`)
  }
  await h.settled('round 5')
  assert.equal(h.phase(), 'waiting')
  assert.equal(h.stored.state.history[0].codexLimit, true)
})

test('an exhausted weekly window keeps the round from starting and waits for its reset', async () => {
  const R = Math.round(+T0 / 1000) + 2 * 86400
  const { h } = await startedLoop(() => ({
    codexLimits: async () => limits({ secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: R } }),
  }))
  assert.deepEqual(h.calls, [])
  assert.equal(h.last().nextAt, new Date((R + 120) * 1000).toISOString())
  assert.equal(h.last().waitReason, 'codex_weekly')
  assert.deepEqual(h.last().codexUsage, { fiveHour: 10, weekly: 100 })
})

test('limits are checked again before rating and before applying', async () => {
  let reads = 0
  const a = await startedLoop(() => ({
    codexLimits: async () => (++reads >= 2 ? limits({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.round(+T0 / 1000) + 3600 } }) : limits()),
  }))
  assert.deepEqual(a.h.calls, ['rebuild', 'research'])
  assert.equal(a.h.last().waitReason, 'codex_5h')
  let reads2 = 0
  const b = await startedLoop(() => ({
    codexLimits: async () => (++reads2 >= 3 ? limits({ ordinaryUsageAllowed: false }) : limits()),
  }))
  assert.deepEqual(b.h.calls, ['rebuild', 'research', 'rate'])
})

test('a usage limit mid-round stops new jobs and ends the round early', async () => {
  let view, gate
  const { h } = await startedLoop(h => ({
    apply: async ids => {
      h.calls.push('apply')
      assert.deepEqual(h.hooks.beforeFill(job('lever', 'a')), { skip: false })
      view = h.hooks.onResult({ ...job('lever', 'a'), submitted: false, status: 'error', detail: "Codex: You've hit your usage limit. Try again in 3 hours.", timedOut: false })
      gate = h.hooks.beforeFill(job('ashby', 'b'))
      return { ok: true, extractFailed: [] }
    },
  }))
  assert.equal(gate.skip, true)
  assert.match(gate.reason, /Codex usage limit/)
  assert.equal(view.asSkipped, true)
  assert.deepEqual(h.stored.state.excluded, {})
  assert.deepEqual(h.stored.state.attempts, {})
  assert.equal(h.stored.state.history[0].codexLimit, true)
  assert.equal(h.last().nextAt, new Date(+T0 + 3 * HOUR + 2 * MIN).toISOString())
})

test('an unknown reset backs off 1, 2, 4 hours and resets after a round that gets past rating', async () => {
  let limited = true
  const { h } = await startedLoop(h => ({
    rate: async () => (limited
      ? { health: 'codex_limit', enqueued: 4, newlyRated: 0, failedJobs: 4, lastError: 'Codex: usage limit reached' }
      : { health: 'ok', enqueued: 0, newlyRated: 0, failedJobs: 0, lastError: '' }),
  }))
  const waits = [h.waitTimer().ms]
  for (let i = 2; i <= 3; i++) {
    h.fireNext()
    await until(() => h.stored.state.history.length === i, `round ${i}`)
    await h.settled(`round ${i}`)
    waits.push(h.waitTimer().ms)
  }
  assert.deepEqual(waits, [1 * HOUR, 2 * HOUR, 4 * HOUR])
  limited = false
  h.fireNext(); await until(() => h.stored.state.history.length === 4, 'round 4'); await h.settled('round 4')
  limited = true
  h.fireNext(); await until(() => h.stored.state.history.length === 5, 'round 5'); await h.settled('round 5')
  assert.equal(h.waitTimer().ms, 1 * HOUR)
})

// ── preconditions ───────────────────────────────────────────────────────────

test('a precondition failure refuses to start, or stops at the next round', async () => {
  const h = harness(() => ({ signedIn: async () => false }))
  const loop = createLoop(h.deps)
  assert.deepEqual(await loop.start(), { ok: false, reason: 'Codex is not signed in' })
  assert.equal(loop.isOn(), false)
  assert.deepEqual(h.awake, [])

  let signedIn = true
  const { h: h2 } = await startedLoop(() => ({ signedIn: async () => signedIn }))
  signedIn = false
  h2.fireNext()
  await until(() => h2.phase() === 'stopped', 'stop')
  assert.equal(h2.last().stopReason, 'Codex is not signed in')
  assert.equal(h2.awake.at(-1), false)
})

test('every precondition names what is missing', async () => {
  const cases = [
    [{ hasResume: () => false }, 'No resume'],
    [{ savedQueries: () => [] }, 'No saved searches — run Find Jobs once first'],
    [{ exeExists: () => false }, 'jobscan executable not found'],
    [{ isBusy: () => true }, 'Another step is still running'],
  ]
  for (const [over, reason] of cases) {
    const h = harness(() => over)
    assert.deepEqual(await createLoop(h.deps).start(), { ok: false, reason })
  }
})

test('starting twice is refused while the loop is on', async () => {
  const { loop } = await startedLoop()
  assert.deepEqual(await loop.start(), { ok: false, reason: 'Loop mode is already on' })
})

test('starting sweeps jobs left in flight by a crash into exclusions', async () => {
  const h = harness()
  h.stored.state.inFlight = { 'lever:z': new Date(+T0 - HOUR).toISOString() }
  await createLoop(h.deps).start()
  await h.settled('round 1')
  assert.equal(h.stored.state.excluded['lever:z'].reason, 'interrupted')
  assert.deepEqual(h.stored.state.inFlight, {})
})

// ── stopping ────────────────────────────────────────────────────────────────

test('stop after this round lets the board finish and starts nothing new', async () => {
  const h = harness()
  const held = heldApply(h)
  h.deps.apply = held.apply
  const loop = createLoop(h.deps)
  await loop.start()
  await held.entered.promise
  loop.stopAfterRound()
  assert.equal(h.phase(), 'stopping')
  held.release.resolve({ ok: true, extractFailed: [] })
  await until(() => h.phase() === 'off', 'off')
  assert.deepEqual(h.cancels, [])
  assert.equal(h.timers.size, 0)
  assert.equal(h.last().stopReason, 'Stopped by you')
  assert.equal(h.stored.state.history[0].error, undefined)
  assert.equal(loop.isOn(), false)
})

test('stop now cancels the pipeline, excludes and closes jobs that were filling', async () => {
  const h = harness()
  const held = heldApply(h)
  h.deps.apply = held.apply
  h.deps.cancelPipeline = async reason => { h.cancels.push(reason); held.release.resolve({ ok: false, extractFailed: [] }) }
  const loop = createLoop(h.deps)
  await loop.start()
  await held.entered.promise
  const U = 'https://jobs.lever.co/co/a'
  h.hooks.onFillStart({ platform: 'lever', job_id: 'a', apply_url: U })
  await loop.stopNow()
  await until(() => h.phase() === 'off', 'off')
  assert.deepEqual(h.cancels, ['loop:stop-now'])
  assert.equal(h.stored.state.excluded['lever:a'].reason, 'interrupted')
  assert.ok(h.closed.includes(U))
  assert.equal(h.last().stopReason, 'Stopped by you')
  assert.equal(h.timers.size, 0)
})

test('stop while waiting clears the timer', async () => {
  const a = await startedLoop()
  a.loop.stopAfterRound()
  assert.equal(a.h.timers.size, 0)
  assert.equal(a.h.phase(), 'off')
  const b = await startedLoop()
  await b.loop.stopNow()
  assert.equal(b.h.timers.size, 0)
  assert.equal(b.h.phase(), 'off')
  assert.deepEqual(b.h.cancels, [])
})

test('quitting leaves the reason for the next launch', async () => {
  const { h, loop } = await startedLoop()
  loop.markClosedByQuit()
  assert.equal(h.stored.state.lastStopReason, 'The app was closed during round 1')
})

// ── settings, flags, status ─────────────────────────────────────────────────

test('settings changed while waiting apply to the next round', async () => {
  const { h, loop } = await startedLoop()
  assert.equal(loop.updateSettings({ threshold: 9 }).threshold, 9)
  assert.equal(h.stored.settings.threshold, 9)
  h.fireNext()
  await until(() => h.applied.length === 2, 'round 2 apply')
  assert.deepEqual(h.applied[1], ['le:co:a'])
})

test('unattended flag and hooks are on only during apply, even when apply throws', async () => {
  const { h } = await startedLoop(h => ({ apply: async () => { h.calls.push('apply'); throw new Error('board crashed') } }))
  assert.deepEqual(h.flags, [['unattended', true], ['hooks', true], ['unattended', false], ['hooks', false]])
  assert.equal(h.stored.state.history[0].error, 'Applying failed')
})

test('keep-awake is on while running or waiting and off when stopped', async () => {
  const { h, loop } = await startedLoop()
  assert.deepEqual(h.awake, [true])
  loop.stopAfterRound()
  assert.deepEqual(h.awake, [true, false])
})

test('status lists paused platforms, exclusions and today', async () => {
  const h = harness()
  const until2 = new Date(+T0 + 2 * HOUR).toISOString()
  h.stored.breaker = { lever: { consecutive: 0, trips: 1, pausedUntil: until2 }, ashby: { consecutive: 1, trips: 0, pausedUntil: '' } }
  h.stored.state.excluded = { 'lever:q': { reason: 'captcha', at: T0.toISOString(), title: 'Q', company: 'co' } }
  h.stored.state.day = { date: localDay(new Date(+T0 - 86400e3)), attempted: 7 }
  const s = createLoop(h.deps).status()
  assert.deepEqual(s.paused, [{ platform: 'lever', until: until2 }])
  assert.deepEqual(s.excluded, [{ key: 'lever:q', reason: 'captcha', at: T0.toISOString(), title: 'Q', company: 'co' }])
  assert.deepEqual(s.today, { attempted: 0, limit: 25 })
  assert.equal('searchMarkets' in s, false)
  assert.equal(s.phase, 'off')
})

// ── the per-job hooks ───────────────────────────────────────────────────────

async function duringApply(customize, body) {
  const h = harness(customize)
  const held = heldApply(h)
  h.deps.apply = held.apply
  const loop = createLoop(h.deps)
  await loop.start()
  await held.entered.promise
  await body(h, loop)
  held.release.resolve({ ok: true, extractFailed: [] })
  await h.settled('round')
  return h
}

test('hooks: a platform paused mid-round is skipped before filling', async () => {
  // A platform paused before the round is never picked; one paused during it
  // still has picked jobs waiting.
  await duringApply(h => ({
    ratedJobs: () => [rated('lever', 'a', 9), rated('lever', 'd', 9), rated('lever', 'e', 9), rated('ashby', 'b', 9)],
  }), h => {
    for (const id of ['a', 'd']) {
      h.hooks.onFillStart(job('lever', id))
      h.hooks.onResult({ ...job('lever', id), submitted: false, status: 'blocked_captcha_puzzle', detail: 'blocked_captcha_puzzle', timedOut: false })
    }
    const gate = h.hooks.beforeFill(job('lever', 'e'))
    assert.equal(gate.skip, true)
    assert.match(gate.reason, /paused until/)
    assert.deepEqual(h.hooks.beforeFill(job('ashby', 'b')), { skip: false })
  })
})

test('hooks: asking before a fill changes nothing', async () => {
  await duringApply(undefined, h => {
    const before = JSON.stringify([h.stored.state, h.stored.breaker])
    h.hooks.beforeFill(job('lever', 'a'))
    h.hooks.beforeFill(job('lever', 'a'))
    assert.equal(JSON.stringify([h.stored.state, h.stored.breaker]), before)
  })
})

test('hooks: the second CAPTCHA trips the breaker and sweeps that platform once', async () => {
  await duringApply(undefined, h => {
    const views = ['a', 'b', 'c'].map(id => {
      h.hooks.onFillStart(job('lever', id))
      return h.hooks.onResult({ ...job('lever', id), submitted: false, status: 'blocked_captcha_puzzle', detail: 'blocked_captcha_puzzle', timedOut: false })
    })
    assert.ok(views.every(v => v.asSkipped))
    assert.match(views[0].message, /CAPTCHA/)
    assert.match(views[0].message, /not applied/)
    assert.deepEqual(h.sweeps.map(s => s.platform), ['lever'])
    assert.match(h.sweeps[0].reason, /paused until/)
    for (const id of ['a', 'b', 'c']) assert.equal(h.stored.state.excluded[`lever:${id}`].reason, 'captcha')
    assert.ok(h.stored.breaker.lever.pausedUntil)
  })
})

test('hooks: a timed-out filler is interrupted, not retried', async () => {
  await duringApply(undefined, h => {
    h.hooks.onFillStart(job('lever', 'a'))
    const view = h.hooks.onResult({ ...job('lever', 'a'), submitted: false, status: 'timed_out', detail: 'timed_out', timedOut: true })
    assert.equal(view.asSkipped, true)
    assert.match(view.message, /may have gone in/)
    assert.equal(h.stored.state.excluded['lever:a'].reason, 'interrupted')
    assert.deepEqual(h.stored.state.attempts, {})
    assert.deepEqual(h.stored.state.inFlight, {})
  })
})

test('hooks: a submission clears the platform and is counted', async () => {
  const h = await duringApply(h => {
    h.stored.breaker = { lever: { consecutive: 1, trips: 0, pausedUntil: '' } }
    return {}
  }, h => {
    h.hooks.onFillStart(job('lever', 'a'))
    const view = h.hooks.onResult({ ...job('lever', 'a'), submitted: true, status: 'submitted', detail: 'submitted', timedOut: false })
    assert.equal(view.asSkipped, false)
    assert.equal(h.stored.breaker.lever, undefined)
  })
  assert.equal(h.stored.state.history[0].submitted, 1)
})

test('hooks: each filler start counts toward today, and the limit holds across rounds', async () => {
  const many = ['a', 'b', 'c', 'd'].map(id => rated('ashby', id, 9))
  const { h } = await startedLoop(h => {
    h.stored.settings.dailyLimit = 3
    return {
      ratedJobs: () => many,
      apply: async ids => {
        h.calls.push('apply'); h.applied.push(ids)
        const id = ids[0].split(':')[2]
        h.hooks.onFillStart(job('ashby', id))
        h.hooks.onResult({ ...job('ashby', id), submitted: true, status: 'submitted', detail: 'submitted', timedOut: false })
        return { ok: true, extractFailed: [] }
      },
    }
  })
  assert.equal(h.applied[0].length, 3)
  assert.equal(h.last().today.attempted, 1)
  h.fireNext()
  await until(() => h.applied.length === 2, 'round 2')
  assert.equal(h.applied[1].length, 2)
  await h.settled('round 2')
  h.fireNext()
  await until(() => h.applied.length === 3, 'round 3')
  assert.equal(h.applied[2].length, 1)
  await h.settled('round 3')
  // The day's limit is used up: the next round waits for local midnight.
  assert.equal(h.last().nextAt, new Date(2026, 10, 13, 0, 0, 0, 0).toISOString())
})

test('hooks: the day\'s limit holds within a round too', async () => {
  // A round picks no more than the day has left, so only a picked job asked
  // about again -- claimed a second time -- can meet the limit mid-round.
  await duringApply(h => { h.stored.settings.dailyLimit = 2; return {} }, h => {
    h.hooks.onFillStart(job('lever', 'a'))
    h.hooks.onFillStart(job('ashby', 'b'))
    const gate = h.hooks.beforeFill(job('lever', 'a'))
    assert.equal(gate.skip, true)
    assert.match(gate.reason, /limit/)
  })
})

test('while off, the loop shows and edits the profile that is active now', async () => {
  const h = harness()
  const loop = createLoop(h.deps)
  // The user switches profile while the loop is off: the store now holds B.
  h.stored.settings = { ...DEFAULT_LOOP_SETTINGS, threshold: 6 }
  h.stored.state = { ...emptyLoopState(), excluded: { 'ashby:z': { reason: 'captcha', at: T0.toISOString() } } }
  const s = loop.status()
  assert.equal(s.settings.threshold, 6)
  assert.deepEqual(s.excluded.map(e => e.key), ['ashby:z'])
  loop.updateSettings({ dailyLimit: 5 })
  assert.deepEqual(h.stored.settings, { ...DEFAULT_LOOP_SETTINGS, threshold: 6, dailyLimit: 5 })
})

// ── found in review ─────────────────────────────────────────────────────────

for (const how of ['after-round', 'now']) {
  test(`a stop pressed while a Codex-limit round is wrapping up still stops (${how})`, async () => {
    // The limit hit mid-round; the round re-reads the limits for the reset
    // time. A stop pressed during that read must not be lost.
    let reads = 0
    const read = deferred()
    const h = harness(h => ({
      // Reads 1 and 2: round start and before rating. Read 3: the wrap-up's re-read.
      codexLimits: async () => (++reads <= 2 ? null : read.promise),
      rate: async () => { h.calls.push('rate'); return { health: 'codex_limit', enqueued: 3, newlyRated: 0, failedJobs: 3, lastError: 'Codex: usage limit' } },
    }))
    const loop = createLoop(h.deps)
    await loop.start()
    await until(() => reads === 3, 'the re-read')
    if (how === 'now') await loop.stopNow()
    else loop.stopAfterRound()
    read.resolve(null)
    await until(() => h.phase() === 'off', 'off')
    assert.equal(h.timers.size, 0)
    assert.equal(loop.isOn(), false)
    for (let i = 0; i < 20; i++) await tick()
    assert.equal(h.calls.filter(c => c === 'rebuild').length, 1, 'no second round')
  })
}

test('a submit clicked but never confirmed is excluded, never retried, never forgiven', async () => {
  const many = ['a', 'b', 'c'].map(id => rated('greenhouse', id, 9))
  const { h } = await startedLoop(h => ({
    ratedJobs: () => many,
    apply: async ids => {
      h.calls.push('apply'); h.applied.push(ids)
      for (const id of ids.map(x => x.split(':')[2])) {
        h.hooks.onFillStart(job('greenhouse', id))
        const view = h.hooks.onResult({ ...job('greenhouse', id), submitted: false, status: 'clicked', detail: 'clicked', timedOut: false })
        assert.equal(view.asSkipped, true)
        assert.match(view.message, /may have gone in/)
      }
      return { ok: true, extractFailed: [] }
    },
  }))
  assert.equal(h.stored.state.history[0].error, undefined)
  for (const id of ['a', 'b', 'c']) assert.equal(h.stored.state.excluded[`greenhouse:${id}`].reason, 'unconfirmed')
  h.fireNext()
  await until(() => h.stored.state.history.length === 2, 'round 2')
  assert.equal(h.applied.length, 1, 'none of them was picked again')
})

test('Codex failing on every application fails the round, and three in a row stop the loop', async () => {
  const { h } = await startedLoop(h => ({
    apply: async ids => {
      h.calls.push('apply')
      for (const id of ids) {
        const j = h.deps.ratedJobs().find(x => x.id === id)
        h.hooks.onResult({ ...job(j.platform, j.job_id), submitted: false, status: 'error', detail: 'Error: Codex exited (code=1 signal=none)', timedOut: false })
      }
      return { ok: true, extractFailed: [] }
    },
  }))
  assert.equal(h.stored.state.history[0].error, 'Codex failed on every application')
  h.fireNext(); await until(() => h.stored.state.history.length === 2, 'round 2')
  h.fireNext(); await until(() => h.phase() === 'stopped', 'auto-stop')
  assert.equal(h.last().stopReason, 'Codex failed on every application')
})

test('a round whose every fill was cut off fails, and the jobs stay excluded', async () => {
  const many = ['a', 'b', 'c'].map(id => rated('lever', id, 9))
  const { h } = await startedLoop(h => ({
    ratedJobs: () => many,
    apply: async ids => {
      h.calls.push('apply')
      for (const id of ['a', 'b', 'c']) {
        h.hooks.onFillStart(job('lever', id))
        h.hooks.onResult({ ...job('lever', id), submitted: false, status: 'timed_out', detail: 'timed_out', timedOut: true })
      }
      return { ok: true, extractFailed: [] }
    },
  }))
  assert.equal(h.stored.state.history[0].error, 'Every application failed')
  for (const id of ['a', 'b', 'c']) assert.equal(h.stored.state.excluded[`lever:${id}`].reason, 'interrupted')
})

test('a picked job that never reached an agent is not passed off as nothing', async () => {
  // Found live: extraction gave no answer, so no agent ever claimed the job,
  // and the round counted as complete.
  const { h } = await startedLoop(h => ({
    ratedJobs: () => [rated('ashby', 'only', 9)],
    apply: async ids => { h.calls.push('apply'); return { ok: true, extractFailed: [] } },
  }))
  assert.equal(h.stored.state.history[0].error, 'Applying reached none of the picked jobs')
  assert.equal(h.stored.state.history[0].failed, 1)
  assert.deepEqual(h.stored.state.attempts, {}, 'a broken setup, not the job: no attempt charged')
})

test('jobs of a platform the breaker paused mid-round are not charged', async () => {
  const { h } = await startedLoop(h => ({
    ratedJobs: () => [rated('lever', 'a', 9), rated('lever', 'd', 9), rated('lever', 'e', 9), rated('ashby', 'b', 9)],
    apply: async ids => {
      h.calls.push('apply')
      for (const id of ['a', 'd']) {
        h.hooks.beforeFill(job('lever', id))
        h.hooks.onFillStart(job('lever', id))
        h.hooks.onResult({ ...job('lever', id), submitted: false, status: 'blocked_captcha_puzzle', detail: 'blocked_captcha_puzzle', timedOut: false })
      }
      h.hooks.beforeFill(job('ashby', 'b'))
      h.hooks.onFillStart(job('ashby', 'b'))
      h.hooks.onResult({ ...job('ashby', 'b'), submitted: true, status: 'submitted', detail: 'submitted', timedOut: false })
      // lever/e: swept with its platform, never claimed.
      return { ok: true, extractFailed: [] }
    },
  }))
  assert.deepEqual(h.sweeps.map(s => s.platform), ['lever'])
  assert.equal(h.stored.state.attempts['lever:e'], undefined, 'charged for a pause that was not its doing')
  assert.equal(h.stored.state.excluded['lever:e'], undefined)
  assert.equal(h.stored.state.history[0].skipped, 3, 'two CAPTCHAs and the job swept with its platform')
  assert.equal(h.stored.state.history[0].error, undefined)
})

test('a form never tried because a command failed is not charged', async () => {
  const { h } = await startedLoop(h => ({
    apply: async ids => {
      h.calls.push('apply')
      h.hooks.beforeFill(job('lever', 'a'))
      h.hooks.onFillStart(job('lever', 'a'))
      h.hooks.onResult({ ...job('lever', 'a'), submitted: true, status: 'submitted', detail: 'submitted', timedOut: false })
      return { ok: true, extractFailed: [{ platform: 'ashby', jobId: 'b', setupFailed: true }] }
    },
  }))
  assert.equal(h.stored.state.attempts['ashby:b'], undefined)
  assert.equal(h.stored.state.history[0].failed, 0)
  assert.equal(h.stored.state.history[0].skipped, 1)
})

test('extraction failing for every picked job fails the round without charging', async () => {
  const { h } = await startedLoop(h => ({
    apply: async ids => {
      h.calls.push('apply')
      return { ok: true, extractFailed: [{ platform: 'lever', jobId: 'a', setupFailed: true }, { platform: 'ashby', jobId: 'b', setupFailed: true }] }
    },
  }))
  assert.equal(h.stored.state.history[0].error, 'Applying reached none of the picked jobs')
  assert.deepEqual(h.stored.state.attempts, {})
  assert.equal(h.stored.state.day.attempted, 0)
})

test('hooks: a claimed job this round did not pick is never filled', async () => {
  // The extractor reads every queued row and agents claim every extracted
  // one: a row an earlier run left behind must not be filled in this one.
  // It is no job of this round's: not counted, and not in the history.
  const h = await duringApply(h => {
    h.stored.breaker = { greenhouse: { consecutive: 0, trips: 1, pausedUntil: new Date(+T0 + 2 * HOUR).toISOString() } }
    return {}
  }, h => {
    const gate = h.hooks.beforeFill(job('greenhouse', 'left-over'))
    assert.equal(gate.skip, true)
    assert.equal(gate.notPicked, true)
    assert.match(gate.reason, /not picked/i, 'another check answered first')
    assert.deepEqual(h.hooks.beforeFill(job('lever', 'a')), { skip: false })
  })
  assert.equal(h.stored.state.history[0].skipped, 0)
})

test('a fill that started and never reported is excluded when the round ends', async () => {
  // It may have gone in: it must never be picked again.
  const { h } = await startedLoop(h => ({
    apply: async ids => {
      h.calls.push('apply')
      h.hooks.beforeFill(job('lever', 'a'))
      h.hooks.onFillStart(job('lever', 'a'))
      h.hooks.beforeFill(job('ashby', 'b'))
      h.hooks.onFillStart(job('ashby', 'b'))
      h.hooks.onResult({ ...job('ashby', 'b'), submitted: true, status: 'submitted', detail: 'submitted', timedOut: false })
      return { ok: true, extractFailed: [] }   // lever/a never reported
    },
  }))
  assert.deepEqual(h.stored.state.inFlight, {})
  assert.equal(h.stored.state.excluded['lever:a'].reason, 'interrupted')
  assert.ok(h.closed.includes('https://jobs.example/lever/a'), 'its tab was left open')
})

test('of the picked jobs, one that no agent reached counts as an attempt', async () => {
  const { h } = await startedLoop(h => ({
    apply: async ids => {
      h.calls.push('apply')
      h.hooks.beforeFill(job('lever', 'a'))
      h.hooks.onFillStart(job('lever', 'a'))
      h.hooks.onResult({ ...job('lever', 'a'), submitted: true, status: 'submitted', detail: 'submitted', timedOut: false })
      return { ok: true, extractFailed: [] }
    },
  }))
  assert.equal(h.stored.state.history[0].error, undefined)
  assert.equal(h.stored.state.attempts['ashby:b'].count, 1)
  assert.equal(h.stored.state.attempts['ashby:b'].lastStatus, 'not_reached')
})
