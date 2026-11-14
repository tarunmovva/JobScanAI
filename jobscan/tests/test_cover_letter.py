"""Cover letter detection and artifact generation.

The payload carries the letter as TEXT. These tests pin the two things that
could reach an employer wrongly: putting a letter somewhere it does not belong
(over-matching), and losing the application because an optional PDF dependency
is not installed.
"""
from __future__ import annotations

import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator.cover_letter import (  # noqa: E402
    ensure_pdf, inject_cover_letter, is_cover_letter_field, write_txt,
)

LETTER = (
    "Dear Hiring Team,\n\nI am writing about the Platform Engineer role. "
    "My work has centred on distributed systems and query engines.\n\nRegards,\nA Candidate"
)


class DetectionTests(unittest.TestCase):
    def test_it_finds_cover_letter_fields_by_label_id_and_name(self):
        for field in [
            {"label": "Cover Letter"},
            {"label": "Cover letter (optional)"},
            {"label": "COVER LETTER"},
            {"label": "Cover-Letter"},
            {"id": "cover_letter"},
            {"id": "_systemfield_cover_letter"},
            {"name": "cover_letter_text"},
        ]:
            self.assertTrue(is_cover_letter_field(field), field)

    def test_it_does_not_match_unrelated_fields(self):
        # Over-matching types a cover letter into someone's "Why us?" box, and
        # that reaches a real employer.
        for field in [
            {"label": "Resume/CV"},
            {"label": "Additional Information"},
            {"label": "Why do you want to work here?"},
            {"label": "Letter of Recommendation"},
            {"label": "Please cover your relevant experience"},
            {"id": "comments"},
            {"label": ""},
            {},
        ]:
            self.assertFalse(is_cover_letter_field(field), field)

    def test_it_tolerates_junk(self):
        for field in [None, "cover letter", 42, []]:
            self.assertFalse(is_cover_letter_field(field), field)


class ArtifactTests(unittest.TestCase):
    def test_txt_round_trips(self):
        with tempfile.TemporaryDirectory() as d:
            p = write_txt(LETTER, Path(d))
            self.assertTrue(p.is_file())
            self.assertEqual(p.suffix, ".txt")
            self.assertIn("Platform Engineer", p.read_text(encoding="utf-8"))

    def test_pdf_round_trips_through_a_real_reader(self):
        # The filler's manual-text fallback reads uploaded files back with
        # PyPDF2. A PDF it cannot parse is a PDF that silently fills nothing.
        with tempfile.TemporaryDirectory() as d:
            p = ensure_pdf(LETTER, Path(d))
            if p is None:
                self.skipTest("fpdf2 not installed")
            self.assertEqual(p.suffix, ".pdf")
            import PyPDF2
            text = "\n".join(pg.extract_text() or "" for pg in PyPDF2.PdfReader(str(p)).pages)
            self.assertIn("Platform Engineer", text)
            # Consecutive non-blank lines are the regression: multi_cell leaves
            # the cursor at the right margin, so the line after "Regards," had
            # no width left and fpdf2 raised. A one-line letter would not
            # have caught it.
            self.assertIn("Regards", text)
            self.assertIn("A Candidate", text)

    def test_typographic_characters_survive(self):
        # LLMs emit curly quotes and em dashes constantly; fpdf2's core fonts
        # are latin-1 only and would raise on them.
        with tempfile.TemporaryDirectory() as d:
            fancy = "I’ve built “query engines” — at scale – for years."
            p = ensure_pdf(fancy, Path(d))
            if p is None:
                self.skipTest("fpdf2 not installed")
            import PyPDF2
            text = "\n".join(pg.extract_text() or "" for pg in PyPDF2.PdfReader(str(p)).pages)
            self.assertIn("query engines", text)

    def test_a_missing_pdf_library_degrades_instead_of_raising(self):
        # A dependency that failed to install must cost the letter's PDF, not
        # the whole application.
        import builtins
        real_import = builtins.__import__

        def no_fpdf(name, *a, **kw):
            if name.startswith("fpdf"):
                raise ImportError("simulated missing fpdf2")
            return real_import(name, *a, **kw)

        with tempfile.TemporaryDirectory() as d:
            builtins.__import__ = no_fpdf
            try:
                self.assertIsNone(ensure_pdf(LONG_LETTER, Path(d)))
            finally:
                builtins.__import__ = real_import

    def test_empty_text_produces_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(ensure_pdf("   ", Path(d)))


