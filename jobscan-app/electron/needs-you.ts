/**
 * Which failed applications are actually waiting on the user.
 *
 * Some "failures" are not broken applications at all: the form is filled and
 * correct, and one step remains that the app must not do on the user's behalf —
 * clearing a CAPTCHA challenge, or completing an email verification whose code
 * never arrived. Nearly a quarter of recorded Lever runs ended this way, every one of them
 * rendered identically to a genuine failure, so the finished work was abandoned
 * a single click from being submitted.
 *
 * The tab is already left open for exactly this case (see close_policy.py); this
 * is what turns that into something the user can see and act on.
 */

const NEEDS_YOU: Record<string, string> = {
  blocked_captcha_puzzle: 'CAPTCHA challenge — clear it in the open tab and submit',
  blocked_captcha:        'CAPTCHA — clear it in the open tab and submit',
  captcha_puzzle:         'CAPTCHA challenge — clear it in the open tab and submit',
  otp_required:           'Email verification needed — enter the code in the open tab',
  otp_timeout:            'Verification code never arrived — finish in the open tab',
  otp_unavailable:        'Verification mailbox unavailable — finish in the open tab',
  otp_failed:             'Email verification failed — finish in the open tab',
  otp_rejected:           'Verification code was rejected — finish in the open tab',
}

const CAPTCHA_STATUSES = new Set(['blocked_captcha_puzzle', 'blocked_captcha', 'captcha_puzzle'])

/**
 * Did a CAPTCHA stop this application?
 *
 * "captcha" alone is too eager: a form can mention a captcha it then passed.
 * Require a CAPTCHA status, or wording that says it actually stopped us. Loop
 * mode counts these per platform to decide when to pause one.
 */
export function isCaptchaOutcome(status: string, detail = ''): boolean {
  if (CAPTCHA_STATUSES.has(String(status || '').trim())) return true
  return /captcha[_ ]?puzzle|captcha challenge|blocked_captcha/i.test(`${status} ${detail}`)
}

/**
 * The instruction to show the user, or undefined when this is a real failure.
 *
 * `detail` is matched as well as `status` because a filler can carry the verdict
 * in its reason rather than its status — Lever reports `not_confirmed` with
 * "AI: captcha_puzzle" appended, which is the single most common shape of this.
 */
export function needsYouReason(status: string, detail = ''): string | undefined {
  const direct = NEEDS_YOU[String(status || '').trim()]
  if (direct) return direct

  if (isCaptchaOutcome(status, detail)) return NEEDS_YOU['captcha_puzzle']
  const blob = `${status} ${detail}`
  if (/\botp_[a-z]+/i.test(blob)) return NEEDS_YOU['otp_required']
  return undefined
}
