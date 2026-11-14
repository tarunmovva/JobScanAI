#!/usr/bin/env python3
"""The standalone Lever draft never presumes the candidate's legal status.

`python -m job_application_automator.lever_form_extractor <url>` writes a
draft fill_payload.json for a person to review before filling. It answered
every work-authorization question "Yes" and every sponsorship or visa
question "Yes" -- one person's situation, presented as everyone's. Those are
legal declarations only the candidate can make, so the draft leaves them
blank for the person to answer.

    python tests/test_lever_draft_answers.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job_application_automator import lever_form_extractor as lx  # noqa: E402

YES_NO = ["Select...", "Yes", "No"]


def field(label, opts=YES_NO, ftype="select"):
    return {"id": "cards[q]", "type": ftype, "label": label, "options": list(opts)}


class DraftLegalStatusTests(unittest.TestCase):
    def test_a_sponsorship_or_visa_question_is_left_for_the_candidate(self):
        for label in ("Will you now or in the future require visa sponsorship?",
                      "Do you require H-1B sponsorship?",
                      "Are you currently on OPT?"):
            self.assertEqual(lx._infer_answer(field(label), {}), "", label)

    def test_a_work_authorization_question_is_left_for_the_candidate(self):
        for label in ("Are you legally authorized to work in the United States?",
                      "Do you have the right to work in the UK?"):
            self.assertEqual(lx._infer_answer(field(label), {}), "", label)

    def test_a_word_merely_containing_opt_is_not_a_visa_question(self):
        # "optional" and "option" used to trip the visa rule.
        got = lx._infer_answer(field("Is relocation an option for you?"), {})
        self.assertEqual(got, "Yes")

    def test_the_other_defaults_are_unchanged(self):
        hear = field("How did you hear about us?", opts=["Select...", "LinkedIn", "Other"])
        self.assertEqual(lx._infer_answer(hear, {}), "LinkedIn")
        vet = field("Are you a protected veteran?", opts=["Select...", "I am a protected veteran", "I am not a protected veteran"])
        self.assertEqual(lx._infer_answer(vet, {}), "I am not a protected veteran")


if __name__ == "__main__":
    unittest.main(verbosity=2)
