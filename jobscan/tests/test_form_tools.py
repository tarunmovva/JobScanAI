"""The recovery agent's purpose-built form tools.

Measured over the recorded recovery runs, the agent drove the page with generic
primitives at 7.3s per tool call -- 5 calls on the fastest third, 23 on the
slowest -- and browser_snapshot alone was 51% of all tool output at ~1,120
tokens a call. These three tools do the same job in three calls, and
form_state is ~105 tokens.

The property that matters most is the last test: a value that did not commit
must come back ok=false. The filler learned that lesson the expensive way --
three Ashby comboboxes reported success on values verification later read as
empty -- and a tool that lies the same way would be worse than no tool.
"""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_application_automator.form_tools_mcp import FormTools  # noqa: E402

try:
    from playwright.async_api import async_playwright
    _HAVE_PW = True
except Exception:  # pragma: no cover
    _HAVE_PW = False

FORM = """<html><head><title>[fix-9-9] Test</title></head><body>
<form id="f">
  <input name="first_name" required>
  <input name="email" type="email" required>
  <select name="degree" required>
    <option value="">Select...</option><option>Bachelor's Degree</option><option>Master's Degree</option>
  </select>
  <input name="consent" type="checkbox" required>
  <button type="submit">Submit Application</button>
</form>
<script>
  const f=document.getElementById('f');
  f.addEventListener('submit',e=>{e.preventDefault();
    if(f.checkValidity()){document.body.innerHTML='<h1>Thank you for applying</h1>';}});
</script></body></html>"""

# A control that refuses every value: whatever is typed is wiped on input, the
# way a React widget drops a value it did not originate.
REJECTING = """<html><head><title>[fix-9-9] Test</title></head><body>
<form id="f"><input name="stubborn" required><button type="submit">Submit</button></form>
<script>
  const el=document.querySelector('[name=stubborn]');
  el.addEventListener('input',()=>{el.value='';});
</script></body></html>"""


async def _with_page(html, fn):
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        pg = await br.new_page()
        await pg.set_content(html)
        await pg.evaluate("document.getElementById('f').reportValidity()")
        tools = FormTools("http://127.0.0.1:0", "[fix-9-9]")
        tools._page = pg
        try:
            return await fn(tools, pg)
        finally:
            await br.close()


@unittest.skipUnless(_HAVE_PW, "playwright not installed")
class FormToolsTests(unittest.TestCase):
    def test_form_state_names_every_invalid_control_and_stays_small(self):
        async def go(tools, _pg):
            return await tools.form_state()
        st = asyncio.run(_with_page(FORM, go))
        self.assertEqual([p["id"] for p in st["problems"]],
                         ["first_name", "email", "degree", "consent"])
        self.assertEqual(st["submit_buttons"], ["Submit Application"])
        self.assertEqual(st["confirmation"], "")
        # A browser_snapshot of a real form measured 4,482 chars median.
        self.assertLess(len(json.dumps(st)), 1500)

    def test_fill_then_submit_is_three_calls(self):
        async def go(tools, _pg):
            filled = await tools.fill_fields([
                {"id": "first_name", "value": "Jane"},
                {"id": "email", "value": "a@b.com"},
                {"id": "degree", "value": "Bachelor's Degree"},
                {"id": "consent", "value": "yes"},
            ])
            after = await tools.form_state()
            submitted = await tools.submit_and_verify()
            return filled, after, submitted
        filled, after, submitted = asyncio.run(_with_page(FORM, go))
        self.assertTrue(all(r["ok"] for r in filled["results"]), filled)
        self.assertEqual(after["problems"], [], "nothing should still be invalid")
        self.assertTrue(submitted["clicked"])
        self.assertIn("Thank you for applying", submitted["state"]["confirmation"])

    def test_a_value_that_does_not_commit_is_reported_as_a_failure(self):
        # The whole point. Reporting ok=true here is how three Ashby comboboxes
        # came back "filled" while verification read them as empty.
        async def go(tools, _pg):
            return await tools.fill_fields([{"id": "stubborn", "value": "anything"}])
        res = asyncio.run(_with_page(REJECTING, go))["results"][0]
        self.assertFalse(res["ok"])
        self.assertEqual(res["value"], "")

    def test_a_missing_control_is_reported_not_silently_skipped(self):
        async def go(tools, _pg):
            return await tools.fill_fields([{"id": "does_not_exist", "value": "x"}])
        res = asyncio.run(_with_page(FORM, go))["results"][0]
        self.assertFalse(res["ok"])
        self.assertIn("not found", res["note"])

    def test_an_already_submitted_page_is_recognised_without_a_snapshot(self):
        done = "<html><head><title>[fix-9-9] T</title></head><body><h1>Thank you for applying</h1></body></html>"

        async def go(tools, _pg):
            return await tools.form_state()

        async def run():
            async with async_playwright() as pw:
                br = await pw.chromium.launch()
                pg = await br.new_page()
                await pg.set_content(done)
                tools = FormTools("http://127.0.0.1:0", "[fix-9-9]")
                tools._page = pg
                try:
                    return await tools.form_state()
                finally:
                    await br.close()
        st = asyncio.run(run())
        self.assertIn("Thank you for applying", st["confirmation"])
        self.assertEqual(st["problems"], [])