class InjectionTests(unittest.TestCase):
    """Injection rewrites answers so no filler's fill loop has to change."""

    def _payload(self, fields, answers=None, letter=None):
        letter = LONG_LETTER if letter is None else letter
        p = {"fields": fields, "answers": dict(answers or {})}
        if letter is not False:
            p["cover_letter"] = letter
        return p

    def test_a_file_field_gets_a_real_file_path(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._payload([{"id": "cover_letter", "type": "file", "label": "Cover Letter"}])
            filled = inject_cover_letter(p, Path(d))
            self.assertEqual(filled, ["cover_letter"])
            value = p["answers"]["cover_letter"]
            self.assertTrue(value.endswith((".pdf", ".txt")), value)
            self.assertTrue(Path(value).is_file())

    def test_a_textarea_gets_the_prose_not_a_path(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._payload([{"id": "comments", "type": "textarea", "label": "Cover Letter"}])
            inject_cover_letter(p, Path(d))
            self.assertIn("Platform Engineer", p["answers"]["comments"])

    def test_optional_fields_are_filled_too(self):
        # The whole point of the setting: required-only fires on 1 field in 857.
        with tempfile.TemporaryDirectory() as d:
            p = self._payload([{"id": "cl", "type": "textarea",
                                "label": "Cover letter", "required": False}])
            self.assertEqual(inject_cover_letter(p, Path(d)), ["cl"])

    def test_it_never_overwrites_an_existing_answer(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._payload(
                [{"id": "cl", "type": "textarea", "label": "Cover Letter"}],
                answers={"cl": "something that already knew better"},
            )
            self.assertEqual(inject_cover_letter(p, Path(d)), [])
            self.assertEqual(p["answers"]["cl"], "something that already knew better")

    def test_no_letter_means_no_change(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._payload([{"id": "cl", "type": "textarea", "label": "Cover Letter"}],
                              letter=False)
            self.assertEqual(inject_cover_letter(p, Path(d)), [])
            self.assertNotIn("cl", p["answers"])

    def test_a_blank_letter_means_no_change(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._payload([{"id": "cl", "type": "textarea", "label": "Cover Letter"}],
                              letter=" " * 3 + chr(10) + "  ")
            self.assertEqual(inject_cover_letter(p, Path(d)), [])

    def test_non_cover_fields_are_left_alone(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._payload([
                {"id": "resume", "type": "file", "label": "Resume/CV"},
                {"id": "why", "type": "textarea", "label": "Why do you want to work here?"},
            ])
            self.assertEqual(inject_cover_letter(p, Path(d)), [])
            self.assertEqual(p["answers"], {})

    def test_the_pdf_is_generated_once_for_several_file_fields(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._payload([
                {"id": "cover_letter", "type": "file", "label": "Cover Letter"},
                {"id": "cl2", "type": "file", "label": "Cover letter (again)"},
            ])
            filled = inject_cover_letter(p, Path(d))
            self.assertEqual(len(filled), 2)
            self.assertEqual(p["answers"]["cover_letter"], p["answers"]["cl2"])

    def test_it_installs_an_answers_dict_when_the_payload_has_none(self):
        # setdefault would otherwise hand back a NEW dict that the filler's
        # local `answers` name does not point at.
        with tempfile.TemporaryDirectory() as d:
            p = {"fields": [{"id": "cl", "type": "textarea", "label": "Cover Letter"}],
                 "cover_letter": LONG_LETTER}
            self.assertEqual(inject_cover_letter(p, Path(d)), ["cl"])
            self.assertIn("cl", p["answers"])

    def test_a_field_without_an_id_is_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._payload([{"type": "textarea", "label": "Cover Letter"}])
            self.assertEqual(inject_cover_letter(p, Path(d)), [])


# A letter the length the prompt actually asks for (180-250 words), so it wraps
# many times. Wrap boundaries are where PDF text extraction loses spaces.
LONG_LETTER = """Dear Hiring Team,

I am writing to apply for the Platform Engineer role at Northwind. Over the
past five years I have built billing and payments services for subscription
products, most recently a ledger that reconciles card and bank payments in near
real time and cut the monthly close from four days to one. That work kept me
close to the finance and support teams, and I learned to treat an audit trail
as something customers depend on rather than an afterthought.

Before that I spent three years on internal tooling, where I owned the job
scheduler that ran a few thousand batch tasks every night. The work that
mattered most was not the scheduling itself but the recovery path: making each
task safe to rerun meant a failed night could simply be started again, and the
team stopped spending its mornings repairing half-finished data.

What draws me to Northwind specifically is the combination of careful money
movement and a product that small businesses rely on every day. Payments are
unusual in that a subtle bug rarely crashes anything; it quietly moves the wrong
amount, and the discipline that requires is the part of the job I enjoy most. I
would welcome the chance to discuss how my background fits what your team is
building.

Regards,
A Candidate"""


def _collapse(s):
    return re.sub(r"\s+", " ", s).strip()


class PdfFidelityTests(unittest.TestCase):
    """Almost every captured cover-letter field is a file input, so the PDF is
    the primary path -- and Greenhouse's manual-text fallback reads it back with
    PyPDF2. A substring assertion hides losses at wrap boundaries."""

    def test_a_wrapping_letter_survives_the_round_trip_intact(self):
        with tempfile.TemporaryDirectory() as d:
            path = ensure_pdf(LONG_LETTER, Path(d))
            if path is None:
                self.skipTest("fpdf2 not installed")
            import PyPDF2
            pages = PyPDF2.PdfReader(str(path)).pages
            got = " ".join(pg.extract_text() or "" for pg in pages)
            self.assertEqual(_collapse(got), _collapse(LONG_LETTER))


class PlaceholderGuardTests(unittest.TestCase):
    """The prompt asks for no placeholders. Asking is not enforcing."""

    def _payload(self, letter):
        return {"fields": [{"id": "cl", "type": "textarea", "label": "Cover Letter"}],
                "answers": {}, "cover_letter": letter}

    def test_a_bracketed_placeholder_is_refused(self):
        filler = " padding" * 200
        with tempfile.TemporaryDirectory() as d:
            for bad in ["Dear [Company], I am keen." + filler,
                        "Dear team at [Company Name]," + filler,
                        "Sincerely, [Your Name]" + filler]:
                p = self._payload(bad)
                self.assertEqual(inject_cover_letter(p, Path(d)), [], bad[:40])
                self.assertEqual(p["answers"], {})

    def test_a_letter_too_short_to_be_real_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._payload("Please hire me.")
            self.assertEqual(inject_cover_letter(p, Path(d)), [])

    def test_a_good_letter_still_goes_through(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._payload(LONG_LETTER)
            self.assertEqual(inject_cover_letter(p, Path(d)), ["cl"])

    def test_ordinary_brackets_in_prose_are_not_placeholders(self):
        with tempfile.TemporaryDirectory() as d:
            ok = LONG_LETTER.replace("Regards", "I led a team [of six] there. Regards")
            p = self._payload(ok)
            self.assertEqual(inject_cover_letter(p, Path(d)), ["cl"])


class FillerWiringTests(unittest.TestCase):
    """A platform that does not inject silently skips cover letters."""

    FILLERS = ["greenhouse_fast_form_filler.py", "ashby_form_filler.py",
               "lever_form_filler.py"]

    def _src(self, name):
        pkg = Path(__file__).resolve().parents[1] / "job_application_automator"
        return (pkg / name).read_text(encoding="utf-8")

    def test_all_three_fillers_inject(self):
        for name in self.FILLERS:
            self.assertIn("inject_cover_letter", self._src(name), f"{name} does not inject")

    def test_injection_happens_before_answers_is_bound(self):
        # inject_cover_letter installs a NEW answers dict when the payload had
        # none. Binding the local name afterwards is what makes that safe; bind
        # first and the filler fills a dict nobody reads.
        for name in ["ashby_form_filler.py", "lever_form_filler.py"]:
            src = self._src(name)
            inject_at = src.index("inject_cover_letter(payload")
            bind_at = src.index('answers: dict = payload.get("answers"')
            self.assertLess(inject_at, bind_at, f"{name} binds answers before injecting")


class AshbyComboboxCommitTests(unittest.TestCase):
    """The filler must not report a value the verifier will read back as empty.

    Live run 2026-09-09: three Ashby combobox fields (_systemfield_location,
    _systemfield_education_history, and a custom "How did you hear about us?")
    were reported filled while verification read actual="". That cost two
    recovery runs, 341s. Two of the three failure notes were also absent from
    _DEGRADED_FILL_MARKERS, so recovery launched with no field context.
    """

    def _mod(self):
        import job_application_automator.ashby_form_filler as m
        return m

    def test_every_non_commit_note_is_treated_as_degraded(self):
        m = self._mod()
        for note in ["value did not commit (clicked 'Birmingham')",
                     "no confident option match (value did not commit)",
                     "no confident option match",
                     "typed value, no dropdown option selected",
                     "no combobox found"]:
            self.assertTrue(m._is_degraded_fill(note), note)

    def test_a_real_success_is_not_degraded(self):
        m = self._mod()
        for note in ["selected option: Birmingham, Alabama, United States",
                     "committed via Enter: Bachelor's Degree",
                     "selected option via Enter: Job board",
                     ""]:
            self.assertFalse(m._is_degraded_fill(note), note)

    def test_the_writer_reads_back_through_the_verifier_s_own_reader(self):
        # Structural: the fill path must call _read_combobox_value, which is
        # what _verify_filled uses. Anything else lets the two disagree.
        import inspect
        m = self._mod()
        src = inspect.getsource(m._fill_combobox_scoped)
        self.assertIn("_read_combobox_value", src)
        self.assertIn("<uncommitted>", src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
