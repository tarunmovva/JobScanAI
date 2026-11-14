"""When the filler knows nothing field-level, ask the page.

Measured across every recorded recovery: focused runs always succeed, blind
runs about three times in four. Blind is not a mode anyone chose -- it is what happens when the failure
carries only the pseudo id _submission, which is every not_confirmed and
submit_button_not_found failure. The form is usually still displaying exactly
which controls it rejected.
"""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator.recovery_focus import (  # noqa: E402
    broken_control_specs, page_problem_specs,
)


class _Page:
    def __init__(self, found, raises=False):
        self._found = found
        self._raises = raises

    async def evaluate(self, *_a, **_k):
        if self._raises:
            raise RuntimeError("target closed")
        return self._found


def specs(found, raises=False):
    return asyncio.run(page_problem_specs(_Page(found, raises)))


class PageScanTests(unittest.TestCase):
    def test_an_invalid_control_becomes_a_focus_spec(self):
        got = specs([{"id": "email", "required": True, "invalid": True,
                      "empty": False, "message": "Enter a valid email"}])
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["id"], "email")
        self.assertEqual(got[0]["why"], "Enter a valid email")
        self.assertTrue(got[0]["required"])
        self.assertTrue(got[0]["from_page_scan"])

    def test_a_merely_required_empty_control_is_not_a_focus_spec(self):
        # The JS never reports these now, but the mapper must not invent focus
        # from one either: measured on the corpus, required-and-empty fired 40
        # times to the invalid signal's 5, and the extras were fields React had
        # filled. Re-filling a correct field is worse than not looking.
        got = specs([{"id": "phone", "required": True, "invalid": False, "empty": True, "message": ""}])
        self.assertEqual(got, [])

    def test_an_invalid_control_with_no_message_still_reads_sensibly(self):
        got = specs([{"id": "school", "required": False, "invalid": True, "empty": False, "message": ""}])
        self.assertEqual(got[0]["why"], "the page marks this control invalid")

    def test_pseudo_ids_are_never_focus_controls(self):
        # _submission is a whole-form outcome, not something to go and fix.
        got = specs([{"id": "_submission", "required": True, "invalid": True, "empty": False, "message": "x"}])
        self.assertEqual(got, [])

    def test_unusable_entries_are_dropped(self):
        got = specs([{"id": "", "invalid": True}, {"id": "   "}, "nonsense", None, {}])
        self.assertEqual(got, [])

    def test_a_failed_probe_degrades_to_blind_rather_than_raising(self):
        # Returning [] keeps the pre-existing behaviour; raising would abort a
        # recovery that could still have worked.
        self.assertEqual(specs([], raises=True), [])

    def test_nothing_wrong_on_the_page_stays_blind(self):
        self.assertEqual(specs([]), [])


class SpecShapeTests(unittest.TestCase):
    """A page-scan spec must be interchangeable with a filler spec.

    It was not. The consumer reads spec["runtime_options"] directly, the scan
    emitted a narrower dict, and the result was KeyError: 'runtime_options'
    killing the entire recovery -- on exactly the blind runs the scan exists to
    improve. A live probe against a Lever posting caught it; no unit test did,
    because both halves were tested apart.
    """

    def test_a_scanned_spec_carries_every_key_a_filler_spec_does(self):
        scanned = specs([{"id": "email", "required": True, "invalid": True,
                          "empty": False, "message": "Enter a valid email",
                          "tag": "input", "type": "email", "value": "x"}])[0]
        canonical = broken_control_specs(
            {"required_unfilled": [{"id": "email", "required": True}]})[0]
        self.assertEqual(set(canonical) - set(scanned), set(),
                         "a scanned spec is missing keys the consumer reads")


if __name__ == "__main__":
    unittest.main(verbosity=2)
