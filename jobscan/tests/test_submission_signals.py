#!/usr/bin/env python3
"""Did this application actually submit?

Getting it wrong is expensive in both directions, and the false NEGATIVE is the
dangerous one: a submitted application reported not_confirmed is handed to
fix-mode recovery, whose instruction is "complete this application and submit
it". That is a duplicate real application.

Anchored on a real greenhouse application whose page --
captured in after_submit.png -- read "Thank you for applying. Your application
has been received." at a /confirmation URL, and was still classified `clicked`
and sent to a 22s / 125k-token recovery run.

    python tests/test_submission_signals.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job_application_automator.submission_signals import (  # noqa: E402
    accepted_by_network, apply_recovery, confirmation_text, confirmation_url,
    is_submit_endpoint, looks_like_application_post, posting_gone, settle_submission,
)
from job_application_automator.greenhouse_fast_form_filler import (  # noqa: E402
    GreenhouseFastFormFiller,
)

# A real Greenhouse confirmation page. It keeps a "Sign in to MyGreenhouse"
# panel, so form_count and submit_button_count are BOTH non-zero -- which is
# exactly what the old implementation short-circuited on.
GREENHOUSE_CONFIRMATION = {
    "url": "https://job-boards.greenhouse.io/northwind/jobs/4000000001/confirmation",
    "form_count": 1,
    "submit_button_count": 1,
    "validation_error_count": 0,
    "body_text_sample": (
        "Thank you for applying. Your application has been received. If there is a fit, "
        "someone will be getting back to you. Track your application Sign in to MyGreenhouse"
    ),
}


class ConfirmationTextTest(unittest.TestCase):
    def test_past_tense_confirmations_match(self):
        for text in [
            "Thank you for applying.",
            "Thanks for applying",
            "Your application has been received.",
            "Your application has been submitted.",
            "We've received your application",
            "Application submitted!",
        ]:
            self.assertTrue(confirmation_text(text), f"should match: {text!r}")

    def test_future_tense_and_prompts_do_not_match(self):
        # A form that has not been submitted says these. Matching them would
        # record an application that never happened.
        for text in [
            "Your application will be submitted once you press Submit",
            "Submit application",
            "Please complete the required fields before you submit",
            "Review your application before submitting",
        ]:
            self.assertFalse(confirmation_text(text), f"must NOT match: {text!r}")

    def test_greenhouses_own_wording_is_covered(self):
        # The old greenhouse list had "received your application" but greenhouse
        # writes "your application has been received" -- so it matched neither
        # that sentence nor, because of the gate order, anything else.
        self.assertTrue(confirmation_text("Your application has been received."))

    def test_confirmation_url_markers(self):
        self.assertEqual(confirmation_url(GREENHOUSE_CONFIRMATION["url"]), "/confirmation")
        self.assertEqual(confirmation_url("https://x/jobs/1/thanks"), "/thanks")
        self.assertEqual(confirmation_url("https://boards.greenhouse.io/x/jobs/1?gh_jid=1"), "")


class GreenhouseSubmittedStateTest(unittest.TestCase):
    def setUp(self):
        self.filler = object.__new__(GreenhouseFastFormFiller)
        self.filler._current_job_id = "4000000001"

    def looks_submitted(self, state):
        return GreenhouseFastFormFiller._looks_submitted_state(self.filler, state)

    def test_the_recorded_false_negative_is_now_detected(self):
        self.assertTrue(self.looks_submitted(GREENHOUSE_CONFIRMATION),
                        "a /confirmation URL saying 'Thank you for applying' is submitted, "
                        "even with a sign-in form still on the page")

    def test_a_form_still_on_screen_is_not_submitted(self):
        self.assertFalse(self.looks_submitted({
            "url": "https://boards.greenhouse.io/northwind/jobs/4000000001?gh_jid=4000000001",
            "form_count": 1, "submit_button_count": 1, "validation_error_count": 2,
            "body_text_sample": "Submit application. Please complete the required fields.",
        }))

    def test_a_board_redirect_is_not_submitted(self):
        # A closed posting redirects to the company job board, which also has no
        # submit button. That was being recorded as a successful application.
        self.assertFalse(self.looks_submitted({
            "url": "https://boards.greenhouse.io/northwind?error=true",
            "form_count": 0, "submit_button_count": 0, "body_text_sample": "View all jobs",
        }))

    def test_future_tense_on_an_unsubmitted_form_is_not_submitted(self):
        self.assertFalse(self.looks_submitted({
            "url": "https://boards.greenhouse.io/x/jobs/4000000001",
            "form_count": 1, "submit_button_count": 1,
            "body_text_sample": "Your application will be submitted when you click Submit.",
        }))

    def test_a_bare_confirmation_page_is_submitted(self):
        self.assertTrue(self.looks_submitted({
            "url": "https://job-boards.greenhouse.io/x/jobs/4000000001/confirmation",
            "form_count": 0, "submit_button_count": 0, "body_text_sample": "Thanks for applying",
        }))




class NetworkEvidenceTest(unittest.TestCase):
    """Reading the submit response is the strongest signal a board gives, but it
    is layered ON TOP of the URL and text checks, never in place of them. If the
    listener misses -- document navigation instead of XHR, a redirect, a slow
    response -- a network-only detector reports not_confirmed for an application
    that DID submit, and fix-mode recovery is told to complete and submit it.
    That is a duplicate real application."""

    def test_only_application_posts_are_recorded(self):
        self.assertTrue(looks_like_application_post(
            "https://boards-api.greenhouse.io/v1/boards/x/jobs/1/applications", "POST"))
        self.assertTrue(looks_like_application_post(
            "https://jobs.ashbyhq.com/api/non-user-graphql?op=SubmitApplication", "POST"))
        self.assertFalse(looks_like_application_post("https://x/applications", "GET"))
        self.assertFalse(looks_like_application_post("https://x/analytics/track", "POST"))

    def test_a_clean_2xx_counts_as_accepted(self):
        self.assertIsNotNone(accepted_by_network(
            [{"url": "https://boards-api.greenhouse.io/v1/boards/x/jobs/123/applications", "status": 200, "body": '{"success":true}'}]))
        self.assertIsNotNone(accepted_by_network(
            [{"url": "https://boards-api.greenhouse.io/v1/boards/x/jobs/123/applications", "status": 201, "body": ""}]))

    def test_a_clean_2xx_from_a_NON_submit_endpoint_does_not_count(self):
        # The regression: any 200 used to count, whatever produced it.
        self.assertIsNone(accepted_by_network(
            [{"url": "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting",
              "status": 200, "body": '{"data":{"jobPosting":null}}'}]))

    def test_graphql_200_carrying_errors_does_not_count(self):
        # Ashby answers HTTP 200 with an errors[] array when it rejects. A
        # status-only check would record an application that never happened,
        # and nothing would ever retry it.
        self.assertIsNone(accepted_by_network(
            [{"url": "https://boards-api.greenhouse.io/v1/boards/x/jobs/123/applications", "status": 200,
              "body": '{"errors":[{"message":"field required"}]}'}]))

    def test_failures_and_absence_do_not_count(self):
        self.assertIsNone(accepted_by_network([{"url": "https://boards-api.greenhouse.io/v1/boards/x/jobs/123/applications", "status": 422, "body": "{}"}]))
        self.assertIsNone(accepted_by_network([{"url": "https://boards-api.greenhouse.io/v1/boards/x/jobs/123/applications", "status": 500, "body": "oops"}]))
        self.assertIsNone(accepted_by_network([]))
        self.assertIsNone(accepted_by_network(None))

    def test_the_latest_response_wins(self):
        # A retry after a rejection: the last word is the one that counts.
        accepted = accepted_by_network([
            {"url": "https://boards-api.greenhouse.io/v1/boards/x/jobs/123/applications", "status": 422, "body": '{"errors":["required"]}'},
            {"url": "https://boards-api.greenhouse.io/v1/boards/x/jobs/123/applications", "status": 200, "body": '{"id":123}'},
        ])
        self.assertIsNotNone(accepted)
        self.assertEqual(accepted["status"], 200)


# Captured verbatim from the 2026-09-08 live run. Every ashby call is graphql,
# so matching "graphql" made a page-load query count as acceptance -- and on two
# DEAD postings the recorded evidence literally said the job did not exist.
ASHBY_DEAD_POSTING = [
    {"url": "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiOrganizationFromHostedJobsPageName",
     "status": 200, "body": '{"data":{"organization":null}}'},
    {"url": "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting",
     "status": 200, "body": '{"data":{"jobPosting":null}}'},
]

ASHBY_REAL_SUBMIT = [
    {"url": "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSetFormValue",
     "status": 200, "body": '{"data":{}}'},
    {"url": "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSubmitSingleApplicationFormAction",
     "status": 200, "body": '{"data":{"submitted":true}}'},
]


class SubmitEndpointTest(unittest.TestCase):
    def test_a_page_load_query_is_not_a_submission(self):
        for op in ["ApiJobPosting", "ApiOrganizationFromHostedJobsPageName",
                   "ApiAutocompleteGeoLocation", "ApiSetFormValue",
                   "ApiCreateFileUploadHandle", "ApiSetFormValueToFile"]:
            self.assertFalse(
                is_submit_endpoint(f"https://jobs.ashbyhq.com/api/non-user-graphql?op={op}"),
                f"{op} does not file an application")

    def test_the_real_submit_operations_are_recognised(self):
        self.assertTrue(is_submit_endpoint(
            "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSubmitSingleApplicationFormAction"))
        self.assertTrue(is_submit_endpoint(
            "https://boards-api.greenhouse.io/v1/boards/x/jobs/123/applications"))
        self.assertTrue(is_submit_endpoint("https://jobs.lever.co/x/abc-123/apply"))

    def test_a_dead_posting_is_never_accepted(self):
        # The exact recorded evidence from two postings that did not exist.
        self.assertIsNone(accepted_by_network(ASHBY_DEAD_POSTING))

    def test_a_real_submission_is_accepted(self):
        self.assertIsNotNone(accepted_by_network(ASHBY_REAL_SUBMIT))

    def test_recording_stays_broad_for_diagnosis(self):
        # Recording everything is how the real endpoint names became knowable.
        # It decides nothing.
        self.assertTrue(looks_like_application_post(
            "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", "POST"))


class PostingGoneTest(unittest.TestCase):
    def test_dead_posting_wording(self):
        for text in ["Job not found.", "Page not found",
                     "This position has been closed",
                     "This job is no longer accepting applications"]:
            self.assertTrue(posting_gone(text), f"should match: {text!r}")

    def test_a_live_form_or_a_confirmation_is_not_a_dead_posting(self):
        for text in ["Thank you for applying.", "Submit application",
                     "Your application has been received.", ""]:
            self.assertFalse(posting_gone(text), f"must NOT match: {text!r}")


class SettleSubmissionTest(unittest.IsolatedAsyncioTestCase):
    """A board can confirm in place a beat after the click. Detection ran once,
    so a late confirmation was read as not_confirmed and sent to a fix-mode
    agent told to complete and submit -- 25s on a lever posting in the live run,
    whose whole verdict was "Marked tab already displayed 'Application
    submitted!'"."""

    async def test_a_late_confirmation_is_caught(self):
        calls = []

        async def detect():
            calls.append(1)
            return {"status": "submitted"} if len(calls) >= 3 else {"status": "not_confirmed"}

        result = await settle_submission(detect, attempts=4, delay_s=0)
        self.assertEqual(result["status"], "submitted")
        self.assertEqual(len(calls), 3)

    async def test_a_settled_answer_returns_immediately(self):
        calls = []

        async def detect():
            calls.append(1)
            return {"status": "submitted"}

        await settle_submission(detect, attempts=4, delay_s=0)
        self.assertEqual(len(calls), 1, "no reason to re-check a decided outcome")

    async def test_terminal_failures_are_not_retried(self):
        # Re-checking these burns wall-clock on every failing application and
        # cannot change the answer.
        for status in ["validation_failed", "blocked_captcha_puzzle",
                       "posting_closed", "duplicate_application"]:
            calls = []

            async def detect(status=status):
                calls.append(1)
                return {"status": status}

            await settle_submission(detect, attempts=4, delay_s=0)
            self.assertEqual(len(calls), 1, f"{status} is an answer, not a pending state")

    async def test_it_gives_up_after_the_attempt_budget(self):
        calls = []

        async def detect():
            calls.append(1)
            return {"status": "not_confirmed"}

        result = await settle_submission(detect, attempts=3, delay_s=0)
        self.assertEqual(result["status"], "not_confirmed")
        self.assertEqual(len(calls), 3)


