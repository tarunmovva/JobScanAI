"""The agent must not be launched at a posting that no longer exists.

Measured over every recovery run on disk: on current code (after the
2026-09-07 oversized-event fix) there are 6 non-captcha failures, and 5 of them
are dead postings -- 404s, "no longer available", Ashby "Page not found". In
each the agent reached the right conclusion, after 20-150s and a full turn of
tokens, from a page that says so in plain text.

The check runs before the launch. It has to be conservative in one direction:
skipping a LIVE posting would abandon a recoverable application, which is far
worse than paying for one wasted agent run.
"""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator.agent_recovery import _posting_is_gone  # noqa: E402


class _Page:
    def __init__(self, text, raises=False):
        self._text = text
        self._raises = raises

    async def evaluate(self, *_a, **_k):
        if self._raises:
            raise RuntimeError("target closed")
        return self._text


def gone(text, raises=False):
    return asyncio.run(_posting_is_gone(_Page(text, raises)))


class PreflightTests(unittest.TestCase):
    def test_the_real_dead_pages_are_recognised(self):
        # Wording taken from the recorded failures.
        for body in [
            "Not found  404 error",
            "The job you are looking for is no longer available",
            "Page not found",
            "This posting is no longer accepting applications",
        ]:
            self.assertTrue(gone(body), body)

    def test_a_live_application_page_is_never_skipped(self):
        # The expensive mistake is the other way round: skipping a page that
        # could still have been submitted throws the application away.
        for body in [
            "Submit Application. Resume/CV. Cover Letter. First Name. Last Name.",
            "Apply for this job. We are hiring a Senior Engineer in New York.",
            "Application submitted! Thank you for applying.",
            "This role is available in our Austin office. Apply below.",
            "",
        ]:
            self.assertEqual(gone(body), "", body)

    def test_an_unreachable_page_hands_the_case_to_the_agent(self):
        # No page, no judgement -- fall through to the pre-existing behaviour
        # rather than inventing a verdict from a failed read.
        self.assertEqual(gone("anything", raises=True), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
