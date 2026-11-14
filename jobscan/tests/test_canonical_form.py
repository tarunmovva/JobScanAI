#!/usr/bin/env python3
"""Telling a Greenhouse form from a careers site's own forms.

One company's job pages draw two vendor forms -- a talent-network
signup and a custom application -- and the page scoring accepted them as the
Greenhouse application: both have a first name and a file input. The filler
filled the signup form; six runs were recorded as submitted with nothing
confirming it. The board's own embed serves the real form.

The rule is decided from the questions API: a Greenhouse rendering carries the
posting's field names in its control ids, a vendor form carries none of them.
Ids below keep the shapes of the captured pages.

    python tests/test_canonical_form.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator.greenhouse_fast_form_extractor import (  # noqa: E402
    _parse_greenhouse_url,
    greenhouse_field_names,
    renders_greenhouse_form,
    with_board,
)

VENDOR_SITE_API = {"questions": [
    {"fields": [{"name": "first_name"}]}, {"fields": [{"name": "email"}]},
    {"fields": [{"name": "resume"}, {"name": "resume_text"}]},
    {"fields": [{"name": "question_11111101"}]}, {"fields": [{"name": "question_22222202[]"}]},
]}
VENDOR_SITE_PAGE = [  # that company's job page: both vendor forms
    "form_submission[fields_attributes][0][string_value]", "form_first_name_2_1_0",
    "form_last_name_2_1_1", "form_email_2_1_2", "form_departments_2_1-selectized",
    "question_2_0_4_0_1", "form_consent_2_0_5",
]


class RendersGreenhouseFormTests(unittest.TestCase):
    def test_a_vendor_form_is_not_the_greenhouse_form(self):
        self.assertFalse(renders_greenhouse_form(VENDOR_SITE_PAGE, greenhouse_field_names(VENDOR_SITE_API)))

    def test_greenhouse_markup_on_a_company_domain_is(self):
        # A company domain that renders Greenhouse's own field ids.
        api = {"questions": [{"fields": [{"name": "question_33333303"}]}]}
        self.assertTrue(renders_greenhouse_form(["first_name", "question_33333303"], greenhouse_field_names(api)))

    def test_prefixed_question_ids_still_count(self):
        # Seen on company domains: input_question_<id>, and question_<id> next to field-first_name.
        api = {"questions": [{"fields": [{"name": "question_44444444004"}]}]}
        names = greenhouse_field_names(api)
        self.assertTrue(renders_greenhouse_form(["input_question_44444444004"], names))
        self.assertTrue(renders_greenhouse_form(["question_44444444004"], names))

    def test_a_question_id_must_match_exactly_not_by_prefix(self):
        api = {"questions": [{"fields": [{"name": "question_1111110"}]}]}
        self.assertFalse(renders_greenhouse_form(["question_11111101"], greenhouse_field_names(api)))

    def test_without_custom_questions_a_greenhouse_named_first_name_counts(self):
        api = {"questions": [{"fields": [{"name": "first_name"}]}]}
        names = greenhouse_field_names(api)
        for ident in ("first_name", "input_first_name", "field-first_name", "job_application[first_name]"):
            self.assertTrue(renders_greenhouse_form([ident], names), ident)
        # ...but a vendor's numbered field is not one.
        self.assertFalse(renders_greenhouse_form(["form_first_name_2_1_0", "firstName"], names))

    def test_array_suffix_is_dropped_from_api_names(self):
        self.assertIn("question_22222202", greenhouse_field_names(VENDOR_SITE_API))


class BoardTests(unittest.TestCase):
    def test_a_company_domain_url_gets_the_board_from_the_job_record(self):
        meta = with_board(_parse_greenhouse_url("https://www.acme.example.com/jobs/1234567?gh_jid=1234567"), "acme")
        self.assertEqual((meta["board"], meta["job_id"]), ("acme", "1234567"))

    def test_a_board_in_the_url_is_never_overridden(self):
        meta = with_board(_parse_greenhouse_url("https://job-boards.greenhouse.io/contoso/jobs/4000000010"), "other")
        self.assertEqual(meta["board"], "contoso")


if __name__ == "__main__":
    unittest.main(verbosity=2)
