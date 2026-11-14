#!/usr/bin/env python3
"""Regressions for one live failure.

Four required dropdowns were left empty by the payload agent, the filler recorded
nothing, the recovery agent went in blind, read a 63KB sidecar in one command, and
codex's --json line for that command exceeded asyncio's 64KiB stream limit — which
killed the recovery outright.

    python tests/test_blank_required_and_stream.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job_application_automator import agent_recovery as ar  # noqa: E402
from job_application_automator import recovery_focus as rf  # noqa: E402
from job_application_automator.greenhouse_fast_form_filler import (  # noqa: E402
    GreenhouseFastFormFiller,
)
from job_application_automator.runtime_support import submit_enabled  # noqa: E402

# The four required dropdowns the posting asked for, as extracted.
BLANKED_FIELDS = [
    {"id": "first_name", "label": "First Name", "type": "text", "required": True,
     "selector": "#first_name"},
    {"id": "question_10000001", "label": "Onsite 3x per week?", "type": "dropdown",
     "required": True, "selector": "#question_10000001"},
    {"id": "question_10000002", "label": "Open to relocation?", "type": "dropdown",
     "required": True, "selector": "#question_10000002"},
    {"id": "question_10000003", "label": "Citizenship", "type": "dropdown",
     "required": True, "selector": "#question_10000003"},
    {"id": "cover_letter", "label": "Cover Letter", "type": "file", "required": False,
     "selector": "#cover_letter"},
]
BLANKED_ANSWERS = {
    "first_name": "Jane",
    "question_10000001": "",
    "question_10000002": "",
    "question_10000003": "",
    "cover_letter": "",
}


def scanned(ids: list[str]) -> dict:
    """_scan_controls output, lookup maps included. The scan already filters to
    visible + non-disabled, so membership means the control is really on the page
    and fillable."""
    controls = [{"id": i, "name": "", "label": "", "label_key": "", "selector": f"#{i}",
                 "type": "dropdown", "visible": True, "required": True}
                for i in ids]
    return {
        "controls": controls,
        "by_id": {c["id"]: c for c in controls if c["id"]},
        "by_name": {},
        "by_label": {},
    }


def filler() -> GreenhouseFastFormFiller:
    return GreenhouseFastFormFiller({"submit": False})


class BlankRequiredTest(unittest.TestCase):
    def test_required_field_with_no_answer_is_reported(self):
        found = filler()._required_fields_left_blank(
            BLANKED_FIELDS, BLANKED_ANSWERS,
            scanned(["first_name", "question_10000001", "question_10000002", "question_10000003"]))
        self.assertEqual(
            [f["id"] for f in found],
            ["question_10000001", "question_10000002", "question_10000003"],
            "these three sank the application and nothing reported them")
        self.assertTrue(all(f["required"] and f["pass"] is False for f in found))

    def test_answered_required_field_is_not_reported(self):
        found = filler()._required_fields_left_blank(
            BLANKED_FIELDS, BLANKED_ANSWERS, scanned(["first_name"]))
        self.assertEqual(found, [], "first_name is answered; the rest are not on the page")

    def test_optional_blank_field_is_not_reported(self):
        found = filler()._required_fields_left_blank(
            [{"id": "cover_letter", "label": "Cover Letter", "type": "file",
              "required": False, "selector": "#cover_letter"}],
            {"cover_letter": ""}, scanned(["cover_letter"]))
        self.assertEqual(found, [], "an optional blank is not a failure")

    def test_conditionally_hidden_field_is_not_reported(self):
        # The control is absent from the live scan, so the form is not asking for
        # it — flagging it would fail forms that are actually complete.
        found = filler()._required_fields_left_blank(BLANKED_FIELDS, BLANKED_ANSWERS, scanned([]))
        self.assertEqual(found, [], "no live control means the form is not asking")

    def test_no_scan_is_not_treated_as_everything_missing(self):
        self.assertEqual(filler()._required_fields_left_blank(BLANKED_FIELDS, BLANKED_ANSWERS, None), [])


class BlindToFocusedTest(unittest.TestCase):
    """The point of the filler fix: this failure becomes repairable."""

    class Page:
        main_frame = None
        frames: list = []

        async def evaluate(self, _js, selector=None):
            return {"found": True, "value": "", "visible": True, "disabled": False,
                    "validation_text": "Please complete this field",
                    "control_html": "<select></select>", "open_menu_options": []}

    def test_dossier_names_every_blank_control(self):
        blank = filler()._required_fields_left_blank(
            BLANKED_FIELDS, BLANKED_ANSWERS,
            scanned(["question_10000001", "question_10000002", "question_10000003"]))
        failure = {"status": "validation_errors", "errors": [], "required_unfilled": blank,
                   "verification_failed": [], "unanswered_visible_controls": []}
        focus = asyncio.run(rf.build_focus(
            self.Page(), {"fields": BLANKED_FIELDS, "answers": BLANKED_ANSWERS}, failure))
        self.assertEqual(focus["focus_mode"], "focused", "this run went in blind before the fix")
        self.assertEqual([c["id"] for c in focus["controls"]],
                         ["question_10000001", "question_10000002", "question_10000003"])
        self.assertTrue(all(c["selector"] for c in focus["controls"]))


class ContextSplitTest(unittest.TestCase):
    def test_resume_is_not_inside_the_sidecar(self):
        focus = {"focus_mode": "blind", "controls": []}
        _, full = rf.build_context(
            platform="greenhouse", apply_url="u", page_url="u", page_title="t", marker="m",
            payload={"fields": BLANKED_FIELDS, "answers": BLANKED_ANSWERS},
            failure={"status": "validation_errors"}, resume_text="RESUME " * 2000, focus=focus)
        self.assertNotIn("resume_text", full,
                         "a single Get-Content of the sidecar is what blew the stream limit")
        self.assertEqual(full["resume_file"], "recovery_resume.txt")


class StreamLimitTest(unittest.TestCase):
    """asyncio's default 64KiB line limit turned one oversized event into a dead
    recovery. The limit is raised, and an over-limit line is skipped, not fatal."""

    CHILD = (
        'import sys\n'
        'sys.stdout.write(\'{"type":"turn.started"}\' + "\\n")\n'
        'sys.stdout.write("{\\"big\\":\\"" + "x" * 200000 + "\\"}" + "\\n")\n'
        'sys.stdout.write(\'{"type":"turn.completed","usage":{"input_tokens":5}}\' + "\\n")\n'
        'sys.stdout.flush()\n'
    )

    def test_raised_limit_reads_a_large_event(self):
        self.assertGreaterEqual(ar.STREAM_LIMIT_BYTES, 1 << 20)

    def test_oversized_line_is_skipped_and_the_run_continues(self):
        from job_application_automator.fill_logging import FillLog

        async def run(limit: int) -> tuple[int | None, list[str]]:
            original = ar.STREAM_LIMIT_BYTES
            ar.STREAM_LIMIT_BYTES = limit
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    out = Path(tmp)
                    metrics = rf.AgentMetrics()
                    code = await ar._run_codex_streaming(
                        [sys.executable, "-c", self.CHILD], "", out,
                        FillLog("test", "stream", out), metrics)
                    events = (out / "recovery_events.jsonl").read_text(encoding="utf-8").splitlines()
                    return code, events, metrics
            finally:
                ar.STREAM_LIMIT_BYTES = original

        # Squeeze the limit so the middle line is over it: the run must survive
        # and still see the events on either side.
        code, events, metrics = asyncio.run(run(65536))
        self.assertEqual(code, 0, "an oversized event must not fail the process")
        kinds = [json.loads(e).get("type") for e in events if e.startswith("{")]
        self.assertIn("turn.started", kinds)
        self.assertIn("turn.completed", kinds, "the event AFTER the oversized one must still arrive")
        self.assertEqual(metrics.input_tokens, 5, "metrics keep accruing past the dropped line")

        # With the shipped limit the big line is read normally, nothing dropped.
        code, events, _ = asyncio.run(run(ar.STREAM_LIMIT_BYTES))
        self.assertEqual(code, 0)
        self.assertEqual(len(events), 3)


class SubmitGateTest(unittest.TestCase):
    """Lever and Ashby had no submit gate at all — the only way to exercise them
    was to send a real application. One env var now governs all three, and the
    default must stay ON so normal runs are unchanged."""

    def setUp(self):
        self._saved = os.environ.get("JOB_AUTOMATOR_SUBMIT")

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("JOB_AUTOMATOR_SUBMIT", None)
        else:
            os.environ["JOB_AUTOMATOR_SUBMIT"] = self._saved

    def test_default_is_on(self):
        os.environ.pop("JOB_AUTOMATOR_SUBMIT", None)
        self.assertTrue(submit_enabled(), "a normal run must be unaffected")
        self.assertTrue(GreenhouseFastFormFiller({"submit": True}).submit)

    def test_env_zero_turns_every_platform_off(self):
        os.environ["JOB_AUTOMATOR_SUBMIT"] = "0"
        self.assertFalse(submit_enabled())
        self.assertFalse(GreenhouseFastFormFiller({"submit": True}).submit,
                         "the Go CLI hardcodes --submit; the env var is the only way off")

    def test_greenhouse_flag_still_governs_when_env_is_on(self):
        os.environ["JOB_AUTOMATOR_SUBMIT"] = "1"
        self.assertFalse(GreenhouseFastFormFiller({"submit": False}).submit)
        self.assertTrue(GreenhouseFastFormFiller({"submit": True}).submit)

    def test_recovery_refuses_to_run_when_submit_is_gated(self):
        """The recovery agent submits the application ITSELF — a filler-level gate
        does not contain it. Ashby calls attempt_recovery from two places, one of
        them BEFORE its submit block, and a fill-only smoke run sent a real
        application to a real employer through that path. The gate has to be here,
        at the choke point every platform shares."""
        import tempfile
        from pathlib import Path

        async def detect():
            return False

        class Page:
            main_frame = None
            frames: list = []
            url = "u"

            async def title(self):
                return "t"

            async def content(self):
                return "<html></html>"

            async def evaluate(self, *a, **k):
                return None

        os.environ["JOB_AUTOMATOR_SUBMIT"] = "0"
        for platform, status in (("ashby", "verification_failed"),
                                 ("lever", "validation_failed"),
                                 ("greenhouse", "validation_errors")):
            result: dict = {"errors": []}
            with tempfile.TemporaryDirectory() as tmp:
                asyncio.run(ar.attempt_recovery(
                    platform=platform, apply_url="u",
                    payload={"fields": [], "answers": {}, "candidate_profile": "x"},
                    result=result, output_dir=Path(tmp),
                    failure={"status": status, "errors": []}, page=Page(), detect=detect))
            rec = result["recovery"]
            self.assertFalse(rec["attempted"], f"{platform} recovery must not run")
            self.assertIn("JOB_AUTOMATOR_SUBMIT=0", rec["skipped"])

    def test_lever_and_ashby_import_the_gate(self):
        from job_application_automator import ashby_form_filler, lever_form_filler
        self.assertTrue(callable(lever_form_filler.submit_enabled))
        self.assertTrue(callable(ashby_form_filler.submit_enabled))


if __name__ == "__main__":
    unittest.main(verbosity=2)