class ApplyRecoveryTests(unittest.TestCase):
    """Recovery overwrites the classifier's verdict; the verdict is the evidence."""

    def test_it_keeps_what_the_classifier_saw(self):
        result = {"submission": {"status": "not_confirmed", "reason": "no marker"}}
        recovered = {"status": "submitted", "reason": "agent confirmed"}

        returned = apply_recovery(result, recovered)

        self.assertIs(returned, recovered)
        self.assertEqual(result["submission"], recovered)
        self.assertEqual(result["submission_pre_recovery"]["status"], "not_confirmed")
        self.assertEqual(result["submission_pre_recovery"]["reason"], "no marker")

    def test_it_does_not_invent_a_pre_recovery_block(self):
        # Ashby's verification_failed path can reach recovery before any
        # classifier ran. An empty dict there would read as a real verdict.
        for prior in [None, "not a dict", 7]:
            result = {} if prior is None else {"submission": prior}
            apply_recovery(result, {"status": "submitted"})
            self.assertNotIn("submission_pre_recovery", result, f"prior={prior!r}")
            self.assertEqual(result["submission"], {"status": "submitted"})

    def test_every_filler_routes_recovery_through_it(self):
        # A filler that assigns result["submission"] = recovered directly is
        # the exact bug this helper exists to prevent -- guard it structurally.
        import pathlib
        pkg = pathlib.Path(__file__).resolve().parents[1] / "job_application_automator"
        for name in ["ashby_form_filler.py", "lever_form_filler.py",
                     "greenhouse_fast_form_filler.py"]:
            src = (pkg / name).read_text(encoding="utf-8")
            self.assertNotIn('result["submission"] = recovered', src, name)
            self.assertIn("apply_recovery(result, recovered)", src, name)


