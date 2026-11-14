#!/usr/bin/env python3
"""The filler must not leave the form, and must notice when it has.

Live failure (a company's custom careers site): during the fill the page went from
the job to the site's /locations page. The option fallbacks click any visible
'[class*="option"]' node whose words fit the answer, and a "Birmingham" office link
fits "Birmingham, Alabama, United States". The filler then pressed
button[type=submit] on that page -- a job-search form -- and the result was
recorded as posting_closed. On six earlier runs of the same site, the same
kind of end state was recorded as a SUBMITTED application.

    python tests/test_fill_stays_on_form.py
"""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator.greenhouse_fast_form_filler import GreenhouseFastFormFiller  # noqa: E402

try:
    from playwright.async_api import async_playwright
    _HAVE_PW = True
except Exception:  # pragma: no cover
    _HAVE_PW = False

NAV_LINK = '<nav><a href="#locations" class="menu-option" onclick="location.hash=\'left\'">Birmingham</a></nav>'
REAL_OPTION = ('<div role="listbox"><div role="option" class="select__option" '
               'onclick="document.title=\'picked\'">Birmingham, Alabama, United States</div></div>')


def _run(html, fn):
    async def go():
        async with async_playwright() as pw:
            br = await pw.chromium.launch()
            try:
                pg = await br.new_page()
                await pg.set_content(f"<html><head><title>start</title></head><body>{html}</body></html>")
                return await fn(GreenhouseFastFormFiller({}), pg)
            finally:
                await br.close()
    return asyncio.run(go())


@unittest.skipUnless(_HAVE_PW, "playwright not installed")
class OptionClicksNeverFollowLinksTests(unittest.TestCase):
    def test_a_navigation_link_is_not_picked_as_a_typeahead_option(self):
        async def fn(filler, pg):
            picked = await filler._click_best_visible_option(pg, "Birmingham, Alabama, United States")
            return picked, await pg.evaluate("location.hash")
        picked, hash_ = _run(NAV_LINK, fn)
        self.assertEqual(picked, "")
        self.assertEqual(hash_, "", "the click followed a link off the form")

    def test_the_real_option_still_wins_beside_a_link(self):
        async def fn(filler, pg):
            picked = await filler._click_best_visible_option(pg, "Birmingham, Alabama, United States")
            return picked, await pg.title(), await pg.evaluate("location.hash")
        picked, title, hash_ = _run(NAV_LINK + REAL_OPTION, fn)
        self.assertEqual(picked, "Birmingham, Alabama, United States")
        self.assertEqual(title, "picked")
        self.assertEqual(hash_, "")

    def test_a_link_styled_as_an_option_is_not_clicked_for_yes(self):
        async def fn(filler, pg):
            clicked = await filler._click_visible_option(pg, "Yes")
            return clicked, await pg.evaluate("location.hash")
        clicked, hash_ = _run('<a href="#careers" class="option-link">Yes, show me jobs</a>', fn)
        self.assertFalse(clicked)
        self.assertEqual(hash_, "")


@unittest.skipUnless(_HAVE_PW, "playwright not installed")
class LeavingTheFormIsNoticedTests(unittest.TestCase):
    def test_the_same_document_is_intact(self):
        async def fn(filler, pg):
            await filler._stamp_form_document(pg)
            await pg.evaluate("history.pushState({}, '', '#step-2')")  # SPA URL change, same document
            return await filler._form_document_intact(pg)
        self.assertTrue(_run("<form><input name=a></form>", fn))

    def test_a_new_document_is_not(self):
        async def fn(filler, pg):
            await filler._stamp_form_document(pg)
            await pg.goto("data:text/html,<title>Search jobs</title><form><button type=submit>Search</button></form>")
            return await filler._form_document_intact(pg)
        self.assertFalse(_run("<form><input name=a></form>", fn))

    def test_an_unstamped_filler_does_not_block_submit(self):
        async def fn(filler, pg):
            return await filler._form_document_intact(pg)
        self.assertTrue(_run("<form></form>", fn))


if __name__ == "__main__":
    unittest.main(verbosity=2)
