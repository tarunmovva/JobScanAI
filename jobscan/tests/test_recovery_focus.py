#!/usr/bin/env python3
"""Unit tests for the recovery focus dossier, context trimming, and metrics.

    python tests/test_recovery_focus.py
    python -m unittest discover -s tests -p "test_*.py"

No test framework beyond the stdlib — this repo has none, and adding one would be
a bigger diff than the code under test.
"""

from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job_application_automator import recovery_focus as rf  # noqa: E402
from job_application_automator import recovery_replay as rr  # noqa: E402

# The real shape recorded by the greenhouse filler for one job: the same
# control appears in verification_failed AND errors[], and only the errors[] entry
# carries the live rendered menu.
GENDER_FAILURE = {
    "status": "clicked",
    "reason": "",
    "errors": [{
        "id": "gender", "type": "dropdown",
        "error": "dropdown option not selected: expected='Decline To Self Identify' actual='Male'; "
                 "runtime_options=['Male', 'Female', 'Decline To Self Identify']",
        "verification": {"id": "gender", "label": "Gender", "type": "dropdown",
                         "required": False, "expected": "Decline To Self Identify", "actual": "Male", "pass": False},
    }],
    "required_unfilled": [],
    "verification_failed": [{"id": "gender", "label": "Gender", "type": "dropdown",
                             "required": False, "expected": "Decline To Self Identify", "actual": "Male", "pass": False}],
    "unanswered_visible_controls": [],
    "otp": {},
}

PAYLOAD = {
    "fields": [
        {"id": "gender", "label": "Gender", "type": "dropdown", "required": False, "selector": "#gender"},
        {"id": "first_name", "label": "First Name", "type": "text", "required": True, "selector": "#first_name"},
        {"id": "resume", "label": "Resume", "type": "file", "required": False, "selector": "#resume"},
        {"id": "school--0", "label": "School", "type": "dropdown", "required": True, "selector": "#school--0"},
    ],
    "answers": {"gender": "Decline To Self Identify", "first_name": "JANE",
                "resume": "C:/resumes/jane_doe_resume.pdf", "school--0": "State University"},
    "candidate_profile": "CANDIDATE PROFILE:\n- Work authorization: authorized",
}

RESUME = "Bachelor of Science in Mechanical Engineering, State University\n" * 200


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
    """Minimal Playwright page stand-in: `hits` are the selectors that resolve."""

    main_frame = None
    frames: list = []

    def __init__(self, hits: set[str] | None = None, value: str = "Female"):
        self.hits = hits or set()
        self.value = value

    async def evaluate(self, _js, selector=None):
        if selector in self.hits:
            return {"found": True, "value": self.value, "visible": True, "disabled": False,
                    "validation_text": "Please select an option",
                    "control_html": "<div class='select__control'></div>",
                    "open_menu_options": []}
        return {"found": False}

    async def content(self):
        return "<html><body>frozen</body></html>"


class RuntimeOptionsTest(unittest.TestCase):
    def test_parsed_out_of_the_error_detail(self):
        detail = "dropdown option not selected: expected='Female' actual=''; runtime_options=['Male', 'Female']"
        self.assertEqual(rf.runtime_options_from_detail(detail), ["Male", "Female"])

    def test_absent_or_malformed_is_empty(self):
        self.assertEqual(rf.runtime_options_from_detail("no menu here"), [])
        self.assertEqual(rf.runtime_options_from_detail("runtime_options=[not python]"), [])
        self.assertEqual(rf.runtime_options_from_detail(None), [])