class LeverDeadPostingTests(unittest.TestCase):
    """A dead Lever posting must never be recorded as a submitted application.

    Live run: a jobs.lever.co posting returned HTTP 404. The
    filler found no form, the recovery agent reported outcome "failed" with
    "Application returns HTTP 404 ... no form or submit button is available",
    and the run was still recorded submission.status="submitted".

    Cause: _detect_submission_state treats "no form and no controls" as
    "the form disappeared after submit" -- which is exactly what a 404 looks
    like. Same bug class as the Ashby dead postings, in the platform that had
    never been given the posting_gone check.
    """

    def test_lever_threads_form_presence_into_its_detector(self):
        import inspect
        from job_application_automator import lever_form_filler as m
        src = inspect.getsource(m._detect_submission_state)
        self.assertIn("form_was_present", src)
        self.assertIn("posting_gone", src)
        # The success inference must be gated on the form having existed first.
        gate = src.index("form_was_present")
        disappeared = src.index("disappeared after submit")
        self.assertLess(gate, disappeared,
                        "the disappearance inference must be guarded, not guarding")

    def test_every_filler_that_can_meet_a_dead_posting_checks_for_one(self):
        import pathlib
        pkg = pathlib.Path(__file__).resolve().parents[1] / "job_application_automator"
        for name in ["ashby_form_filler.py", "lever_form_filler.py"]:
            src = (pkg / name).read_text(encoding="utf-8")
            self.assertIn("posting_gone", src, f"{name} cannot recognise a dead posting")

    def test_the_404_wording_is_recognised(self):
        for body in ["Job not found", "This posting is no longer accepting applications",
                     "The job you are looking for is no longer available"]:
            self.assertTrue(posting_gone(body), body)


