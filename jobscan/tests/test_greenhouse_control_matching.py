#!/usr/bin/env python3
"""Regressions for the greenhouse race/ethnicity failure.

On one posting two different dropdowns both reported
actual='WhiteTwo or More Races'. Three separate defects:

  1. `race` is not on the page at all — greenhouse hides it once Hispanic/Latino
     is answered — but _matched_control resolved it onto a DIFFERENT question's
     control, because "race" is a substring of "how do you identify race
     ethnicity". A field that had vanished reported another field's value.
  2. That control is a react-select MULTI, whose selected values render as one
     chip each; reading the container's textContent glued them together.
  3. Every click on a multi ADDS a chip rather than replacing, so retries stacked
     selections — a field answered "Decline To Self Identify" committed "White" AND
     "Two or More Races", demographic answers the candidate never gave.

    python tests/test_greenhouse_control_matching.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job_application_automator.greenhouse_fast_form_filler import (  # noqa: E402
    GreenhouseFastFormFiller,
    _normalize_key,
)


def controls(*labels: str) -> dict:
    scanned = [
        {"id": "", "name": "", "label": label, "label_key": _normalize_key(label), "selector": ""}
        for label in labels
    ]
    return {"controls": scanned, "by_id": {}, "by_name": {}, "by_label": {}}


class MatchedControlTest(unittest.TestCase):
    def setUp(self):
        self.filler = GreenhouseFastFormFiller({"submit": False})

    def test_short_label_does_not_capture_an_unrelated_control(self):
        match = self.filler._matched_control(
            {"id": "race", "label": "Race"},
            controls("How do you identify? (race/ethnicity)"))
        self.assertIsNone(
            match,
            "'race' is a substring of the other question — matching it made a hidden "
            "field report a different dropdown's value")

    def test_exact_label_still_matches(self):
        self.assertIsNotNone(self.filler._matched_control(
            {"id": "race", "label": "Race"}, controls("Race")))

    def test_substantial_label_still_matches_by_containment(self):
        self.assertIsNotNone(self.filler._matched_control(
            {"id": "x", "label": "Preferred First Name"},
            controls("Preferred First Name")))
        self.assertIsNotNone(self.filler._matched_control(
            {"id": "x", "label": "Preferred First Name"},
            controls("What is your Preferred First Name please")))

    def test_id_and_name_lookups_are_unaffected(self):
        scanned = controls("Something Else")
        target = {"id": "school--0", "name": "", "label": "School"}
        scanned["by_id"]["school--0"] = {"id": "school--0"}
        self.assertEqual(self.filler._matched_control(target, scanned)["id"], "school--0",
                         "the id fast-path must still win before any label heuristic")

    def test_single_word_labels_never_match_by_containment(self):
        for label in ("Race", "Gender", "Country", "Phone"):
            self.assertIsNone(
                self.filler._matched_control(
                    {"id": label.lower(), "label": label},
                    controls(f"Please tell us your {label} for reporting")),
                f"{label!r} is one token — containment is not evidence of identity")


class ClearMultiSelectTest(unittest.TestCase):
    """The JS itself is verified against a captured live DOM; this pins the
    Python side down so the helper cannot quietly disappear."""

    def test_helper_exists_and_degrades_quietly(self):
        filler = GreenhouseFastFormFiller({"submit": False})
        self.assertTrue(hasattr(filler, "_clear_multi_select"))

        import asyncio

        class Dead:
            async def evaluate(self, *_a, **_k):
                raise RuntimeError("detached")

        self.assertEqual(asyncio.run(filler._clear_multi_select(Dead(), "x")), 0,
                         "a control we cannot reach must not raise mid-fill")


if __name__ == "__main__":
    unittest.main(verbosity=2)