class BrokenControlSpecsTest(unittest.TestCase):
    def test_duplicate_control_merges_instead_of_dropping(self):
        specs = rf.broken_control_specs(GENDER_FAILURE)
        self.assertEqual(len(specs), 1, "gender is in two lists but is one control")
        self.assertEqual(specs[0]["runtime_options"],
                         ["Male", "Female", "Decline To Self Identify"],
                         "the live menu only exists on the errors[] entry — it must survive the merge")

    def test_page_level_pseudo_ids_are_not_controls(self):
        specs = rf.broken_control_specs({"errors": [
            {"id": "_submission", "error": "submit not confirmed"},
            {"id": "_verification", "error": "x"},
            {"id": "_ai_diagnosis", "error": "y"},
        ]})
        self.assertEqual(specs, [])

    def test_ashby_systemfield_controls_are_real_controls(self):
        # Every Ashby control is named _systemfield_*; a leading-underscore rule
        # classified all of them as page-level noise and made every Ashby failure
        # look un-localisable. _systemfield_location alone appears in 38 recorded
        # failures.
        specs = rf.broken_control_specs({"errors": [
            {"id": "_systemfield_location", "error": "location combobox not committed"},
            {"id": "_verification", "error": "post-fill verification failed"},
        ]})
        self.assertEqual([s["id"] for s in specs], ["_systemfield_location"])

    def test_lever_and_ashby_report_failures_under_verification_checks(self):
        # Their errors[] carries only _submission; the per-control result lives in
        # verification.checks. No recorded Lever failure localised without this.
        specs = rf.broken_control_specs({
            "status": "validation_failed",
            "errors": [{"id": "_submission", "error": "validation_failed: 1 invalid controls remain"}],
            "verification": {"checks": [
                {"id": "name", "expected": "J D", "actual": "J D", "pass": True},
                {"id": "urls[LinkedIn]", "expected": "https://li/x", "actual": "", "pass": False},
            ]},
        })
        self.assertEqual([s["id"] for s in specs], ["urls[LinkedIn]"])
        self.assertEqual(specs[0]["observed_actual"], "")

    def test_lever_invalid_controls_name_the_rejected_fields(self):
        # Lever reports "N invalid controls remain" and separately collects the
        # controls themselves; forwarding that list is what turns a blind Lever
        # recovery into a focused one.
        specs = rf.broken_control_specs({
            "status": "validation_failed",
            "reason": "2 invalid controls remain",
            "errors": [{"id": "_submission", "error": "validation_failed: 2 invalid controls remain"}],
            "invalid_controls": [
                {"name": "urls[LinkedIn]", "type": "url", "label": "LinkedIn URL",
                 "message": "Please enter a URL.", "value": "janedoe-dev"},
                {"name": "cards[abc][why]", "type": "textarea", "label": "Why us?",
                 "message": "Please fill out this field.", "value": ""},
            ],
        })
        self.assertEqual([s["id"] for s in specs], ["urls[LinkedIn]", "cards[abc][why]"])
        self.assertEqual(specs[0]["why"], "Please enter a URL.")
        self.assertEqual(specs[0]["observed_actual"], "janedoe-dev")
        self.assertTrue(all(s["required"] for s in specs))

    def test_form_validation_message_wins_over_a_longer_filler_string(self):
        # "Please enter a URL." is the most informative and the shortest — a
        # length tie-break would let a vaguer filler error overwrite it.
        specs = rf.broken_control_specs({
            "invalid_controls": [{"name": "urls[LinkedIn]", "message": "Please enter a URL.",
                                  "value": "janedoe-dev"}],
            "errors": [{"id": "urls[LinkedIn]",
                        "error": "text field verification failed after fill attempt with retry"}],
        })
        self.assertEqual(specs[0]["why"], "Please enter a URL.")

    def test_required_unfilled_comes_first(self):
        specs = rf.broken_control_specs({
            "errors": [{"id": "gender", "error": "verification failed"}],
            "required_unfilled": [{"id": "school--0", "label": "School"}],
        })
        self.assertEqual([s["id"] for s in specs], ["school--0", "gender"])
        self.assertTrue(specs[0]["required"])

    def test_capped_so_a_broken_form_cannot_reinflate_the_prompt(self):
        failure = {"errors": [{"id": f"q{i}", "error": "e"} for i in range(50)]}
        self.assertEqual(len(rf.broken_control_specs(failure)), rf.MAX_FOCUS_CONTROLS)