# A Greenhouse posting: an "Apply" button that only scrolls to the form, and the
# real submit further down. Taking the first match clicks the wrong one.
TWO_BUTTONS = """<html><head><title>[fix-9-9] T</title></head><body>
<button id="scroll">Apply</button>
<form id="f">
  <input name="first_name" required>
  <button type="submit">Submit application</button>
</form>
<script>
  document.getElementById('scroll').addEventListener('click',()=>{window.__scrolled=true;});
  const f=document.getElementById('f');
  f.addEventListener('submit',e=>{e.preventDefault();
    if(f.checkValidity()){document.body.innerHTML='<h1>Thank you for applying</h1>';}});
</script></body></html>"""


@unittest.skipUnless(_HAVE_PW, "playwright not installed")
class SubmitButtonTests(unittest.TestCase):
    """Which button counts as submit.

    A live run clicked "Apply" -- which only scrolls to the form -- reported the
    click, and the application was never sent. First-match was the bug; the
    buttons are now ranked.
    """

    def test_the_real_submit_wins_over_a_scroll_to_form_apply(self):
        async def go(tools, _pg):
            st = await tools.form_state()
            await tools.fill_fields([{"id": "first_name", "value": "Jane"}])
            sub = await tools.submit_and_verify()
            return st, sub
        st, sub = asyncio.run(_with_page(TWO_BUTTONS, go))
        self.assertEqual(st["submit_buttons"][0], "Submit application",
                         "the ranked list must not lead with a scroll-to-form Apply")
        self.assertEqual(sub["button"], "Submit application")
        self.assertIn("Thank you for applying", sub["state"]["confirmation"])

    def test_an_untouched_form_reports_what_is_still_blank(self):
        # Chrome already fails checkValidity() on a required-empty control, so
        # `problems` is populated here. required_empty answers the different
        # question -- "is this filled in?" -- which matters on a page whose form
        # has not been revealed yet, where there is nothing to be invalid at all.
        async def go(tools, _pg):
            return await tools.form_state()

        async def run():
            async with async_playwright() as pw:
                br = await pw.chromium.launch()
                pg = await br.new_page()
                await pg.set_content(TWO_BUTTONS)   # note: no reportValidity()
                tools = FormTools("http://127.0.0.1:0", "[fix-9-9]")
                tools._page = pg
                try:
                    return await tools.form_state()
                finally:
                    await br.close()
        st = asyncio.run(run())
        self.assertIn("first_name", st["required_empty"],
                      "the form is plainly not filled in")


