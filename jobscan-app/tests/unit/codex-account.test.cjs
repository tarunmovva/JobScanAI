// What the app reads from the user's Codex account, and what it must never send.
//
// Loop mode waits out Codex usage limits by reading them. The account also
// holds reset credits ("Full reset (Weekly + 5 hr)"); those belong to the
// user, and nothing in the app may spend one.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { mapRateLimits, loginStatusFrom, RATE_LIMITS_READ } =
  require(path.join(__dirname, '..', '..', 'out', 'unit', 'electron', 'codex-account.js'))

// The shape `account/rateLimits/read` returns (Codex CLI 0.167.2), with made-up values.
const SAMPLE = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex', limitName: null, normalModelSlug: null,
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1794552000 },
    secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1794720000 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    individualLimit: null, spendControlReached: false, planType: 'pro', rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {},
  rateLimitResetCredits: { availableCount: 2, credits: [{ id: 'x', resetType: 'codexRateLimits', status: 'available' }] },
}

test('a rate-limit answer of the real shape maps to both windows', () => {
  assert.deepEqual(mapRateLimits(SAMPLE), {
    ordinaryUsageAllowed: true,
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1794552000 },
    secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1794720000 },
    rateLimitReachedType: null,
  })
})

test('a reached limit and blocked usage come through', () => {
  const r = mapRateLimits({
    ordinaryUsageAllowed: false,
    rateLimits: { ...SAMPLE.rateLimits, rateLimitReachedType: 'secondary', secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1794720000 } },
  })
  assert.equal(r.ordinaryUsageAllowed, false)
  assert.equal(r.rateLimitReachedType, 'secondary')
  assert.equal(r.secondary.usedPercent, 100)
})

test('missing pieces read as unknown, not as exhausted', () => {
  const r = mapRateLimits({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 } } })
  assert.deepEqual(r, {
    ordinaryUsageAllowed: true,
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
    secondary: null,
    rateLimitReachedType: null,
  })
  const halfBroken = mapRateLimits({ rateLimits: {
    primary: { usedPercent: 'lots' },
    secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1 },
  } })
  assert.equal(halfBroken.primary, null)
  assert.equal(halfBroken.secondary.usedPercent, 30)
})

test('an answer with no limits in it is no answer', () => {
  assert.equal(mapRateLimits(null), null)
  assert.equal(mapRateLimits('nope'), null)
  assert.equal(mapRateLimits({}), null)
  assert.equal(mapRateLimits({ rateLimits: {} }), null)
})

test('codex login status: signed in, signed out, or unknown', () => {
  assert.equal(loginStatusFrom(0, 'Logged in using ChatGPT\n'), true)  // verbatim, 2026-11-13
  assert.equal(loginStatusFrom(1, 'Not logged in\n'), false)
  assert.equal(loginStatusFrom(0, 'Error: not logged in'), false)
  assert.equal(loginStatusFrom(1, 'thread main panicked'), null)
  assert.equal(loginStatusFrom(null, ''), null)
})

test('the only account request anywhere in the app is the limits read', () => {
  // A reset credit can only be spent by an account/* request. Any new one
  // fails here and has to be looked at on purpose.
  const dir = path.join(__dirname, '..', '..', 'electron')
  const found = new Set()
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf-8')
    for (const m of src.matchAll(/['"`](account\/[A-Za-z/]+)['"`]/g)) found.add(m[1])
  }
  assert.deepEqual([...found], [RATE_LIMITS_READ])
  assert.equal(RATE_LIMITS_READ, 'account/rateLimits/read')
})
