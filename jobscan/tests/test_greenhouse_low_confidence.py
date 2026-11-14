"""A Greenhouse form the fast extractor could not read reliably.

"Low confidence" means fewer than four fields, or neither a resume upload nor
the name/email fields: every real Greenhouse application has those, so the
extractor did not find the real form. It used to fall back to a legacy
extractor whose module is not in the repo, so the job failed with
ModuleNotFoundError. It still is not filled -- a form read that partially
must not be filled and submitted -- but it now fails with the real reason.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job_application_automator import greenhouse_fast_form_extractor as gh  # noqa: E402

TWO_FIELDS = [
    {"id": "q1", "label": "Why do you want to work here?", "type": "textarea"},
    {"id": "q2", "label": "Portfolio", "type": "text"},
]
FULL_FORM = [
    {"id": "first_name", "label": "First Name", "type": "text"},
    {"id": "last_name", "label": "Last Name", "type": "text"},
    {"id": "email", "label": "Email", "type": "text"},
    {"id": "phone", "label": "Phone", "type": "text"},
    {"id": "resume", "label": "Resume/CV", "type": "file"},
    {"id": "linkedin", "label": "LinkedIn Profile", "type": "text"},
    {"id": "website", "label": "Website", "type": "text"},
    {"id": "sponsor", "label": "Will you require sponsorship?", "type": "dropdown"},
]


class LowConfidenceTests(unittest.TestCase):
    def test_a_form_read_only_partly_is_not_readable_and_says_what_was_missing(self):
        with self.assertRaises(gh.FormNotReadable) as ctx:
            gh._readable_or_raise(TWO_FIELDS, {}, closed_posting=False, allow_low=False)
        msg = str(ctx.exception)
        self.assertIn("2 field", msg)
        self.assertIn("no resume upload", msg)
        self.assertIn("no name/email fields", msg)
        self.assertIn("not filled", msg)

    def test_a_closed_posting_is_reported_as_closed_not_as_unreadable(self):
        self.assertEqual(gh._readable_or_raise(TWO_FIELDS, {}, closed_posting=True, allow_low=False), "low")

    def test_the_standalone_tool_can_still_ask_for_the_partial_result(self):
        self.assertEqual(gh._readable_or_raise(TWO_FIELDS, {}, closed_posting=False, allow_low=True), "low")

    def test_a_real_form_passes(self):
        self.assertEqual(gh._readable_or_raise(FULL_FORM, {}, closed_posting=False, allow_low=False), "high")

    def test_the_missing_legacy_extractor_is_gone(self):
        self.assertFalse(hasattr(gh.FastGreenhouseFormExtractor, "_legacy_extract"))
        source = Path(gh.__file__).read_text(encoding="utf-8")
        self.assertNotIn("form_extractor import SimpleFormExtractor", source)


if __name__ == "__main__":
    unittest.main()