@unittest.skipUnless(_HAVE_PW, "playwright not installed")
class NoAccidentalSubmitTests(unittest.TestCase):
    def test_filling_a_plain_text_input_does_not_submit_the_form(self):
        # fill_fields used to press Enter after typing when no dropdown option
        # matched. In a text input that submits: a one-field form reached
        # "Thank you for applying" mid-fill, which would send an application
        # before the remaining fields were filled.
        async def go(tools, _pg):
            await tools.fill_fields([{"id": "first_name", "value": "Jane"}])
            return await tools.form_state()
        st = asyncio.run(_with_page(TWO_BUTTONS, go))
        self.assertEqual(st["confirmation"], "",
                         "filling a field must never submit the application")


class ConfirmationRuleTests(unittest.TestCase):
    """One confirmation rule, shared with the fillers.

    form_state had its own regex. On a live Greenhouse submission the page
    became .../confirmation and read "Thank you for your interest in a career at
    Example Industrial Services" -- a real submission that the private regex
    did not match, so the run came back unconfirmed. Under-claiming is the safe
    direction, but it is also what invites a duplicate submit, and it cost the
    agent dozens of tool calls trying again.
    """

    def test_the_greenhouse_confirmation_that_was_missed(self):
        got = FormTools._decide({
            "url": "https://job-boards.greenhouse.io/x/jobs/1/confirmation",
            "body_text": "Thank you for your interest in a career at Example Industrial Services.",
        })
        self.assertTrue(got["confirmation"])

    def test_plain_confirmation_text_still_matches(self):
        got = FormTools._decide({"url": "https://x/jobs/1",
                                 "body_text": "Thank you for applying!"})
        self.assertIn("Thank you for applying", got["confirmation"])

    def test_a_live_form_is_never_read_as_a_receipt(self):
        # "Submit your application" is an instruction, not a confirmation.
        for body in ["Submit your application. First Name. Last Name.",
                     "Apply for this job", ""]:
            got = FormTools._decide({"url": "https://x/jobs/1", "body_text": body})
            self.assertEqual(got["confirmation"], "", body)

    def test_the_evidence_field_is_not_left_on_the_result(self):
        # body_text is up to 4KB and would be re-sent on every later turn.
        got = FormTools._decide({"url": "https://x", "body_text": "x" * 4000})
        self.assertNotIn("body_text", got)


# Greenhouse's react-select: the committed choice renders in a sibling node and
# input.value stays EMPTY. Structure copied from a real posting.
REACT_SELECT = """<html><head><title>[fix-9-9] T</title></head><body>
<form id="f">
  <div class="select__control">
    <div class="select__single-value">No</div>
    <input name="question_123" value="" aria-expanded="false">
  </div>
  <div class="select__control">
    <div class="select__single-value">Select...</div>
    <input name="question_456" value="" aria-expanded="false">
  </div>
</form></body></html>"""


@unittest.skipUnless(_HAVE_PW, "playwright not installed")
class ReactSelectReadbackTests(unittest.TestCase):
    """Reading back a control whose value is not in input.value.

    Measured on two live Greenhouse recoveries: fill_fields picked the right
    option every time ("picked option: No") and then reported ok:false, because
    the read-back only looked at input.value. The agent redid all seven fields
    with browser primitives -- 54 and 93 tool calls, against 3 and 4 on the
    platforms where the read-back worked.
    """

    def _read(self, html, fid):
        async def run():
            async with async_playwright() as pw:
                br = await pw.chromium.launch()
                pg = await br.new_page()
                await pg.set_content(html)
                tools = FormTools("http://127.0.0.1:0", "[fix-9-9]")
                tools._page = pg
                try:
                    return await tools._read_back(pg, fid)
                finally:
                    await br.close()
        return asyncio.run(run())

    def test_a_committed_react_select_reads_back_its_value(self):
        got = self._read(REACT_SELECT, "question_123")
        self.assertEqual(got["value"], "No")
        self.assertFalse(got["invalid"])

    def test_a_placeholder_is_not_mistaken_for_an_answer(self):
        # "Select..." is the empty state; calling it a value would report an
        # unfilled control as filled, which is the worse error.
        got = self._read(REACT_SELECT, "question_456")
        self.assertNotEqual(got["value"], "Select...")

    def test_a_missing_control_is_still_reported_missing(self):
        self.assertFalse(self._read(REACT_SELECT, "nope")["found"])


