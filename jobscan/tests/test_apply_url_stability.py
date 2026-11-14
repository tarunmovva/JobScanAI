"""The extractor must record a URL an application can actually be made on.

A live run, greenhouse-4000000002. The DB held
the correct URL:

    https://www.example.com/careers/jobs/4000000002?gh_jid=4000000002

That page redirected, and the extractor stored `page.url` -- the POST-redirect
location, https://investors.example.com/, the company's investor
relations page -- as apply_url. It still captured 24 fields, so nothing looked
wrong. The filler then navigated to the investor relations page, filled 0 of 24
fields, all 24 verification checks read <not found>, and the run ended recorded
as a submitted application.

Redirects are normal and mostly legitimate (boards.greenhouse.io ->
job-boards.greenhouse.io; company career pages embedding ?gh_jid=). The
distinction is whether the destination still identifies THIS job.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator.greenhouse_fast_form_extractor import (  # noqa: E402
    _stable_apply_url,
)


class StableApplyUrlTests(unittest.TestCase):
    def test_the_investor_relations_drift_keeps_the_original(self):
        original = "https://www.example.com/careers/jobs/4000000002?gh_jid=4000000002"
        drifted = "https://investors.example.com/"
        self.assertEqual(_stable_apply_url(original, drifted, "4000000002"), original)

    def test_a_greenhouse_redirect_is_followed(self):
        # boards.greenhouse.io 301s to job-boards.greenhouse.io. Still the job.
        self.assertEqual(
            _stable_apply_url("https://boards.greenhouse.io/x/jobs/123",
                              "https://job-boards.greenhouse.io/x/jobs/123", "123"),
            "https://job-boards.greenhouse.io/x/jobs/123")

    def test_an_embedded_board_is_kept(self):
        # 34,457 greenhouse postings live on company career pages via gh_jid.
        url = "https://careers.example.com/jobs?gh_jid=4000000004"
        self.assertEqual(_stable_apply_url(url, url, "4000000004"), url)

    def test_a_same_site_move_that_still_names_the_job_is_kept(self):
        self.assertEqual(
            _stable_apply_url("https://co.com/careers/999", "https://co.com/apply/999", "999"),
            "https://co.com/apply/999")

    def test_an_empty_current_url_falls_back(self):
        self.assertEqual(_stable_apply_url("https://co.com/careers/999", "", "999"),
                         "https://co.com/careers/999")

    def test_a_drift_with_no_job_id_to_check_still_prefers_the_original(self):
        # Without a job id there is nothing to confirm the destination with, so
        # the URL that was verified good upstream wins.
        self.assertEqual(
            _stable_apply_url("https://co.com/careers/999", "https://co.com/thanks", ""),
            "https://co.com/careers/999")


if __name__ == "__main__":
    unittest.main(verbosity=2)
