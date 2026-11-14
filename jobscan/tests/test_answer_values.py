#!/usr/bin/env python3
"""A "No" answer must not check the box.

The fillers turned a model's text answer into a click with plain Python
truthiness -- ashby `bool(value)`, lever `if value:` -- and `bool("No")` is
True. So "No" CHECKED the box, and verification agreed with it, because that
compared `bool(actual) == bool(expected)` with both sides True.

Found in the recorded payloads: a checkbox question answered "No"
was submitted checked, meaning the opposite of what it said.

    python tests/test_answer_values.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job_application_automator.answer_values import truthy  # noqa: E402


class TruthyTest(unittest.TestCase):
    def test_negative_answers_leave_the_box_unchecked(self):
        for value in ["No", "no", "NO", "no.", "N", "false", "False", "0",
                      "none", "null", "", "   ", "n/a", "NA",
                      "decline", "I decline", "I do not agree", "unchecked"]:
            self.assertFalse(truthy(value), f"{value!r} must NOT check the box")

    def test_affirmative_answers_check_the_box(self):
        for value in ["Yes", "yes", "Y", "true", "True", "1",
                      "I agree", "I certify that the above is accurate"]:
            self.assertTrue(truthy(value), f"{value!r} must check the box")

    def test_real_booleans_pass_through(self):
        self.assertTrue(truthy(True))
        self.assertFalse(truthy(False))

    def test_list_answers_use_emptiness(self):
        # The multi-select shape: something chosen means checked.
        self.assertTrue(truthy(["I agree"]))
        self.assertTrue(truthy(["Austin", "New York"]))
        self.assertFalse(truthy([]))

    def test_an_unrecognised_answer_checks_a_box(self):
        # Deliberate: an unknown answer on a REQUIRED consent box should tick it
        # rather than silently leave the form invalid. Only the explicit
        # negatives above turn it off.
        self.assertTrue(truthy("Acknowledged"))
        self.assertTrue(truthy("Confirmed"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