# Ashby names custom fields with UUIDs. "#50000000-..." is a CSS syntax error --
# an id selector cannot begin with a digit -- so a comma-joined selector
# containing one throws and takes every other branch down with it.
UUID_FIELD = """<html><head><title>[fix-9-9] T</title></head><body>
<form id="f">
  <input name="50000000-0000-4000-8000-000000000001" required>
  <div data-field-path="c0000000-0000-4000-8000-000000000002">
    <input required>
  </div>
</form></body></html>"""


@unittest.skipUnless(_HAVE_PW, "playwright not installed")
class UuidFieldTests(unittest.TestCase):
    def test_a_uuid_named_control_can_be_filled(self):
        # Most of the remaining fill failures in a small probe were this one
        # selector throwing, reported as "locator failed".
        async def go(tools, _pg):
            return await tools.fill_fields(
                [{"id": "50000000-0000-4000-8000-000000000001", "value": "Jane"}])
        res = asyncio.run(_with_page(UUID_FIELD, go))["results"][0]
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["value"], "Jane")

    def test_a_uuid_data_field_path_control_can_be_filled(self):
        async def go(tools, _pg):
            return await tools.fill_fields(
                [{"id": "c0000000-0000-4000-8000-000000000002", "value": "Job board"}])
        res = asyncio.run(_with_page(UUID_FIELD, go))["results"][0]
        self.assertTrue(res["ok"], res)


# Ashby hides the real checkbox and renders a label the user clicks. A
# zero-size input defeats both check() and scroll_into_view_if_needed().
HIDDEN_CHECKBOX = """<html><head><title>[fix-9-9] T</title></head><body>
<form id="f">
  <input type="checkbox" id="c1" name="40000000-0000-4000-8000-000000000003"
         style="position:absolute;opacity:0;width:0;height:0">
  <label for="c1">I agree</label>
</form></body></html>"""


@unittest.skipUnless(_HAVE_PW, "playwright not installed")
class HiddenCheckboxTests(unittest.TestCase):
    def test_a_visually_hidden_checkbox_is_checked_via_its_label(self):
        # Five of the seven remaining fill failures in a six-job probe were this,
        # each spending ~3s to time out before reporting failure.
        async def go(tools, _pg):
            return await tools.fill_fields(
                [{"id": "40000000-0000-4000-8000-000000000003", "value": "yes"}])

        async def run():
            async with async_playwright() as pw:
                br = await pw.chromium.launch()
                pg = await br.new_page()
                await pg.set_content(HIDDEN_CHECKBOX)
                tools = FormTools("http://127.0.0.1:0", "[fix-9-9]")
                tools._page = pg
                try:
                    return await go(tools, pg)
                finally:
                    await br.close()
        res = asyncio.run(run())["results"][0]
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["value"], "checked")


async def _with_embedded_form(html, fn):
    """A real layout: a careers page with its own controls (a
    newsletter box), and the application inside an iframe."""
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        pg = await br.new_page()
        await pg.set_content(
            "<html><head><title>[fix-9-9] Careers</title></head><body>"
            "<h1>Software Engineer</h1><input name=email placeholder='Newsletter: your email'>"
            "<iframe id=app style='width:900px;height:700px'></iframe></body></html>")
        await pg.evaluate("(h) => { document.getElementById('app').srcdoc = h; }", html)
        await pg.wait_for_function(
            "() => { const d = document.getElementById('app').contentDocument;"
            " return d && d.getElementById('f'); }")
        tools = FormTools("http://127.0.0.1:0", "[fix-9-9]")
        tools._page = pg
        try:
            return await fn(tools, pg)
        finally:
            await br.close()


