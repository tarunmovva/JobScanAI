#!/usr/bin/env python3
"""End-to-end shape test for attempt_recovery with codex stubbed out.

Exercises the whole handoff — dossier build, frozen-page capture, context write,
skill load, argv assembly, metrics accounting, recovery-block persistence — without
launching codex, Chrome, or playwright-mcp. What it cannot cover is the agent's own
behaviour; that is what tests/recovery_replay + recovery_replay.py are for.

    python tests/test_recovery_integration.py
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job_application_automator import agent_recovery as ar  # noqa: E402

FAILURE = {
    "status": "validation_errors",
    "reason": "",
    "errors": [{
        "id": "school--0", "type": "dropdown",
        "error": "dropdown option not selected: expected='State University' actual=''; "
                 "runtime_options=['State University', 'Lakeside State University']",
    }],
    "required_unfilled": [{"id": "school--0", "label": "School", "type": "dropdown", "required": True}],
    "verification_failed": [],
    "unanswered_visible_controls": [],
    "otp": {},
}

PAYLOAD = {
    "platform": "greenhouse",
    "apply_url": "https://boards.greenhouse.io/x/jobs/1",
    "fields": [
        {"id": "school--0", "label": "School", "type": "dropdown", "required": True, "selector": "#school--0"},
        {"id": "first_name", "label": "First Name", "type": "text", "required": True, "selector": "#first_name"},
    ],
    "answers": {"school--0": "State University", "first_name": "JANE"},
    "candidate_profile": "CANDIDATE PROFILE:\n- Work authorization: authorized",
}


def _skill_rev() -> str:
    """The rev declared in SKILL.md. Read, not hardcoded: a test that has to be
    edited on every skill change is a test that gets edited without being read."""
    import re
    from pathlib import Path
    md = (Path(__file__).resolve().parents[1]
          / "job_application_automator" / "skills" / "recovery-triage" / "SKILL.md")
    m = re.search(r"^rev:\s*(\S+)", md.read_text(encoding="utf-8"), re.M)
    return m.group(1) if m else ""


class FakePage:
    main_frame = None
    frames: list = []
    url = "https://boards.greenhouse.io/x/jobs/1"

    def __init__(self):
        self.title_script = None

    async def title(self):
        return "Apply — X"

    async def content(self):
        return "<html><body><select id='school--0'></select></body></html>"

    async def evaluate(self, js, arg=None):
        if "document.title" in str(js):
            self.title_script = js
            return None
        if arg == "#school--0":
            return {"found": True, "value": "", "visible": True, "disabled": False,
                    "validation_text": "Please complete this field",
                    "control_html": "<div class='select'></div>", "open_menu_options": []}
        return {"found": False}


class AttemptRecoveryTest(unittest.TestCase):
    def _run(self, *, verdict: dict, detect_result: bool):
        """Run attempt_recovery against a stubbed codex, return (returned, result)."""
        result: dict = {"errors": [], "submission": {"status": "validation_errors", "reason": "x"}}
        original_stream = ar._run_codex_streaming
        original_resolve = ar._resolve_codex

        async def fake_stream(argv, prompt, output_dir, log, metrics=None):
            # The prompt the agent would have received — assert on it below.
            Path(output_dir, "prompt.captured.txt").write_text(prompt, encoding="utf-8")
            Path(output_dir, "recovery_verdict.json").write_text(
                json.dumps(verdict), encoding="utf-8")
            for event in [
                {"type": "item.started", "item": {"type": "mcp_tool_call", "tool": "browser_tabs"}},
                {"type": "item.started", "item": {"type": "mcp_tool_call", "tool": "browser_select_option"}},
                {"type": "turn.completed", "usage": {"input_tokens": 9000, "cached_input_tokens": 7000,
                                                     "output_tokens": 120}},
            ]:
                if metrics is not None:
                    metrics.observe(event)
            return 0

        async def detect():
            return detect_result

        ar._run_codex_streaming = fake_stream
        ar._resolve_codex = lambda: ["codex-stub"]
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp)
                # A real resume on disk: attempt_recovery reads it back out of the
                # answers, which is what makes the resume-gating branch meaningful.
                resume_path = out / "resume.txt"
                resume_path.write_text(
                    "Bachelor of Science in Mechanical Engineering, State University\n" * 50,
                    encoding="utf-8")
                payload = {**PAYLOAD, "answers": {**PAYLOAD["answers"], "resume": str(resume_path)}}
                returned = asyncio.run(ar.attempt_recovery(
                    platform="greenhouse", apply_url=PAYLOAD["apply_url"], payload=payload,
                    result=result, output_dir=out, failure=FAILURE, page=FakePage(), detect=detect,
                ))
                artifacts = {p.name: p for p in out.iterdir()}
                captured = (out / "prompt.captured.txt").read_text(encoding="utf-8")
                focus = json.loads((out / "recovery_focus.json").read_text(encoding="utf-8"))
                context = json.loads((out / "recovery_context.json").read_text(encoding="utf-8"))
                full = json.loads((out / "recovery_context_full.json").read_text(encoding="utf-8"))
                page_html = (out / "recovery_page.html").read_text(encoding="utf-8")
        finally:
            ar._run_codex_streaming = original_stream
            ar._resolve_codex = original_resolve
        return returned, result, artifacts, captured, focus, context, full, page_html

    def test_confirmed_submit_records_the_full_cost_block(self):
        returned, result, artifacts, captured, focus, context, full, page_html = self._run(
            verdict={"outcome": "submitted", "tab_url": PAYLOAD["apply_url"], "fixed": ["school--0"],
                     "inferred": [], "unfixable": [], "notes": "picked State University"},
            detect_result=True)

        self.assertEqual(returned, {"status": "submitted", "reason": "recovered by AI agent"})
        rec = result["recovery"]
        self.assertTrue(rec["attempted"])
        self.assertEqual(rec["mode"], "fix")
        self.assertEqual(rec["outcome"], "submitted")
        # Pinned to the constant, not a literal: this proves the rev is
        # RECORDED, and should not fail every time the prompt changes.
        self.assertEqual(rec["prompt_rev"], ar.RECOVERY_PROMPT_REV)
        self.assertEqual(rec["skill_rev"], _skill_rev())
        # The thing that was unrecoverable before: which failure class triggered this.
        self.assertEqual(rec["trigger_status"], "validation_errors")
        self.assertEqual(rec["trigger_field_ids"], ["school--0"])
        self.assertEqual(rec["focus_mode"], "focused")
        self.assertEqual(rec["usage"]["uncached_input_tokens"], 2000)
        self.assertEqual(rec["tools"]["total"], 2)
        self.assertEqual(rec["tools"]["first_tool_name"], "browser_tabs")
        self.assertIsNotNone(rec["tools"]["time_to_first_mutation_s"])
        self.assertFalse(rec["tab_url_mismatch"])
        self.assertGreater(rec["context_bytes"]["_total"], 0)

    def test_artifacts_the_skill_and_the_replay_corpus_depend_on(self):
        _, _, artifacts, captured, focus, context, full, page_html = self._run(
            verdict={"outcome": "submitted", "tab_url": PAYLOAD["apply_url"], "fixed": [],
                     "inferred": [], "unfixable": [], "notes": ""},
            detect_result=True)

        for name in ("recovery_focus.json", "recovery_context.json",
                     "recovery_context_full.json", "recovery_page.html", "recovery_schema.json"):
            self.assertIn(name, artifacts, f"{name} must exist for the skill or the replay corpus")
        self.assertIn("school--0", page_html)

        control = focus["controls"][0]
        self.assertEqual(control["selector"], "#school--0")
        self.assertEqual(control["expected"], "State University")
        self.assertIn("State University", control["runtime_options"])
        self.assertEqual(control["live"]["validation_text"], "Please complete this field")

        # School is required-unfilled, so the resume earns its place this time.
        self.assertIn("resume_text", context)
        self.assertIn("State University", context["resume_text"])
        self.assertEqual(full["fields"], PAYLOAD["fields"])
        self.assertEqual(context["full_context_file"], "recovery_context_full.json")

    def test_prompt_carries_the_skill_not_the_legacy_literal(self):
        _, _, _, captured, _, _, _, _ = self._run(
            verdict={"outcome": "failed", "tab_url": PAYLOAD["apply_url"], "fixed": [],
                     "inferred": [], "unfixable": [], "notes": ""},
            detect_result=False)
        self.assertIn("focus_mode", captured)
        self.assertIn("recovery_focus.json", captured)
        self.assertNotIn("Snapshot the tab and assess its current state first",
                         captured, "that is the old literal's step 2 — the skill replaces it")

    def test_unconfirmed_agent_claim_does_not_flip_the_result(self):
        returned, result, *_ = self._run(
            verdict={"outcome": "submitted", "tab_url": PAYLOAD["apply_url"], "fixed": ["school--0"],
                     "inferred": ["guessed the discipline"], "unfixable": [], "notes": "submitted"},
            detect_result=False)
        self.assertIsNone(returned, "the platform detector is the only authority on submission")
        self.assertEqual(result["recovery"]["outcome"], "submitted")
        self.assertTrue(any(e.get("id") == "_ai_diagnosis" for e in result["errors"]),
                        "the agent's explanation must reach the user's record")

    def test_unrecoverable_status_still_records_its_trigger(self):
        result: dict = {"errors": []}

        async def detect():
            return False

        with tempfile.TemporaryDirectory() as tmp:
            returned = asyncio.run(ar.attempt_recovery(
                platform="greenhouse", apply_url="u", payload=PAYLOAD, result=result,
                output_dir=Path(tmp), failure={"status": "posting_closed"},
                page=FakePage(), detect=detect))
        self.assertIsNone(returned)
        self.assertFalse(result["recovery"]["attempted"])
        self.assertEqual(result["recovery"]["trigger_status"], "posting_closed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
