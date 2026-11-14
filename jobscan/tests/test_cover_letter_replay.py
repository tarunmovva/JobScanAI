"""Replay injection over every captured payload.

A filler is one-shot and destructive: a wrong answer is a real application to a
real employer. So the blast radius gets measured offline, against every form the
app has actually seen, before anything is submitted.

Reads the local .job-automator corpus, which is gitignored, so it skips cleanly
on a machine that has never run the app.
"""
from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator.cover_letter import inject_cover_letter  # noqa: E402
from job_application_automator.cover_letter import is_cover_letter_field  # noqa: E402

CORPUS = Path(__file__).resolve().parents[1] / ".job-automator"

# 217 words, no placeholders — passes the guard, like a real generated letter.
LETTER = """Dear Hiring Team,

I am writing to apply for this role. Over the past five years I have built
billing and payments services for subscription products, most recently a ledger
that reconciles card and bank payments in near real time and cut the monthly
close from four days to one. That work kept me close to the finance and support
teams, and I learned to treat an audit trail as something customers depend on
rather than an afterthought.

Before that I spent three years on internal tooling, where I owned the job
scheduler that ran a few thousand batch tasks every night. The work that
mattered most was not the scheduling itself but the recovery path: making each
task safe to rerun meant a failed night could simply be started again, and the
team stopped spending its mornings repairing half-finished data.

What draws me to this team is the combination of careful money movement and a
product that small businesses rely on every day. Payments are unusual in that a
subtle bug rarely crashes anything; it quietly moves the wrong amount, and the
discipline that requires is the part of the job I enjoy most. I would welcome
the chance to discuss how my background fits what your team is building.

Regards,
A Candidate"""


class ReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not CORPUS.is_dir():
            raise unittest.SkipTest("no .job-automator corpus on this machine")
        cls._loaded = []
        for f in CORPUS.rglob("fill_payload.json"):
            try:
                cls._loaded.append(json.loads(f.read_text(encoding="utf-8")))
            except Exception:
                continue
        if not cls._loaded:
            raise unittest.SkipTest("no captured payloads")

    def setUp(self):
        # inject_cover_letter mutates in place. Sharing one parsed corpus across
        # tests let an earlier test fill every field and made the coverage report
        # read zero -- deep-copy so each test sees the corpus as captured.
        self.payloads = copy.deepcopy(self._loaded)

    def test_injection_only_ever_adds_cover_letter_answers(self):
        with tempfile.TemporaryDirectory() as d:
            for payload in self.payloads:
                before = dict(payload.get("answers") or {})
                payload["cover_letter"] = LETTER
                added = inject_cover_letter(payload, Path(d))
                after = payload["answers"]
                # A blank answer is what injection exists to fill: nearly all
                # captured cover-letter fields are present-but-empty.
                # Anything with real content must survive untouched.
                for key, value in before.items():
                    if value in (None, "", []):
                        continue
                    self.assertEqual(after.get(key), value,
                                     f"injection changed existing answer {key!r}")
                changed = {k for k in after if after[k] != before.get(k)}
                self.assertEqual(changed, set(added))

    def test_every_added_key_is_a_cover_letter_field(self):
        with tempfile.TemporaryDirectory() as d:
            for payload in self.payloads:
                payload["cover_letter"] = LETTER
                added = set(inject_cover_letter(p := payload, Path(d)))
                if not added:
                    continue
                by_id = {str(f.get("id")): f for f in (p.get("fields") or [])
                         if isinstance(f, dict)}
                for fid in added:
                    self.assertTrue(is_cover_letter_field(by_id[fid]),
                                    f"filled a non-cover field {fid!r}")

    def test_it_reports_the_coverage_gain(self):
        with tempfile.TemporaryDirectory() as d:
            forms_touched = 0
            fields_filled = 0
            already_answered = 0
            for payload in self.payloads:
                cover_ids = [str(f.get("id")) for f in (payload.get("fields") or [])
                             if isinstance(f, dict) and is_cover_letter_field(f)]
                answers = payload.get("answers") or {}
                already_answered += sum(
                    1 for i in cover_ids if answers.get(i) not in (None, "", []))
                payload["cover_letter"] = LETTER
                added = inject_cover_letter(payload, Path(d))
                if added:
                    forms_touched += 1
                    fields_filled += len(added)
            print(f"\n  payloads replayed:          {len(self.payloads)}")
            print(f"  forms gaining a letter:     {forms_touched}")
            print(f"  cover-letter fields filled: {fields_filled}")
            print(f"  already answered (skipped): {already_answered}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
