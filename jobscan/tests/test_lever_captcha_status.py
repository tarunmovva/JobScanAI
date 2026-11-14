#!/usr/bin/env python3
"""A CAPTCHA puzzle is a distinct outcome, not a failed fill.

Nearly a quarter of recorded lever runs hit one. They landed as not_confirmed or
validation_failed — indistinguishable from a broken fill — and each then spent a
full AI recovery attempt (~2 minutes, ~64k tokens) on a challenge the recovery
prompt explicitly tells the agent it cannot solve. One of them says it plainly:

    "All form validation errors were cleared, but Lever displayed an hCaptcha
     security challenge and submission did not complete."

The form was complete. Only a person can clear the challenge.

    python tests/test_lever_captcha_status.py
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job_application_automator import lever_form_filler as lf  # noqa: E402
from job_application_automator.agent_recovery import (  # noqa: E402
    DIAGNOSE_STATUSES,
    RECOVERABLE_STATUSES,
)

PUZZLE = "blocked_captcha_puzzle"


class Page:
    """Stands in for a page whose evaluate() reports whether a challenge shows."""

    def __init__(self, visible: bool, raises: bool = False):
        self.visible, self.raises = visible, raises
        self.url = "https://jobs.lever.co/acme/x/apply"

    async def evaluate(self, *_a, **_k):
        if self.raises:
            raise RuntimeError("frame detached")
        return self.visible


class PuzzleDetectionTest(unittest.TestCase):
    def test_visible_challenge_is_detected(self):
        self.assertTrue(asyncio.run(lf._captcha_puzzle_visible(Page(True))))

    def test_absent_challenge_is_not(self):
        self.assertFalse(asyncio.run(lf._captcha_puzzle_visible(Page(False))))

    def test_an_unreadable_page_is_not_assumed_blocked(self):
        self.assertFalse(
            asyncio.run(lf._captcha_puzzle_visible(Page(False, raises=True))),
            "a detached frame must not be reported as a captcha block")


class BlockingFrameTest(unittest.TestCase):
    """An hCaptcha iframe big enough to sit over the form blocks submission even
    before it renders a visible challenge. One recorded run said exactly that —
    "blocks page interactions but exposes no usable checkbox or challenge" —
    fell through as not_confirmed and burned 107s of fix-mode recovery."""

    class FramePage:
        def __init__(self, result):
            self.result = result
            self.url = "https://jobs.lever.co/acme/x/apply"

        async def evaluate(self, *_a, **_k):
            return self.result

    def test_a_large_blocking_captcha_frame_counts(self):
        self.assertTrue(asyncio.run(lf._captcha_puzzle_visible(self.FramePage(True))))

    def test_a_clean_page_does_not(self):
        self.assertFalse(asyncio.run(lf._captcha_puzzle_visible(self.FramePage(False))))


class InPlaceConfirmationTest(unittest.TestCase):
    """Lever can confirm WITHOUT redirecting: it prints "Application submitted!"
    in place, keeps the form on the page, and returns no API response we
    captured. All three detectors missed that, so a finished application was
    reported not_confirmed and handed to recovery — whose verdict read:

        "Marked tab already displayed 'Application submitted!' No further
         action needed."

    bodyText was already being collected and never read. Beyond the wasted run,
    fix-mode recovery is told to "complete this application and submit it", so a
    detector that cannot see success is one step from submitting twice."""

    def test_real_confirmations_are_recognised(self):
        for text in ("Application submitted! We will be in touch.",
                     "Thanks for applying to Acme",
                     "Thank you for your application",
                     "We've received your application",
                     "We have received your application",
                     "Your application has been received."):
            self.assertTrue(lf._confirmation_text(text), text)

    def test_future_tense_is_not_a_confirmation(self):
        # The single most dangerous false positive: a form that has NOT been
        # submitted telling the user what will happen when they do.
        for text in ("Your application will be submitted to the hiring team",
                     "Submit your application below",
                     "Please review before you submit",
                     "Application form",
                     ""):
            self.assertFalse(lf._confirmation_text(text), text)

    def test_the_matched_phrase_is_returned_for_the_record(self):
        self.assertEqual(lf._confirmation_text("... Application submitted! ...").lower(),
                         "application submitted")


class RecoveryRoutingTest(unittest.TestCase):
    def test_puzzle_is_never_sent_to_fix_mode(self):
        for platform, statuses in RECOVERABLE_STATUSES.items():
            self.assertNotIn(PUZZLE, statuses,
                             f"{platform}: a puzzle cannot be fixed by the agent, and trying "
                             f"costs ~2 minutes and ~64k tokens to re-report what we know")

    def test_puzzle_spends_no_agent_run_at_all(self):
        # Diagnose mode looked worth having until it was measured: 8 recorded
        # runs spent 428s to report "Submission is blocked by an active
        # hCaptcha", which is what the status already says. Nothing left to find.
        self.assertNotIn(PUZZLE, DIAGNOSE_STATUSES.get("lever", frozenset()))
        for platform in set(RECOVERABLE_STATUSES) | set(DIAGNOSE_STATUSES):
            self.assertNotIn(PUZZLE, RECOVERABLE_STATUSES.get(platform, frozenset()))
            self.assertNotIn(PUZZLE, DIAGNOSE_STATUSES.get(platform, frozenset()))

    def test_the_one_click_checkbox_case_is_untouched(self):
        self.assertIn("blocked_captcha", RECOVERABLE_STATUSES["lever"],
                      "a plain 'I am not a robot' checkbox is one click and stays fixable")

    def test_no_status_is_both_fixable_and_diagnose_only(self):
        for platform in RECOVERABLE_STATUSES:
            overlap = RECOVERABLE_STATUSES[platform] & DIAGNOSE_STATUSES.get(platform, frozenset())
            self.assertEqual(overlap, frozenset(), f"{platform} routes {overlap} two ways")


if __name__ == "__main__":
    unittest.main(verbosity=2)
