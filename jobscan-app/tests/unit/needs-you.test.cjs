// A blocked application is not a broken one. Nearly a quarter of recorded Lever runs ended
// with the form filled and correct and a CAPTCHA challenge on screen — every one
// rendered identically to a genuine failure, so finished work was abandoned a
// single click from being submitted.
//
// Run: npm run test:unit
const test = require('node:test')
const assert = require('node:assert/strict')

const { needsYouReason } = require('../../out/unit/electron/needs-you.js')

test('a captcha puzzle status is waiting on the user', () => {
  assert.match(needsYouReason('blocked_captcha_puzzle') ?? '', /CAPTCHA/)
  assert.match(needsYouReason('blocked_captcha') ?? '', /CAPTCHA/)
})

test('the verdict is recognised when it rides in the reason, not the status', () => {
  // The exact shape of the most common real case: lever reports not_confirmed
  // and the AI verdict is appended to the reason.
  const reason = 'no success URL or successful Lever API response captured — AI: captcha_puzzle'
  assert.match(needsYouReason('not_confirmed', reason) ?? '', /CAPTCHA/)
})

test('the real-world hCaptcha wording is recognised', () => {
  const reason = 'All form validation errors were cleared, but Lever displayed an '
    + 'hCaptcha security challenge and submission did not complete. captcha_puzzle'
  assert.match(needsYouReason('validation_failed', reason) ?? '', /CAPTCHA/)
})

test('every otp state asks the user to finish in the tab', () => {
  for (const status of ['otp_required', 'otp_timeout', 'otp_unavailable', 'otp_failed', 'otp_rejected']) {
    assert.match(needsYouReason(status) ?? '', /verification/i, status)
  }
})

test('a genuine failure is left alone', () => {
  assert.equal(needsYouReason('validation_failed', '2 invalid controls remain'), undefined)
  assert.equal(needsYouReason('not_confirmed', 'no success URL captured'), undefined)
  assert.equal(needsYouReason('posting_closed'), undefined)
  assert.equal(needsYouReason('nav_failed'), undefined)
  assert.equal(needsYouReason(''), undefined)
})

test('a passing mention of captcha does not hijack a real failure', () => {
  // The page can mention a captcha it then cleared. Only wording that says it
  // actually stopped us counts — otherwise a broken fill gets filed as
  // "waiting on you" and never gets looked at again.
  assert.equal(
    needsYouReason('validation_failed', 'captcha verified ok; 2 invalid controls remain'),
    undefined)
})

test('the instruction names the action, not just the problem', () => {
  const reason = needsYouReason('blocked_captcha_puzzle') ?? ''
  assert.match(reason, /open tab/, 'the user has to be told where to go')
})
