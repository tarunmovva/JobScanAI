"""Telling a complete option list from a truncated one.

A live application failed on a 103-option "College Name" dropdown. The list
came from the Greenhouse questions API -- the question's own definition, so it
is complete -- but the extractor flagged it options_truncated because 103 is
more than the 80-option DOM cap. That flag tells the payload agent "this is a
typeahead, write the true value" and tells the payload validator to skip the
field, so an off-list college went straight through and the submit failed.

Truncation is a property of how a list was collected, not of its length: the
DOM collectors stop at the cap, and only their lists can have been cut short.

The marker that records an API-sourced list was first written and then
silently dropped, because _dedupe_fields rebuilds each field from an explicit
whitelist of keys. These tests pin both halves.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator.greenhouse_fast_form_extractor import _dedupe_fields  # noqa: E402


def _dropdown(fid: str, n: int, **extra) -> dict:
    return {"id": fid, "label": f"Field {fid}", "type": "dropdown", "selector": f"#{fid}",
            "options": [{"text": f"Option {i}", "value": str(i)} for i in range(n)], **extra}


class OptionSourceSurvivesCleaningTests(unittest.TestCase):
    def test_the_api_marker_survives_the_whitelist(self):
        # The bug: set during enrichment, then stripped here, so the truncation
        # check never saw it.
        out = _dedupe_fields([_dropdown("college", 103, options_source="greenhouse_api")])
        self.assertEqual(out[0].get("options_source"), "greenhouse_api")

    def test_a_dom_list_carries_no_marker(self):
        out = _dedupe_fields([_dropdown("school", 80)])
        self.assertNotIn("options_source", out[0])

    def test_the_marker_travels_with_the_list_it_describes_on_a_merge(self):
        # Two extractions of the same field are merged and the longer list
        # wins. The source must follow the list, or a capped DOM sample would
        # inherit the API's claim to be complete.
        dom = _dropdown("college", 80)
        api = _dropdown("college", 103, options_source="greenhouse_api")
        merged = _dedupe_fields([dom, api])
        self.assertEqual(len(merged), 1)
        self.assertEqual(len(merged[0]["options"]), 103)
        self.assertEqual(merged[0].get("options_source"), "greenhouse_api")

    def test_a_capped_sample_never_inherits_completeness(self):
        api = _dropdown("college", 40, options_source="greenhouse_api")
        dom = _dropdown("college", 80)
        merged = _dedupe_fields([api, dom])
        self.assertEqual(len(merged[0]["options"]), 80)
        self.assertNotIn("options_source", merged[0],
                         "an 80-option DOM sample must not be labelled complete")


if __name__ == "__main__":
    unittest.main(verbosity=2)
