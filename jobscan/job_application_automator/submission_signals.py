#!/usr/bin/env python3
"""Shared "did this application actually submit?" signals.

Each filler grew its own confirmation test, and they disagreed. Lever matched
seven phrasings via a regex; Greenhouse matched four fixed substrings and missed
"your application has been received" -- which is what Greenhouse itself prints.

Getting this wrong is expensive in BOTH directions:

  false negative  a submitted application is reported not_confirmed and handed
                  to fix-mode recovery, whose instruction is "complete this
                  application and submit it". That is a duplicate real
                  application. Measured on one greenhouse application:
                  the page said "Thank you for applying." at a /confirmation URL
                  and still burned a 22s, 125k-token recovery run.

  false positive  an application that never submitted is recorded as submitted
                  and silently never retried.

So the rule is: a confirmation must be PAST TENSE. "Your application will be
submitted" must not match, and no bare "submit".
"""

from __future__ import annotations

import re

CONFIRMATION_RE = re.compile(
    r"application submitted"
    r"|application (?:has been|was|is) (?:submitted|received)"
    r"|(?:your )?application (?:has been )?receiv(?:ed|es)"
    r"|thank(?:s| you) for (?:applying|your application|your interest in applying)"
    r"|(?:we[' ]?ve|we have) received your application"
    r"|received your application"
    r"|successfully (?:submitted|applied)",
    re.IGNORECASE,
)

# Path fragments a board only routes to AFTER a successful submission.
CONFIRMATION_URL_MARKERS = ("/confirmation", "/thanks", "/thank-you", "/application-submitted")

# Looser markers, used only for whole-URL keyword checks where the path may vary.
SUCCESS_URL_KEYWORDS = ("thank", "success", "confirmation", "submitted", "complete")


def confirmation_text(body_text: object) -> str:
    """The matched confirmation phrase, or "" when the text shows none."""
    match = CONFIRMATION_RE.search(str(body_text or ""))
    return match.group(0) if match else ""


def confirmation_url(url: object) -> str:
    """The matched path marker, or "" when the URL is not a confirmation route."""
    lowered = str(url or "").lower()
    for marker in CONFIRMATION_URL_MARKERS:
        if marker in lowered:
            return marker
    return ""


# ── network evidence ────────────────────────────────────────────────────────
#
# Reading the submit RESPONSE is stronger than reading the page: the board tells
# you directly whether it accepted the application. Lever already did this and
# it is the most reliable signal it has.
#
# It is added here as an EXTRA positive signal, never as a replacement for the
# URL and text checks. If the listener misses -- a document navigation instead
# of an XHR, a redirect, a slow response -- a network-only detector reports
# not_confirmed for an application that DID submit, and fix-mode recovery is
# told to "complete this application and submit it". That is a duplicate real
# application, which is worse than the wasted recovery run this is fixing.

# Requests worth RECORDING for diagnosis. Deliberately broad -- seeing what a
# board actually calls is the point -- and never used to decide anything.
RECORDABLE_ENDPOINT_HINTS = (
    "/applications", "/application", "/apply", "/submit", "graphql",
    # Greenhouse renders a React Router form whose action is the JOB ROUTE
    # itself -- <form action="/tailspin/jobs/4000000005"> -- so it posts to
    # /<company>/jobs/<id> and matched none of the hints above. The first live
    # run recorded 0 greenhouse responses for exactly that reason.
    #
    # With this hint the second run captured it:
    #     200 POST https://boards.greenhouse.io/wingtip/jobs/4000000006
    # with an EMPTY body, on each of the three that submitted, and no such POST
    # on the one that came back validation_errors.
    #
    # Tempting, but deliberately NOT added to SUBMIT_ENDPOINT_PATTERNS. An empty
    # 200 body carries no rejection markers, so accepted_by_network would accept
    # any POST to a job route -- including an autosave or a re-render. n=3 is
    # not enough to bet a false "submitted" on, and greenhouse's URL and
    # confirmation-text detection already handle it.
    "/jobs/",
)

# Requests that actually FILE an application. This is the only set allowed to
# influence a status, and it is deliberately narrow.
#
# The first version of this matched "graphql" for ashby. Every ashby call is
# graphql -- ApiOrganizationFromHostedJobsPageName, ApiJobPosting,
# ApiAutocompleteGeoLocation, ApiSetFormValue -- so a page-load query answering
# HTTP 200 counted as acceptance. On two DEAD postings the recorded evidence was
# literally {"data":{"jobPosting":null}}, i.e. "job not found", and both were
# recorded as submitted. Applications that never happened, never retried.
SUBMIT_ENDPOINT_PATTERNS = (
    # ashby: op=ApiSubmitSingleApplicationFormAction
    re.compile(r"op=[a-z]*submit[a-z]*application", re.I),
    # greenhouse: POST .../jobs/<id>/applications
    re.compile(r"/jobs/\d+/applications?", re.I),
    # lever, and anything else that names it plainly
    re.compile(r"/(?:apply|application|applications)(?:/[a-z]*)?(?:\?|$)", re.I),
    re.compile(r"/submit-?application", re.I),
)