class BuildFocusTest(unittest.TestCase):
    def test_focused_control_carries_selector_expected_and_live_evidence(self):
        focus = asyncio.run(rf.build_focus(FakePage({"#gender"}), PAYLOAD, GENDER_FAILURE))
        self.assertEqual(focus["focus_mode"], "focused")
        control = focus["controls"][0]
        self.assertEqual(control["id"], "gender")
        self.assertEqual(control["selector"], "#gender")
        self.assertEqual(control["expected"], "Decline To Self Identify")
        self.assertEqual(control["observed_actual"], "Male")
        self.assertEqual(control["live"]["validation_text"], "Please select an option")
        self.assertIn("Decline To Self Identify", control["runtime_options"])

    def test_no_field_level_failure_is_blind(self):
        focus = asyncio.run(rf.build_focus(FakePage(), PAYLOAD,
                                           {"errors": [{"id": "_submission", "error": "x"}]}))
        self.assertEqual(focus["focus_mode"], "blind")
        self.assertEqual(focus["controls"], [])

    def test_unresolvable_selector_is_reported_not_fatal(self):
        focus = asyncio.run(rf.build_focus(FakePage(set()), PAYLOAD, GENDER_FAILURE))
        self.assertEqual(focus["controls"][0]["live"], {"found": False})


class BuildContextTest(unittest.TestCase):
    def _context(self, failure, focus_hits=("#gender",)):
        focus = asyncio.run(rf.build_focus(FakePage(set(focus_hits)), PAYLOAD, failure))
        return rf.build_context(
            platform="greenhouse", apply_url="https://x/y", page_url="https://x/y",
            page_title="t", marker="[fix-1-2]", payload=PAYLOAD, failure=failure,
            resume_text=RESUME, focus=focus)

    def test_resume_omitted_for_a_verification_only_failure(self):
        context, full = self._context(GENDER_FAILURE)
        self.assertNotIn("resume_text", context,
                         "43% of the median prompt, and useless when the answer is already known")
        # The resume moved out of the sidecar into its own file: a blind agent
        # reads the sidecar in one command, and codex emits that command's whole
        # output as ONE --json line, which is what blew the stream limit.
        self.assertNotIn("resume_text", full)
        self.assertEqual(full["resume_file"], "recovery_resume.txt")
        self.assertEqual(context["resume_file"], "recovery_resume.txt")

    def test_resume_included_when_something_is_unanswered(self):
        failure = dict(GENDER_FAILURE, required_unfilled=[{"id": "school--0", "label": "School"}])
        context, _ = self._context(failure)
        self.assertIn("resume_text", context)

    def test_resume_included_in_blind_mode(self):
        context, _ = self._context({"errors": [{"id": "_submission", "error": "x"}]})
        self.assertEqual(context["focus_mode"], "blind")
        self.assertIn("resume_text", context)

    def test_answers_scoped_to_focus_but_file_paths_survive(self):
        context, _ = self._context(GENDER_FAILURE)
        self.assertEqual(context["answers"]["gender"], "Decline To Self Identify")
        self.assertNotIn("first_name", context["answers"])
        self.assertEqual(context["answers"]["resume"], "C:/resumes/jane_doe_resume.pdf",
                         "the agent may need to re-upload a file whose field never failed")

    def test_field_index_marks_failed_answered_and_blank(self):
        context, _ = self._context(GENDER_FAILURE)
        index = {line.split(" | ")[0]: line for line in context["field_index"]}
        self.assertTrue(index["gender"].endswith("FAILED"))
        self.assertTrue(index["first_name"].endswith("answered"))
        self.assertEqual(len(context["field_index"]), len(PAYLOAD["fields"]))

    def test_trimming_is_a_large_win_on_the_real_shape(self):
        context, full = self._context(GENDER_FAILURE)
        trimmed = rf.context_bytes(context)["_total"]
        # Compare against what the agent used to be sent: the whole form, every
        # answer, and the whole resume, all inside the prompt.
        legacy = len(json.dumps(
            {**full, "resume_text": RESUME, "failure": GENDER_FAILURE}, ensure_ascii=False))
        self.assertLess(trimmed, legacy / 2,
                        f"trimmed={trimmed} legacy={legacy} — the point of the change")


