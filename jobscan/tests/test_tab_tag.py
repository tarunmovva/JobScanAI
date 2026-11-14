"""Labelling the automated Chrome tabs.

Nine tabs are open at once during a run and, untagged, every one shows the
site's own title behind the same favicon. The tabs that survive a run are
exactly the failed ones the user is expected to finish by hand, so what they
say about themselves is the whole point.

Two hazards are pinned here because both were measured on live pages, not
reasoned about:

  * a tag that enforces document.title wipes recovery's tab marker within
    700ms, and every recovery then fails with "no tab whose title starts with";
  * a tag drawn into the page body flips form_state's confirmation verdict from
    '' to 'application submitted' on a form that was never submitted.
"""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator import tab_tag  # noqa: E402
from job_application_automator.form_tools_mcp import _STATE_JS, FormTools  # noqa: E402
from job_application_automator.submission_signals import confirmation_text  # noqa: E402

try:
    from playwright.async_api import async_playwright
    _HAVE_PW = True
except ImportError:  # pragma: no cover
    _HAVE_PW = False

PAGE = """<html><head><title>Job Application for Engineer at Acme</title>
<link rel="icon" href="data:image/png;base64,iVBORw0KGgo="></head>
<body><h1>Apply</h1><p>Submit your application below.</p>
<form><input name="first_name" required></form></body></html>"""


# The page is served from a routed http:// URL rather than set_content or a
# data: URL, for two reasons that both bit during development:
#   * set_content writes into the existing document, so add_init_script does
#     not re-run and the tag never appears -- an artefact of the harness, not
#     of the code, which works on any real navigation;
#   * a data: URL has an opaque origin, so sessionStorage throws and the stage
#     cannot persist across a reload.
_ORIGIN = "http://jobscan.test/apply"


async def _with_page(html, fn, init=None):
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        pg = await br.new_page()
        await pg.route("**/*", lambda route: asyncio.ensure_future(
            route.fulfill(status=200, content_type="text/html", body=html)))
        if init:
            await pg.add_init_script(init)
        await pg.goto(_ORIGIN, wait_until="domcontentloaded")
        try:
            return await fn(pg)
        finally:
            await br.close()


class StageVocabularyTests(unittest.TestCase):
    def test_every_stage_has_a_code_colour_and_meaning(self):
        # The meanings are shown to the user in the app's legend; a stage
        # without one would appear as an unexplained colour in the tab strip.
        for name, spec in tab_tag.STAGES.items():
            self.assertTrue(spec["code"], name)
            self.assertRegex(spec["color"], r"^#[0-9a-f]{6}$", name)
            self.assertTrue(spec["meaning"], name)

    def test_codes_are_four_characters_and_unique(self):
        codes = [s["code"] for s in tab_tag.STAGES.values()]
        self.assertEqual(len(codes), len(set(codes)))
        for c in codes:
            self.assertEqual(len(c), 4, c)

    def test_a_clean_submit_is_done_and_everything_else_is_not(self):
        self.assertEqual(tab_tag.stage_for_status("submitted"), "done")
        self.assertEqual(tab_tag.stage_for_status("not_submitted"), "done")
        self.assertEqual(tab_tag.stage_for_status("validation_errors"), "failed")

    def test_a_failure_waiting_on_a_person_is_marked_as_such(self):
        # These are the tabs the user actually has to open. They must not look
        # the same as one that simply failed.
        for status in ("blocked_captcha", "otp_required", "captcha_required",
                       "otp_timeout", "manual_entry"):
            self.assertEqual(tab_tag.stage_for_status(status), "needs", status)

    def test_company_leads_the_label(self):
        # At ~15 legible characters the role is cut off anyway, so the part the
        # user recognises has to come first.
        text = tab_tag.tab_text("acme", "Senior Platform Engineer")
        self.assertTrue(text.startswith("acme"))
        self.assertIn("[FILL]", tab_tag.label("fill", text))

    def test_a_label_survives_missing_pieces(self):
        self.assertTrue(tab_tag.tab_text("", ""))
        self.assertTrue(tab_tag.label("nonsense-stage", "x"))