# Present in a body, the board rejected it -- whatever the HTTP status. GraphQL
# in particular answers 200 with an errors[] array.
REJECTION_BODY_MARKERS = (
    '"errors"', "error", "invalid", "required", "captcha", "unauthorized",
    "forbidden", "too many", "rate limit", "duplicate",
)


def looks_like_application_post(url: object, method: object) -> bool:
    """Worth RECORDING. Broad on purpose; decides nothing."""
    if str(method or "").upper() != "POST":
        return False
    lowered = str(url or "").lower()
    return any(hint in lowered for hint in RECORDABLE_ENDPOINT_HINTS)


def is_submit_endpoint(url: object) -> bool:
    """Actually files an application. The only thing allowed to set a status."""
    text = str(url or "")
    return any(pattern.search(text) for pattern in SUBMIT_ENDPOINT_PATTERNS)


def accepted_by_network(responses: list[dict] | None) -> dict | None:
    """The response that shows the board accepted it, or None.

    Deliberately strict. A 2xx whose body carries any rejection marker does not
    count, because a false positive here records an application that never
    happened and it will never be retried.
    """
    for entry in reversed(responses or []):
        if not isinstance(entry, dict):
            continue
        if not is_submit_endpoint(entry.get("url")):
            continue
        status = entry.get("status")
        if not isinstance(status, int) or not (200 <= status < 300):
            continue
        body = str(entry.get("body") or "").lower()
        if any(marker in body for marker in REJECTION_BODY_MARKERS):
            continue
        return entry
    return None


def attach_response_recorder(page, responses: list[dict], *, limit: int = 40) -> None:
    """Record application-looking POST responses onto ``responses``.

    Everything captured is also written into fill_result.json, so the next run
    shows which endpoints each board really uses instead of it having to be
    guessed from the outside.
    """
    async def _on_response(resp):
        try:
            if not looks_like_application_post(resp.url, resp.request.method):
                return
            if len(responses) >= limit:
                return
            body = ""
            try:
                body = (await resp.body())[:600].decode("utf-8", errors="replace")
            except Exception:
                pass
            responses.append({
                "url": str(resp.url)[:200],
                "status": resp.status,
                "body": body,
            })
        except Exception:
            pass

    try:
        page.on("response", _on_response)
    except Exception:
        pass

# A posting that no longer exists is NOT a failed application -- there was never
# an application to make. Greenhouse already detected its board redirect;
# ashby had nothing, so a dead posting fell through as submit_button_not_found,
# went to AI recovery, and (with the graphql bug above) was recorded submitted.
POSTING_GONE_RE = re.compile(
    r"job not found"
    r"|page not found"
    r"|posting (?:is )?(?:no longer|not) (?:available|active)"
    # "The job you are looking for is no longer available" -- Lever's own
    # 404 wording, which the posting-only pattern missed. Scoped to a job
    # noun within one sentence so an unrelated "no longer available" on a
    # live form cannot match.
    r"|(?:job|role|position|opening)\b[^.]{0,40}\bno longer (?:available|open|active)"
    r"|no longer accepting applications"
    r"|this (?:job|position|posting) (?:has been|is) (?:closed|filled|removed)"
    r"|404",
    re.IGNORECASE,
)


def posting_gone(body_text: object) -> str:
    """The matched "this posting is gone" phrase, or ""."""
    match = POSTING_GONE_RE.search(str(body_text or ""))
    return match.group(0) if match else ""


# ── settling ────────────────────────────────────────────────────────────────
#
# A board can confirm IN PLACE a moment after the submit click: lever prints
# "Application submitted!" without navigating, ashby swaps in a status panel.
# Detection runs once, immediately, so a confirmation that arrives a second late
# is read as not_confirmed -- and that goes to a fix-mode recovery agent which
# is told to complete and submit. Observed in a live run on a
# lever posting: 25s of agent time whose entire verdict was "Marked tab already
# displayed 'Application submitted!' No repairs needed."
#
# Only genuinely undecided outcomes are retried. validation_failed,
# blocked_captcha, posting_closed and duplicate_application are answers, and
# re-checking them just burns wall-clock on every failing application.
UNSETTLED_STATUSES = frozenset({"not_confirmed", "clicked"})


async def settle_submission(detect, *, attempts: int = 4, delay_s: float = 1.5):
    """Re-run ``detect`` while the outcome is still undecided.

    Costs up to attempts*delay_s ONLY when the page has not made up its mind,
    and saves a recovery run each time the answer was simply late.
    """
    import asyncio

    result = await detect()
    for _ in range(max(0, attempts - 1)):
        if str((result or {}).get("status") or "") not in UNSETTLED_STATUSES:
            return result
        await asyncio.sleep(delay_s)
        result = await detect()
    return result


def apply_recovery(result: dict, recovered: dict) -> dict:
    """Install the recovered submission, keeping what the classifier saw.

    Recovery REPLACES ``result["submission"]``, and the block it overwrites is
    the only record of why recovery ran at all. When a classifier bug produced
    the failure, the overwrite erases the evidence of that bug -- exactly what
    made the dead-posting misclassification take a live run to find. Every
    filler must funnel its recovery hand-back through here.
    """
    if isinstance(result.get("submission"), dict):
        result["submission_pre_recovery"] = result["submission"]
    result["submission"] = recovered
    return recovered
