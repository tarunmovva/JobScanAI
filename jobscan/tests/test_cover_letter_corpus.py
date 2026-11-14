"""Detection measured against every field the app has actually seen.

A hand-written unit test proves the rule on examples its author chose. This
proves it on real forms, and in particular counts OVER-matching -- the failure
mode that would type a cover letter into a box asking for something else and
send it to a real employer.

Reads the local .job-automator corpus, which is gitignored, so it skips
cleanly on a machine that has never run the app.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator.cover_letter import is_cover_letter_field  # noqa: E402

CORPUS = Path(__file__).resolve().parents[1] / ".job-automator"


def _all_fields():
    for f in CORPUS.rglob("fill_payload.json"):
        try:
            payload = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        for field in payload.get("fields") or []:
            if isinstance(field, dict):
                yield field


def _label(field: dict) -> str:
    return str(field.get("label") or "").lower()


class CorpusDetectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not CORPUS.is_dir():
            raise unittest.SkipTest("no .job-automator corpus on this machine")
        cls.fields = list(_all_fields())
        if not cls.fields:
            raise unittest.SkipTest("no captured payloads to measure against")

    def test_every_labelled_cover_letter_field_is_detected(self):
        missed = [f for f in self.fields
                  if "cover letter" in _label(f) and not is_cover_letter_field(f)]
        self.assertEqual(missed[:5], [], f"{len(missed)} cover-letter fields not detected")

    def test_nothing_else_is_detected(self):
        false_positives = [
            f for f in self.fields
            if is_cover_letter_field(f)
            and "cover letter" not in _label(f)
            and "cover_letter" not in str(f.get("id") or "").lower()
            and "cover_letter" not in str(f.get("name") or "").lower()
        ]
        labels = sorted({str(f.get("label") or f.get("id")) for f in false_positives})
        self.assertEqual(false_positives[:5], [], f"over-matched: {labels[:10]}")

    def test_it_reports_the_numbers(self):
        hits = [f for f in self.fields if is_cover_letter_field(f)]
        by_type: dict[str, int] = {}
        required = 0
        for f in hits:
            by_type[str(f.get("type") or "?")] = by_type.get(str(f.get("type") or "?"), 0) + 1
            if f.get("required"):
                required += 1
        print(f"\n  fields scanned:      {len(self.fields)}")
        print(f"  cover-letter fields: {len(hits)}  ({required} required)")
        for t, n in sorted(by_type.items(), key=lambda kv: -kv[1]):
            print(f"    {t:<12} {n}")
        self.assertGreater(len(hits), 0, "corpus should contain cover-letter fields")


if __name__ == "__main__":
    unittest.main(verbosity=2)