class SkillLoadingTest(unittest.TestCase):
    def test_skill_loads_with_its_rev_and_frontmatter_stripped(self):
        body, rev = rf.load_skill("SKILL.md", "FALLBACK")
        self.assertEqual(rev, _skill_rev())
        self.assertFalse(body.startswith("---"))
        self.assertIn("focus_mode", body)

    def test_diagnose_skill_is_read_only(self):
        body, _ = rf.load_skill("DIAGNOSE.md", "FALLBACK")
        self.assertIn("READ-ONLY", body)

    def test_missing_file_falls_back_loudly(self):
        body, rev = rf.load_skill("does-not-exist.md", "IN-CODE LITERAL")
        self.assertEqual((body, rev), ("IN-CODE LITERAL", "fallback"))


class AgentMetricsTest(unittest.TestCase):
    def test_counts_tokens_tools_and_first_mutation(self):
        metrics = rf.AgentMetrics()
        for event in [
            {"type": "item.started", "item": {"type": "mcp_tool_call", "tool": "browser_tabs"}},
            {"type": "item.started", "item": {"type": "mcp_tool_call", "tool": "browser_snapshot"}},
            {"type": "item.started", "item": {"type": "mcp_tool_call", "tool": "browser_select_option"}},
            {"type": "item.completed", "item": {"type": "mcp_tool_call", "tool": "browser_select_option",
                                                "error": {"message": "boom"}}},
            {"type": "turn.completed", "usage": {"input_tokens": 1000, "cached_input_tokens": 800,
                                                 "output_tokens": 50, "reasoning_output_tokens": 10}},
        ]:
            metrics.observe(event)
        out = metrics.as_dict()
        self.assertEqual(out["usage"]["uncached_input_tokens"], 200)
        self.assertEqual(out["tools"]["total"], 3)
        self.assertEqual(out["tools"]["errors"], 1)
        self.assertEqual(out["tools"]["snapshot"], 1)
        self.assertEqual(out["tools"]["first_tool_name"], "browser_tabs")
        self.assertIsNotNone(out["tools"]["time_to_first_mutation_s"])

    def test_snapshot_and_run_code_are_tracked_by_name(self):
        metrics = rf.AgentMetrics()
        for _ in range(4):
            metrics.observe({"type": "item.started",
                             "item": {"type": "mcp_tool_call", "tool": "browser_run_code_unsafe"}})
        self.assertEqual(metrics.as_dict()["tools"]["run_code_unsafe"], 4)


class ReplayGradingTest(unittest.TestCase):
    def test_ground_truth_drops_page_level_ids(self):
        ids = rr._ground_truth_ids({
            "errors": [{"id": "gender"}, {"id": "_submission"}, {"id": "_ai_diagnosis"}],
            "required_unfilled": [{"id": "school--0"}],
        })
        self.assertEqual(ids, ["school--0", "gender"])

    def test_recall_over_named_field_ids(self):
        verdict = {"outcome": "submitted", "fixed": ["set gender to Decline To Self Identify"],
                   "unfixable": [], "notes": "done"}
        result = rr.grade(verdict, ["gender", "school--0"])
        self.assertEqual(result["named"], ["gender"])
        self.assertEqual(result["missed"], ["school--0"])
        self.assertEqual(result["recall"], 0.5)

    def test_no_expectation_is_not_a_zero(self):
        self.assertIsNone(rr.grade({"fixed": []}, [])["recall"])


