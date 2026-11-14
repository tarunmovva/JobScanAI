#!/usr/bin/env python3
"""Loop runs leave no tab open.

In a loop run nobody is at the computer to finish an application, so a tab
kept open "for the user" is never finished. It also slows Chrome for every
later job: each new connection attaches to every open tab (measured 0.2 s with
none open, ~11 s with 50). The app marks a loop run with
JOB_AUTOMATOR_UNATTENDED=1.

Normal runs keep today's behaviour: a CAPTCHA or verification tab stays open
for the user.

    python -m pytest tests/test_unattended.py -q
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator import ashby_form_filler, lever_form_filler  # noqa: E402
from job_application_automator.close_policy import should_keep_tab_open  # noqa: E402


@contextlib.contextmanager
def env(**values):
    saved = {k: os.environ.get(k) for k in values}
    try:
        for k, v in values.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class UnattendedTabPolicyTests(unittest.TestCase):
    def test_every_tab_closes_when_unattended(self):
        with env(JOB_AUTOMATOR_UNATTENDED="1"):
            for status in ("blocked_captcha_puzzle", "validation_errors", "otp_timeout",
                           "navigated_away", "error"):
                self.assertFalse(should_keep_tab_open(status), status)

    def test_normal_runs_still_keep_a_captcha_tab_open(self):
        with env(JOB_AUTOMATOR_UNATTENDED=None):
            self.assertTrue(should_keep_tab_open("blocked_captcha_puzzle"))
            self.assertTrue(should_keep_tab_open("navigated_away"))

    def test_only_the_exact_flag_value_counts(self):
        with env(JOB_AUTOMATOR_UNATTENDED="0"):
            self.assertTrue(should_keep_tab_open("blocked_captcha_puzzle"))


class _CrashingPage:
    """A page that breaks right after the tab opened.

    Lever's first page call (`on`) is unguarded, so it crashes there. Ashby's
    response recorder swallows that error and navigates; its first unguarded
    call after navigating is `wait_for_timeout`, so it crashes there.
    """

    def on(self, *_a, **_k):
        raise RuntimeError("page crashed")

    async def goto(self, *_a, **_k):
        return None

    async def wait_for_timeout(self, *_a, **_k):
        raise RuntimeError("page crashed")


class _Session:
    def __init__(self):
        self.page = _CrashingPage()
        self.closed = False

    async def cleanup(self):
        self.closed = True


class _PW:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _crash_fill(module) -> tuple[_Session, dict]:
    session = _Session()

    async def fake_open(*_a, **_k):
        return session

    saved = (module.open_cdp_page, module.async_playwright)
    module.open_cdp_page, module.async_playwright = fake_open, (lambda: _PW())
    try:
        with tempfile.TemporaryDirectory() as d:
            payload = Path(d) / "fill_payload.json"
            payload.write_text(json.dumps({"apply_url": "https://example.com/apply", "answers": {}}),
                               encoding="utf-8")
            result = asyncio.run(module.fill(payload, Path(d)))
    finally:
        module.open_cdp_page, module.async_playwright = saved
    return session, result


class CrashedFillerTabTests(unittest.TestCase):
    """A filler that crashes after its tab opened returns an error result, and
    nothing closed the tab: it stayed open in the user's Chrome."""

    def test_lever_crash_closes_its_tab_when_unattended(self):
        with env(JOB_AUTOMATOR_UNATTENDED="1"):
            session, result = _crash_fill(lever_form_filler)
        self.assertTrue(session.closed)
        self.assertEqual(result["submission"]["status"], "error")

    def test_lever_crash_keeps_todays_behaviour_in_normal_runs(self):
        with env(JOB_AUTOMATOR_UNATTENDED=None):
            session, result = _crash_fill(lever_form_filler)
        self.assertFalse(session.closed)
        self.assertEqual(result["submission"]["status"], "error")

    def test_ashby_crash_closes_its_tab_when_unattended(self):
        with env(JOB_AUTOMATOR_UNATTENDED="1"):
            session, result = _crash_fill(ashby_form_filler)
        self.assertTrue(session.closed)
        self.assertEqual(result["submission"]["status"], "error")

    def test_ashby_crash_keeps_todays_behaviour_in_normal_runs(self):
        with env(JOB_AUTOMATOR_UNATTENDED=None):
            session, result = _crash_fill(ashby_form_filler)
        self.assertFalse(session.closed)
        self.assertEqual(result["submission"]["status"], "error")


if __name__ == "__main__":
    unittest.main(verbosity=2)