@unittest.skipUnless(_HAVE_PW, "playwright not installed")
class TagBehaviourTests(unittest.TestCase):
    def test_the_tag_is_applied_and_carries_the_identity(self):
        init = tab_tag.init_script("tok123", "fill", "acme - Senior Engineer")

        async def go(pg):
            await pg.wait_for_timeout(900)
            return {
                "title": await pg.title(),
                "id": await tab_tag.read_tab_id(pg),
                "icon": await pg.evaluate(
                    "() => { const l = document.getElementById('__jobscan_icon__');"
                    " return l ? l.getAttribute('data-color') : ''; }"),
            }

        got = asyncio.run(_with_page(PAGE, go, init=init))
        self.assertTrue(got["title"].startswith("[FILL] acme"), got["title"])
        self.assertEqual(got["id"], "tok123")
        self.assertEqual(got["icon"], tab_tag.STAGES["fill"]["color"])

    def test_the_tag_reasserts_itself_after_the_page_renames_the_tab(self):
        # Every one of these sites sets its own title after load; a one-shot
        # tag is gone a moment later.
        init = tab_tag.init_script("tok123", "fill", "acme")

        async def go(pg):
            await pg.evaluate("() => { document.title = 'Something Else'; }")
            await pg.wait_for_timeout(1100)
            return await pg.title()

        self.assertTrue(asyncio.run(_with_page(PAGE, go, init=init)).startswith("[FILL]"))

    def test_a_stage_change_without_new_text_keeps_the_job_and_shows_at_once(self):
        # Recovery calls apply_stage(page, "fix") with no text. Waiting for the
        # next 700ms tick left the tab reading [FILL] while the repair agent was
        # already working, and any caller reading the title back saw the old
        # stage. The code is swapped in place instead.
        init = tab_tag.init_script("tok123", "fill", "acme — Senior Engineer")

        async def go(pg):
            await pg.wait_for_timeout(900)
            await tab_tag.apply_stage(pg, "fix")
            return await pg.title()

        title = asyncio.run(_with_page(PAGE, go, init=init))
        self.assertTrue(title.startswith("[FIX!]"), title)
        self.assertIn("acme", title, "the job must survive a stage change")

    def test_a_stage_change_shows_up_and_outlives_a_reload(self):
        init = tab_tag.init_script("tok123", "fill", "acme")

        async def go(pg):
            await tab_tag.apply_stage(pg, "needs", "acme")
            immediate = await pg.title()
            await pg.reload()
            await pg.wait_for_timeout(1100)
            return immediate, await pg.title()

        immediate, after = asyncio.run(_with_page(PAGE, go, init=init))
        self.assertTrue(immediate.startswith("[YOU!]"), immediate)
        # sessionStorage carries the stage across the new document; without it
        # the tab would revert to the stage it was opened with.
        self.assertTrue(after.startswith("[YOU!]"), after)

    def test_the_tag_never_reaches_the_page_body(self):
        # form_state regexes body text for confirmation phrases. A visible
        # "submitted" label there reports a submission that never happened --
        # measured: confirmation went from '' to 'application submitted'.
        init = tab_tag.init_script("tok123", "done", "acme")

        async def go(pg):
            await pg.wait_for_timeout(900)
            state = await pg.evaluate(_STATE_JS)
            decided = FormTools._decide(dict(state))
            return state.get("body_text", ""), decided["confirmation"]

        body, confirmation = asyncio.run(_with_page(PAGE, go, init=init))
        self.assertNotIn("DONE", body)
        self.assertNotIn("[FILL]", body)
        self.assertEqual(confirmation, "", "the tag must not read as a confirmation")

    def test_no_stage_code_can_be_read_as_a_confirmation(self):
        # Guards the vocabulary itself: a future stage called "Submitted" would
        # reintroduce the bug even with the body kept clean, via the title.
        for spec in tab_tag.STAGES.values():
            self.assertEqual(confirmation_text(spec["code"]), "", spec["code"])
            self.assertEqual(confirmation_text(spec["meaning"]), "", spec["meaning"])


@unittest.skipUnless(_HAVE_PW, "playwright not installed")
class RecoveryCoexistenceTests(unittest.TestCase):
    """The tag and recovery's tab lookup must not fight over the title.

    Identity used to be a prefix on document.title. With a tag enforcing its
    own title on an interval, the marker was gone within 700ms and
    form_tools_mcp raised "no tab whose title starts with" for the whole run.
    """

    def test_identity_survives_the_tag_enforcing_a_title(self):
        init = tab_tag.init_script("tok123", "fill", "acme")

        async def go(pg):
            await pg.wait_for_timeout(1100)
            # Whatever the title has become, identity is still readable.
            return await tab_tag.read_tab_id(pg), await pg.title()

        tab_id, title = asyncio.run(_with_page(PAGE, go, init=init))
        self.assertEqual(tab_id, "tok123")
        self.assertTrue(title.startswith("[FILL]"))

    def test_identity_survives_a_navigation(self):
        # An evaluate-set title does not survive a new document, which is how
        # the old marker could be lost mid-recovery. An init script does.
        init = tab_tag.init_script("tok123", "fill", "acme")

        async def go(pg):
            await pg.reload()
            await pg.wait_for_timeout(600)
            return await tab_tag.read_tab_id(pg)

        self.assertEqual(asyncio.run(_with_page(PAGE, go, init=init)), "tok123")

    def test_the_recovering_tab_is_distinguishable_from_stale_ones(self):
        # Earlier attempts leave their tabs open. Only the live one reads
        # [FIX!]; the others read [FAIL] or [YOU!], so a title prefix is enough
        # for the agent's browser-tool fallback to pick the right tab.
        live = tab_tag.label("fix", "acme")
        for stale in ("failed", "needs", "done"):
            self.assertFalse(tab_tag.label(stale, "acme").startswith(live[:6]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
