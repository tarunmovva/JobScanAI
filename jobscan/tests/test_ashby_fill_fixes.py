#!/usr/bin/env python3
"""Regressions for the three Ashby failures found in one batch of live runs.

Each had a different root cause, and two were cases where the correct handler
already existed and dispatch never reached it:

  salary  "120000-140000" typed into <input type="number"> -> control rejects it,
          _fill_text returned True anyway, so it stayed invisible until verify.
  date    a react-datepicker extracted as type "text" -> never dispatched to
          _fill_date, whose _parse_date_value literally special-cases "two week".
  consent a checkbox with name="" identified by its generated DOM id
          "<prefix>_<fieldPath>-labeled-checkbox-0", which React regenerates on
          remount; every id/name-derived selector was dead after the reload while
          the container's data-field-path survived.

    python tests/test_ashby_fill_fixes.py
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job_application_automator import ashby_form_filler as af  # noqa: E402


class DurableFieldPathTest(unittest.TestCase):
    REAL = ("0a000000-0000-4000-8000-00000000000a"
            "_0b000000-0000-4000-8000-00000000000b-labeled-checkbox-0")

    def test_extracts_the_container_path_from_a_generated_id(self):
        self.assertEqual(af._durable_field_path(self.REAL),
                         "0b000000-0000-4000-8000-00000000000b",
                         "only this middle segment matches data-field-path and survives a remount")

    def test_higher_indices_parse(self):
        self.assertEqual(af._durable_field_path(self.REAL[:-1] + "7"),
                         "0b000000-0000-4000-8000-00000000000b")

    def test_ordinary_ids_are_left_alone(self):
        for other in ("I confirm I have read the above.", "consent", "",
                      "0b000000-0000-4000-8000-00000000000b"):
            self.assertEqual(af._durable_field_path(other), "",
                             f"{other!r} must not be treated as a generated id")


class DegradedFillTest(unittest.TestCase):
    """A True return can carry either a confirmation or a real degradation. Filing
    both under errors[] put 12 successes into the recovery dossier in one run."""

    def test_confirmations_are_not_errors(self):
        self.assertFalse(af._is_degraded_fill("selected option: Birmingham, Alabama, United States"))
        self.assertFalse(af._is_degraded_fill(""))

    def test_degradations_still_are(self):
        self.assertTrue(af._is_degraded_fill("typed value, no dropdown option selected"))
        self.assertTrue(af._is_degraded_fill("filled input (no combobox found)"))


class FillTextReadBackTest(unittest.TestCase):
    """_fill_text returned True unconditionally. A numeric input given a range
    reads back empty, and nothing noticed until pre-submit verification."""

    class Element:
        def __init__(self, reads_back):
            self.reads_back = reads_back
            self.typed = None

        async def count(self):
            return 1

        async def scroll_into_view_if_needed(self, **_):
            return None

        async def click(self, **_):
            return None

        async def press(self, *_a, **_k):
            return None

        async def input_value(self, **_):
            return self.reads_back

    class Page:
        def __init__(self, element):
            self.element = element
            self.keyboard = self

        def locator(self, _sel):
            return _Locator(self.element)

        async def type(self, value, delay=0):
            self.element.typed = value

        async def evaluate(self, *_a, **_k):
            raise RuntimeError("JS fallback should not be needed here")

    def _run(self, reads_back, value="120000-140000", ftype="number"):
        element = self.Element(reads_back)
        page = self.Page(element)
        return asyncio.run(af._fill_text(page, "salary", ftype, value, "#salary"))

    def test_rejected_value_is_reported_as_a_failure(self):
        ok, err = self._run(reads_back="")
        self.assertFalse(ok, "the control is empty — this is not a successful fill")
        self.assertIn("rejected", err)
        self.assertIn("numeric", err, "the message should say why a range cannot be typed")

    def test_accepted_value_still_succeeds(self):
        ok, err = self._run(reads_back="130000", value="130000")
        self.assertTrue(ok)
        self.assertEqual(err, "")

    def test_a_deliberately_empty_answer_is_not_a_failure(self):
        ok, _ = self._run(reads_back="", value="")
        self.assertTrue(ok, "clearing a field on purpose must not be reported as rejection")

    def test_unreadable_control_is_not_assumed_broken(self):
        ok, _ = self._run(reads_back=None, value="anything")
        self.assertTrue(ok, "a control we cannot read back must not be failed on suspicion")

    def test_text_fields_get_the_same_protection_without_the_numeric_hint(self):
        ok, err = self._run(reads_back="", value="Two weeks notice", ftype="text")
        self.assertFalse(ok)
        self.assertIn("rejected", err)
        self.assertNotIn("numeric", err)


class _Locator:
    def __init__(self, element):
        self.element = element
        self.first = element


class ComboboxCommitTest(unittest.TestCase):
    """Ashby writes the chosen option back into input.value, so there is no
    separate committed node to read (greenhouse's approach does not transfer).
    The signal that separates a committed value from a half-typed one is the
    menu: typing leaves aria-expanded="true", picking closes it. Verified
    against a live Ashby form."""

    class Page:
        def __init__(self, expanded, value):
            self.expanded, self.value = expanded, value

        async def evaluate(self, js, _arg=None):
            # Mirror the branch order of the real JS.
            if str(self.expanded) == "true":
                return "<uncommitted>"
            return self.value.strip() if self.value else ""

    def test_open_menu_reads_as_uncommitted(self):
        page = self.Page("true", "Birmingham")
        self.assertEqual(
            asyncio.run(af._read_combobox_value(page, "_systemfield_location")),
            "<uncommitted>",
            "a half-typed fragment must not verify green")

    def test_closed_menu_returns_the_committed_value(self):
        page = self.Page("false", "Birmingham, Alabama, United States")
        self.assertEqual(
            asyncio.run(af._read_combobox_value(page, "_systemfield_location")),
            "Birmingham, Alabama, United States")

    def test_empty_closed_control_is_empty_not_uncommitted(self):
        page = self.Page("false", "")
        self.assertEqual(asyncio.run(af._read_combobox_value(page, "_systemfield_location")), "")


class DateVerificationTest(unittest.TestCase):
    """The datepicker fix works — the control ends up holding 09/07/2026 — but
    the field is declared "text", so verification compared that against the
    answer "Immediately" as strings and failed a fill that was correct."""

    def test_rendered_date_is_recognised(self):
        for value in ("09/07/2026", "9/7/2026", "2026-09-07"):
            self.assertTrue(af._looks_like_rendered_date(value), value)
        for value in ("Immediately", "", "Two weeks notice", "120000-140000"):
            self.assertFalse(af._looks_like_rendered_date(value), value)

    def test_text_field_holding_a_date_is_compared_as_a_date(self):
        from datetime import datetime
        today = datetime.now().strftime("%m/%d/%Y")
        self.assertTrue(af._verification_match("text", "Immediately", today),
                        "a datepicker-backed text field must verify as a date")

    def test_ordinary_text_is_still_compared_as_text(self):
        self.assertFalse(af._verification_match("text", "Two weeks notice", ""))
        self.assertTrue(af._verification_match("text", "JANE", "JANE"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
