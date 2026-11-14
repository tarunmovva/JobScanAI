"""Which local files a form fill may upload.

An AI writes form answers after reading the job posting, which is untrusted
text. An answer for a file field is a path the filler attaches -- before any
submit, so JOB_AUTOMATOR_SUBMIT=0 does not protect against it. These tests
pin that only the chosen résumé and files JobScan wrote for this job can be
attached, and that the normal résumé and cover-letter uploads still work.
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator import upload_guard  # noqa: E402
from job_application_automator import agent_recovery  # noqa: E402
from job_application_automator import lever_form_filler, ashby_form_filler  # noqa: E402
from job_application_automator.cover_letter import inject_cover_letter  # noqa: E402
from job_application_automator.greenhouse_fast_form_filler import GreenhouseFastFormFiller  # noqa: E402

LETTER = ("Dear Hiring Team,\n\n" + "I build reliable data systems and enjoy hard problems. " * 30
          + "\n\nRegards,\nA Candidate")


class _Element:
    def __init__(self, uploads: list[str]):
        self.uploads = uploads

    @property
    def first(self):
        return self

    async def count(self):
        return 1

    async def set_input_files(self, path, timeout=None):
        self.uploads.append(str(path))


class _Page:
    """Just enough of a Playwright page for the Lever/Ashby file helpers."""

    def __init__(self):
        self.uploads: list[str] = []

    def locator(self, _selector):
        return _Element(self.uploads)


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.job_dir = root / "applications" / "lever" / "job-1"
        self.job_dir.mkdir(parents=True)
        self.resume = root / "resume" / "Alex Rivera.pdf"
        self.resume.parent.mkdir()
        self.resume.write_bytes(b"%PDF-1.4 resume")
        self.secret = root / "secrets" / "imap_config.json"
        self.secret.parent.mkdir()
        self.secret.write_text('{"password": "hunter2"}', encoding="utf-8")
        self.letter = self.job_dir / "cover_letter.pdf"
        self.letter.write_bytes(b"%PDF-1.4 letter")

    def tearDown(self):
        upload_guard.reset()
        self.tmp.cleanup()

    def arm(self):
        return upload_guard.configure({"resume_path": str(self.resume)}, (self.job_dir,))

    def test_a_payload_without_resume_path_keeps_the_old_behaviour(self):
        self.assertFalse(upload_guard.configure({"answers": {}}, (self.job_dir,)))
        self.assertEqual(upload_guard.refusal(self.secret), "")

    def test_the_resume_and_files_in_the_job_folder_are_allowed(self):
        self.assertTrue(self.arm())
        self.assertEqual(upload_guard.refusal(self.resume), "")
        self.assertEqual(upload_guard.refusal(self.letter), "")
        sub = self.job_dir / "greenhouse_fast_filler" / "cover_letter.txt"
        sub.parent.mkdir()
        sub.write_text("letter", encoding="utf-8")
        self.assertEqual(upload_guard.refusal(sub), "")

    def test_any_other_file_is_refused(self):
        self.arm()
        self.assertIn("upload refused", upload_guard.refusal(self.secret))
        self.assertIn("upload refused", upload_guard.refusal(self.job_dir / ".." / ".." / ".." / "secrets" / "imap_config.json"))
        self.assertIn("upload refused", upload_guard.refusal(self.job_dir))  # a folder
        self.assertIn("upload refused", upload_guard.refusal(self.job_dir / "missing.pdf"))
        self.assertIn("upload refused", upload_guard.refusal("~/.codex/auth.json"))

    def test_an_empty_resume_path_still_allows_job_folder_files_only(self):
        upload_guard.configure({"resume_path": ""}, (self.job_dir,))
        self.assertEqual(upload_guard.refusal(self.letter), "")
        self.assertIn("upload refused", upload_guard.refusal(self.resume))

    def test_lever_and_ashby_attach_the_resume_but_not_an_injected_path(self):
        self.arm()
        for module in (lever_form_filler, ashby_form_filler):
            page = _Page()
            ok, _ = asyncio.run(module._fill_file(page, "resume", str(self.resume), "input[type=file]"))
            self.assertTrue(ok, module.__name__)
            ok, err = asyncio.run(module._fill_file(page, "cover", str(self.secret), "input[type=file]"))
            self.assertFalse(ok, module.__name__)
            self.assertIn("upload refused", err)
            self.assertEqual(page.uploads, [str(self.resume)], module.__name__)

    def test_greenhouse_refuses_an_injected_path_before_touching_the_page(self):
        self.arm()
        filler = object.__new__(GreenhouseFastFormFiller)
        ok, err = asyncio.run(filler._fill_file(target=None, field={"id": "cover_letter"}, answer=str(self.secret)))
        self.assertFalse(ok)
        self.assertIn("upload refused", err)

    def test_the_generated_cover_letter_is_still_uploadable(self):
        payload = {
            "resume_path": str(self.resume),
            "cover_letter": LETTER,
            "fields": [{"id": "cover_letter", "label": "Cover Letter", "type": "file"}],
            "answers": {},
        }
        filled = inject_cover_letter(payload, self.job_dir)
        self.assertEqual(filled, ["cover_letter"])
        upload_guard.configure(payload, (self.job_dir,))
        self.assertEqual(upload_guard.refusal(payload["answers"]["cover_letter"]), "")


class RepairToolArgsTests(unittest.TestCase):
    def setUp(self):
        self._resolve = agent_recovery._resolve_codex
        agent_recovery._resolve_codex = lambda: ["codex"]

    def tearDown(self):
        agent_recovery._resolve_codex = self._resolve

    def _formtools_args(self, form_tools):
        argv = agent_recovery._build_codex_argv(Path(tempfile.gettempdir()), None, form_tools)
        for item in argv:
            if item.startswith("mcp_servers.formtools.args="):
                return item
        return ""

    def test_repair_form_tools_get_the_same_upload_rule(self):
        base = {"tab_marker": "[FIX!]", "tab_id": "t1", "cdp_url": "http://127.0.0.1:9222", "pkg_root": "x"}
        self.assertNotIn("--upload-resume", self._formtools_args(dict(base)))
        args = self._formtools_args({**base, "upload_resume": "C:/r.pdf", "upload_root": "C:/job"})
        self.assertIn("--upload-resume", args)
        self.assertIn("--upload-root", args)


if __name__ == "__main__":
    unittest.main()