# Verbatim from the page that dead Lever posting actually served,
# extracted from the captured form.html of the run that recorded it submitted.
LEVER_404_BODY = "Not found  404 error Lever"


class LeverDetectorOnRealDeadPosting(unittest.IsolatedAsyncioTestCase):
    """Runs the real detector against the real 404 that fooled it."""

    class _Page:
        def __init__(self, body, has_form=False, controls=0):
            self.url = "https://jobs.lever.co/proseware/0a1b2c3d/apply"
            self._state = {"hasForm": has_form, "controlCount": controls,
                           "invalidCount": 0, "invalid": [], "bodyText": body}

        async def evaluate(self, *a, **k):
            return self._state

    async def _detect(self, page, form_was_present):
        from job_application_automator import lever_form_filler as m
        real = m._captcha_puzzle_visible

        async def no_captcha(_page):
            return False

        m._captcha_puzzle_visible = no_captcha
        try:
            return await m._detect_submission_state(page, True, {}, form_was_present)
        finally:
            m._captcha_puzzle_visible = real

    async def test_the_real_404_is_posting_closed_not_submitted(self):
        got = await self._detect(self._Page(LEVER_404_BODY), form_was_present=False)
        self.assertEqual(got["status"], "posting_closed", got)

    async def test_a_missing_form_that_was_never_there_is_not_a_submission(self):
        # Same shape, no 404 wording at all: absence still proves nothing when
        # the form was already gone before the submit.
        got = await self._detect(self._Page("Some unrelated page"), form_was_present=False)
        self.assertEqual(got["status"], "form_not_found", got)

    async def test_a_form_that_really_did_disappear_still_counts_as_submitted(self):
        # The legitimate case must not regress: form present before, gone after.
        got = await self._detect(self._Page("Thanks for applying."), form_was_present=True)
        self.assertEqual(got["status"], "submitted", got)


