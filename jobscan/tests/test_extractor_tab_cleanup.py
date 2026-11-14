#!/usr/bin/env python3
"""An extractor that fails must still close its tab.

The ashby and lever extractors closed their tab only on the success path and
on a failed navigation. Any exception in between -- a screenshot, a selector, a
detached frame -- skipped cleanup, and the tab stayed open in the user's Chrome
for the rest of the session. Every leaked tab also makes each later
connect_over_cdp slower, since a new client attaches to every open tab. The
greenhouse extractor already closed in a finally.

    python tests/test_extractor_tab_cleanup.py
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator import ashby_form_extractor, lever_form_extractor  # noqa: E402


class _Page:
    async def goto(self, *a, **k): return None
    async def wait_for_timeout(self, *a, **k): return None
    async def wait_for_selector(self, *a, **k): return None
    async def text_content(self, *a, **k): return "Title"
    async def title(self): return "Title"
    async def screenshot(self, *a, **k): return None
    async def content(self): return "<html></html>"


class _Session:
    def __init__(self):
        self.page = _Page()
        self.closed = False

    async def cleanup(self):
        self.closed = True


class _PW:
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False


def _run_failing(module):
    session = _Session()

    async def fake_open(*a, **k):
        return session

    async def boom(page):
        raise RuntimeError("frame detached mid-extract")

    saved = (module.open_cdp_page, module.async_playwright, module._extract_fields)
    module.open_cdp_page, module.async_playwright, module._extract_fields = fake_open, (lambda: _PW()), boom
    try:
        with tempfile.TemporaryDirectory() as d:
            with _raises(RuntimeError):
                asyncio.run(module.extract("https://example.com/apply", Path(d)))
    finally:
        module.open_cdp_page, module.async_playwright, module._extract_fields = saved
    return session


class _raises:
    def __init__(self, exc): self.exc = exc
    def __enter__(self): return self
    def __exit__(self, et, ev, tb):
        if et is None:
            raise AssertionError("expected the extraction error to propagate")
        return issubclass(et, self.exc)


class ExtractorTabCleanupTests(unittest.TestCase):
    def test_ashby_closes_its_tab_when_extraction_throws(self):
        self.assertTrue(_run_failing(ashby_form_extractor).closed)

    def test_lever_closes_its_tab_when_extraction_throws(self):
        self.assertTrue(_run_failing(lever_form_extractor).closed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
