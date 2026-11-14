#!/usr/bin/env python3
"""A dropdown click that did not commit must not be reported as filled.

Live failure (a Greenhouse embed): "Are you currently eligible to
work in the country in which this job is posted?" -- a Yes/No react-select.
Under load the option click did not commit. The click path then confirmed it
with the loose read, which on an EMPTY react-select climbs to the container and
returns the question text; "currently eligible" implies yes, so it matched. The
filler logged the field as done and moved on; verification, which reads only
committed evidence, failed it after the fact, and a three-minute recovery run
followed. In isolation the same field fills first time -- only the false
confirmation made a transient miss permanent.

    python tests/test_dropdown_click_commit.py
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

QUESTION = "Are you currently eligible to work in the country in which this job is posted?"

# The shape Greenhouse renders: label and control inside .select__container,
# a "Select..." placeholder until an option commits. DROPS is how many option
# clicks are swallowed before one commits -- what a click landing on a menu
# that is still mounting looks like.
WIDGET = """<html><body>
<div class="select__container">
  <label for="q">%(question)s*</label>
  <div class="select__control">
    <div class="select__value-container"><div class="select__placeholder">Select...</div></div>
    <input id="q">
  </div>
  <div class="select__menu" style="display:none">
    <div role="option" class="select__option">Yes</div>
    <div role="option" class="select__option">No</div>
  </div>
</div>
<script>
  let drops = %(drops)d;
  const menu = document.querySelector('.select__menu');
  const vc = document.querySelector('.select__value-container');
  document.querySelector('.select__control').addEventListener('click', () => { menu.style.display = 'block'; });
  for (const opt of document.querySelectorAll('[role=option]')) {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = 'none';
      if (drops > 0) { drops--; return; }
      vc.innerHTML = '<div class="select__single-value">' + opt.textContent + '</div>';
    });
  }
</script></body></html>"""

FIELD = {"id": "q", "selector": "#q", "type": "dropdown", "label": QUESTION,
         "options": [{"text": "Yes", "value": "Yes"}, {"text": "No", "value": "No"}]}


def _fill(drops: int):
    async def run():
        async with async_playwright() as pw:
            br = await pw.chromium.launch()
            try:
                pg = await br.new_page()
                await pg.set_content(WIDGET % {"question": QUESTION, "drops": drops})
                filler = GreenhouseFastFormFiller({})
                ok, detail = await filler._fill_dropdown(pg, FIELD, "Yes")
                check = await filler._verify_one(pg, FIELD, "Yes")
                return ok, detail, check
            finally:
                await br.close()
    return asyncio.run(run())


@unittest.skipUnless(_HAVE_PW, "playwright not installed")
class DropdownClickCommitTests(unittest.TestCase):
    def test_a_click_that_commits_first_time_is_filled(self):
        ok, detail, check = _fill(drops=0)
        self.assertTrue(ok, detail)
        self.assertEqual(detail, "visible_option")
        self.assertTrue(check["pass"], check)

    def test_a_dropped_click_is_noticed_and_retried(self):
        # The live case. Previously: ok=True on the first, swallowed click.
        ok, detail, check = _fill(drops=1)
        self.assertTrue(ok, detail)
        self.assertEqual(detail, "visible_option_retry")
        self.assertTrue(check["pass"], check)

    def test_a_control_that_never_commits_is_a_failure_not_a_success(self):
        ok, detail, check = _fill(drops=99)
        self.assertFalse(ok, f"reported filled with nothing committed: {detail}")
        self.assertFalse(check["pass"])
        # The error names what the form holds, not the question text or
        # whatever is in the input box.
        self.assertIn("actual='<uncommitted>'", detail)
        self.assertNotIn("eligible", detail)


if __name__ == "__main__":
    unittest.main(verbosity=2)