class RecoveryNeedsPositiveEvidenceTests(unittest.TestCase):
    """A recovery-declared submit must show something, not merely lack a button.

    A live run, greenhouse-4000000002: the posting's apply_url pointed
    at https://investors.example.com/ -- the company's investor
    relations page. The filler filled 0 of 24 fields, all 24 verification checks
    read <not found>, and the recovery agent reported "completed the form, and
    submitted. Verified the 'Thank you for applying' confirmation." That string
    appears nowhere in the captured recovery_page.html, which is the investor
    relations page. It was recorded submitted.

    _recovery_detect passes {} as before_state, so the classifier's form_count
    comparison is dead and "submit_button_count == 0" alone decides -- true of
    any page the agent wanders onto.
    """

    def test_the_detector_requires_more_than_a_missing_submit_button(self):
        import inspect
        from job_application_automator import greenhouse_fast_form_filler as m
        src = inspect.getsource(m.GreenhouseFastFormFiller.fill)
        start = src.index("_recovery_detect")
        window = src[start:start + 2000]
        self.assertIn("_looks_submitted_state", window)
        self.assertIn("accepted_by_network", window)
        self.assertIn("return False", window)

    def test_the_investor_relations_page_carries_no_confirmation(self):
        # The exact failure: nothing on that page says an application landed.
        page_text = ("Woodgrove - Investor Relations Corporate Profile "
                     "Latest Quarterly Reports Investor Email Alerts "
                     "Email Address is required.")
        self.assertEqual(confirmation_text(page_text), "")
        self.assertEqual(confirmation_url("https://investors.example.com/"), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
