// How much of a job description the rater is allowed to see.
//
// This was 800 characters. Measured over 4,000 real postings in jobs.db:
//
//   median description        4,963 chars
//   87% carry a "Requirements / Qualifications / What you'll need" section
//   that section starts at    median char 2,033
//
// So an 800-char slice reached the requirements for 15% of jobs. For the other
// 85% the rater scored the company boilerplate -- mission statement, benefits,
// "fast-growing team" -- and never saw what the job actually asks for. Raising
// it to 4,000 reaches the requirements for 89%.
//
// These tests pin the number against that measurement, and pin the two things
// that must move with it: the prompt revision (or every cached rating replays
// and nothing re-runs) and the prompt's own description of what it is sent.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'electron', 'prompts.ts'), 'utf-8')

function constant(name) {
  const m = new RegExp(`export const ${name} = (\\d+)`).exec(SRC)
  return m ? Number(m[1]) : null
}

// Median offset of the requirements heading across 4,000 real postings.
const REQUIREMENTS_MEDIAN_OFFSET = 2033

test('the rater sees far enough in to reach the requirements', () => {
  const limit = constant('RATING_DESCRIPTION_CHARS')
  assert.ok(limit, 'RATING_DESCRIPTION_CHARS not found')
  assert.ok(limit > REQUIREMENTS_MEDIAN_OFFSET,
    `${limit} chars does not reach the median requirements heading at `
    + `${REQUIREMENTS_MEDIAN_OFFSET}; the rater would score boilerplate for `
    + 'most jobs')
})

test('the limit stays inside a single rating call budget', () => {
  // 20 jobs per batch plus the resume and system prompt. At 4,000 chars this is
  // ~23k tokens, under 18% of a 128k context. This guards the other direction:
  // someone raising the limit to "see everything" would quietly build a call
  // that no longer fits.
  const limit = constant('RATING_DESCRIPTION_CHARS')
  const perJobTokens = limit / 4 + 60          // description + metadata
  const call = 1000 + 2300 + 20 * perJobTokens // system + resume + batch
  assert.ok(call < 100_000,
    `a rating call would be ~${Math.round(call)} tokens, too close to a context limit`)
})

test('the prompt revision moved with the limit', () => {
  // The rev is part of ratingHash(). Without a bump, every already-rated pool
  // replays its cached scores and the larger description is never used.
  const rev = Number((/export const RATING_PROMPT_REV = '(\d+)'/.exec(SRC) || [])[1])
  assert.ok(rev >= 3, `RATING_PROMPT_REV is ${rev}; the 800 -> 4000 change needs >= 3`)
})

test('the prompt no longer claims it only gets the opening', () => {
  // It used to say "the opening of its description", which was accurate at 800
  // chars and would now understate what the model is looking at.
  assert.doesNotMatch(SRC, /the opening of its description/,
    'RATING_SYSTEM still describes the old 800-char slice')
})

test('the prompt warns that the description can be cut off', () => {
  // At 4,000 chars a long posting still truncates, sometimes mid-section. The
  // model must not read absence as a negative signal.
  const m = /export const RATING_SYSTEM = `([\s\S]*?)`/.exec(SRC)
  assert.ok(m, 'RATING_SYSTEM not found')
  assert.match(m[1], /truncat/i)
})