@unittest.skipUnless(_HAVE_PW, "playwright not installed")
class EmbeddedFormTests(unittest.TestCase):
    """form_state used to read only the top document. On one careers site it
    reported problems: [], required_empty: [], submit_buttons: [] for a form
    with an empty required field, and fill_fields found no control at all."""

    def test_form_state_reads_the_form_inside_the_frame(self):
        async def go(tools, _pg):
            return await tools.form_state()
        st = asyncio.run(_with_embedded_form(FORM, go))
        self.assertEqual(set(st["required_empty"]), {"first_name", "email", "degree", "consent"})
        self.assertEqual(st["submit_buttons"], ["Submit Application"])
        self.assertTrue(st.get("form_frame_url"), "the agent should be told the form is framed")

    def test_fill_and_submit_work_inside_the_frame(self):
        async def go(tools, _pg):
            filled = await tools.fill_fields([
                {"id": "first_name", "value": "Jane"},
                {"id": "email", "value": "a@b.com"},
                {"id": "degree", "value": "Bachelor's Degree"},
                {"id": "consent", "value": "yes"},
            ])
            newsletter = await _pg.evaluate("document.querySelector('[name=email]').value")
            submitted = await tools.submit_and_verify()
            return filled, newsletter, submitted
        filled, newsletter, submitted = asyncio.run(_with_embedded_form(FORM, go))
        self.assertTrue(all(r["ok"] for r in filled["results"]), filled)
        # The careers page's own newsletter box is also named "email"; the
        # application's email is the one that must be filled.
        self.assertEqual(newsletter, "", "filled the page's newsletter box instead of the form")
        self.assertTrue(submitted["clicked"])
        # The confirmation renders inside the frame, in place of the form.
        self.assertIn("Thank you for applying", submitted["state"]["confirmation"])

    def test_a_plain_page_is_unchanged(self):
        async def go(tools, _pg):
            return await tools.form_state()
        st = asyncio.run(_with_page(FORM, go))
        self.assertNotIn("form_frame_url", st)


class _BlockingStdin:
    """stdin as codex drives it: a request, then a long silence while the agent
    thinks, then EOF."""

    def __init__(self, lines):
        import threading
        self._lines = list(lines)
        self.release = threading.Event()

    def readline(self):
        if self._lines:
            return self._lines.pop(0)
        self.release.wait(10)
        return ""


class EventLoopStaysLiveTests(unittest.TestCase):
    """The loop that owns the Playwright connection must keep running while the
    server waits for the next request.

    It used to run only during a tool call. Between calls nobody drained the
    Playwright driver, the driver stopped answering Chrome, and Chrome -- which
    holds every new tab until each attached client lets it start -- froze every
    other filler's new tab until the agent's next form_tools call. Seven
    navigation timeouts in one run, all while a recovery was up.
    """

    def test_the_loop_runs_while_waiting_for_the_next_request(self):
        from job_application_automator import form_tools_mcp

        init = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}) + "\n"
        stdin = _BlockingStdin([init])
        ticks = []

        async def run():
            async def ticker():
                while True:
                    ticks.append(1)
                    await asyncio.sleep(0.02)

            t = asyncio.create_task(ticker())
            server = asyncio.create_task(form_tools_mcp.serve(FormTools("http://127.0.0.1:0", ""), stdin))
            await asyncio.sleep(0.3)          # the agent is thinking; stdin is silent
            during = len(ticks)
            stdin.release.set()               # EOF
            await asyncio.wait_for(server, 5)
            t.cancel()
            return during

        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()):
            during = asyncio.run(run())
        self.assertGreater(during, 5, "the event loop stalled while waiting on stdin")


if __name__ == "__main__":
    unittest.main(verbosity=2)