if __name__ == "__main__":
    unittest.main(verbosity=2)


# A live run, one ashby job. The filler recorded
# errors: [] and every verification check passing, so the dossier came out
# EMPTY and recovery ran in blind mode -- 63s, 283k input tokens, 12 tool calls
# -- to rediscover three questions the filler had already listed under
# skipped[]. It then inferred answers to them, including "Yes -- assumed
# ability to relocate for office work", on a real submitted application.
BLIND_RUN_SKIPPED = [
    {"id": "00000000-0000-4000-8000-000000000001", "reason": "empty value"},
    {"id": "00000000-0000-4000-8000-000000000002", "reason": "empty value"},
    {"id": "00000000-0000-4000-8000-000000000003", "reason": "empty value"},
]

# What the FIXED ashby extractor reports for that form: the two custom questions
# are required (their labels carry _required_), the website field is not.
BLIND_RUN_FIELDS = [
    {"id": "00000000-0000-4000-8000-000000000001", "label": "Have you used our product before?",
     "type": "checkbox", "required": True},
    {"id": "00000000-0000-4000-8000-000000000002",
     "label": "Are you able to work in-person out of our downtown office?",
     "type": "checkbox", "required": True},
    {"id": "00000000-0000-4000-8000-000000000003",
     "label": "Do you have a website to share? (optional)", "type": "text", "required": False},
]

BLIND_RUN_FAILURE = {
    "status": "not_confirmed",
    "reason": "visible validation/error state remains after submit",
    "errors": [{"id": "_submission",
                "error": "not_confirmed: visible validation/error state remains after submit"}],
    "verification": {"checks": [{"id": "_systemfield_name", "expected": "J D",
                                 "actual": "J D", "pass": True}],
                     "summary": "4/4 value checks passed"},
    "skipped": BLIND_RUN_SKIPPED,
}


class SkippedRequiredControlsTest(unittest.TestCase):
    def test_without_field_definitions_nothing_is_localisable(self):
        # This is the old behaviour: skip entries carry only an id and a reason,
        # so on their own they cannot distinguish "left a required question
        # blank" from "correctly ignored an optional one".
        self.assertEqual(rf.broken_control_specs(BLIND_RUN_FAILURE), [])

    def test_a_required_skipped_control_is_localised(self):
        specs = rf.broken_control_specs(BLIND_RUN_FAILURE, BLIND_RUN_FIELDS)
        self.assertEqual(
            [s["id"] for s in specs],
            ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
            "the two REQUIRED skipped questions are what blocked the submit")
        self.assertTrue(all(s["required"] for s in specs))
        self.assertIn("left blank", specs[0]["why"])

    def test_an_optional_skipped_control_is_not_reported(self):
        # Optional questions are SUPPOSED to be skipped. Reporting them would
        # send the agent after a non-issue on almost every form.
        specs = rf.broken_control_specs(BLIND_RUN_FAILURE, BLIND_RUN_FIELDS)
        self.assertNotIn("00000000-0000-4000-8000-000000000003", [s["id"] for s in specs])

    def test_a_control_skipped_for_a_non_empty_reason_is_ignored(self):
        # "control not present (conditional)" is not something the agent can act
        # on, and greenhouse records it for every hidden EEO dropdown.
        failure = {"skipped": [{"id": "race", "reason": "control not present (conditional)"}]}
        fields = [{"id": "race", "label": "Race", "type": "dropdown", "required": True}]
        self.assertEqual(rf.broken_control_specs(failure, fields), [])

    def test_a_real_error_still_outranks_a_skipped_control(self):
        failure = dict(BLIND_RUN_FAILURE)
        failure["required_unfilled"] = [{"id": "_systemfield_resume", "label": "Resume"}]
        specs = rf.broken_control_specs(failure, BLIND_RUN_FIELDS)
        self.assertEqual(specs[0]["id"], "_systemfield_resume",
                         "required_unfilled is ordered first and must stay first")
