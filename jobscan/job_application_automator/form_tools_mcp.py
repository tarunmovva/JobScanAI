#!/usr/bin/env python3
"""Purpose-built form tools for the recovery agent.

Why this exists, in numbers. Across the recorded recovery runs the agent drove
the page with generic browser primitives, and the cost was linear in tool
calls: 7.3s per call, 5 calls on the fastest third (37s), 23 on the slowest
(162s). browser_snapshot alone accounted for 51% of all tool output, at ~1,100
tokens a call, re-sent on every subsequent turn.

The agent was re-deriving, through clicks and snapshots, things the filler
already knows how to do -- and doing them less well, because the filler's
committed-value check (the one that caught three Ashby comboboxes reporting
success on values that never landed) lived only in the filler.

So: three tools that each do one whole job.

    form_state        what is wrong, in ~200 tokens instead of a 1,100-token tree
    fill_fields       set values, commit-verified, the way the filler does
    submit_and_verify click submit and report what the page became

A repair that took explore -> click -> snapshot -> click -> snapshot becomes
three calls.

Spawned by agent_recovery as a second MCP server alongside playwright, which
stays available: this server deliberately does not cover navigation, tabs, or
anything unusual, and the agent should fall back for those.

Usage:
    python -m job_application_automator.form_tools_mcp \
        --cdp-url http://127.0.0.1:9222 --tab-marker "[fix-1234-5678]" \
        [--payload PATH]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any
from urllib.parse import urlparse

try:
    from job_application_automator.submission_signals import confirmation_text, confirmation_url
    from job_application_automator.tab_tag import TAB_ID_PROP
    from job_application_automator import upload_guard
except ImportError:  # spawned with the package root on sys.path
    from submission_signals import confirmation_text, confirmation_url
    from tab_tag import TAB_ID_PROP
    import upload_guard  # type: ignore

PROTOCOL_VERSION = "2024-11-05"

# Kept in step with recovery_focus._PAGE_PROBLEM_JS: invalidity only, never
# "required and empty". Measured on the captured corpus, required-and-empty
# fired 40 times to invalid's 5, and the extras were controls React had already
# filled -- .value does not read back the way a DOM probe sees it.
_STATE_JS = """() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const idOf = (el) => el.getAttribute('name') || el.id
    || (el.closest('[data-field-path]')?.getAttribute('data-field-path')) || '';

  const problems = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(
      'input:not([type=hidden]), textarea, select, [role=combobox], [contenteditable=true]')) {
    if (!vis(el)) continue;
    const id = idOf(el);
    if (!id || seen.has(id)) continue;
    const ariaInvalid = el.getAttribute('aria-invalid') === 'true';
    const nativeInvalid = typeof el.checkValidity === 'function' && !el.checkValidity();
    if (!ariaInvalid && !nativeInvalid) continue;
    let msg = el.validationMessage || '';
    const d = el.getAttribute('aria-describedby');
    if (!msg && d) msg = (document.getElementById(d)?.innerText || '').trim();
    seen.add(id);
    problems.push({
      id,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') || el.getAttribute('role') || '').toLowerCase(),
      value: String(el.value || '').slice(0, 60),
      why: String(msg).slice(0, 140),
    });
    if (problems.length >= 12) break;
  }

  // Required and still empty. Reported SEPARATELY from problems, never merged:
  // an untouched form has nothing marked invalid, and reporting "problems: []"
  // there told the agent it had nothing to do -- it went straight to submit on
  // a blank application. This answers "is the form filled in?", which is a
  // different question from "what did the page reject?".
  const emptyRequired = [];
  for (const el of document.querySelectorAll(
      'input:not([type=hidden]), textarea, select, [role=combobox]')) {
    if (!vis(el)) continue;
    const id = idOf(el);
    if (!id) continue;
    const req = !!el.required || el.getAttribute('aria-required') === 'true';
    if (!req) continue;
    if (el.type === 'checkbox' || el.type === 'radio') { if (!el.checked) emptyRequired.push(id); continue; }
    if (el.type === 'file') continue;   // reads empty even when a file is attached
    if (!String(el.value || '').trim()) emptyRequired.push(id);
    if (emptyRequired.length >= 20) break;
  }

  // Submit buttons, best first. "Apply" on a Greenhouse posting only scrolls to
  // the form; clicking it and calling that a submission is how a run reported
  // success on a blank page.
  const scoreBtn = (b) => {
    const t = (b.innerText || b.value || '').trim().toLowerCase();
    let s = 0;
    if (/^submit/.test(t) || /submit application/.test(t)) s += 100;
    else if (/^apply/.test(t)) s += 10;
    else if (/send/.test(t)) s += 50;
    if (b.type === 'submit') s += 40;
    if (b.closest('form')) s += 20;
    return s;
  };
  const submit = Array.from(document.querySelectorAll(
      'button[type=submit], input[type=submit], button'))
    .filter(vis)
    .filter(b => /submit|apply|send/i.test((b.innerText || b.value || '')))
    .map(b => ({ b, s: scoreBtn(b) }))
    .sort((x, y) => y.s - x.s)
    .map(o => (o.b.innerText || o.b.value || '').trim().slice(0, 40));

  const body = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
  const captcha = /hcaptcha|recaptcha|are you human|verify you are human/i.test(body)
    && !!document.querySelector('iframe[src*="captcha"], .h-captcha, .g-recaptcha');

  return {
    url: location.href,
    problems,
    required_empty: emptyRequired,
    submit_buttons: submit.slice(0, 3),
    // Confirmation is decided in Python by the same module the fillers use.
    // This JS reports evidence rather than a verdict: a private regex here
    // missed "Thank you for your interest in a career at ..." on a page whose
    // URL already ended in /confirmation, so a real submission came back
    // unconfirmed -- the direction that invites a duplicate submit.
    body_text: body.slice(0, 4000),
    captcha_visible: captcha,
    // A dead posting: worth one line rather than a snapshot to discover.
    page_text_head: body.slice(0, 180),
  };
}"""

# With an id: does this document hold that control (1/0)? Without: how many
# visible form controls does it have -- which frame is the form.
_CONTROLS_JS = """(id) => {
  if (id) {
    const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s;
    return (document.querySelector(`[name="${esc(id)}"]`) || document.getElementById(id)
      || document.querySelector(`[data-field-path="${esc(id)}"]`)) ? 1 : 0;
  }
  return Array.from(document.querySelectorAll(
      'input:not([type=hidden]), textarea, select, [role=combobox]'))
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .length;
}"""

# Reading a value back is the whole point. A click on an option is not a
# commitment: React can drop it, and an Ashby combobox that still has its menu
# open is holding a fragment, not an answer.
_READBACK_JS = """(id) => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s;
  const el = document.querySelector(`[name="${esc(id)}"]`)
    || document.getElementById(id)
    || document.querySelector(`[data-field-path="${esc(id)}"] input, [data-field-path="${esc(id)}"] textarea, [data-field-path="${esc(id)}"] select`);
  if (!el) return { found: false };

  // An open menu means a typed fragment, not a choice.
  if (el.getAttribute && String(el.getAttribute('aria-expanded')) === 'true') {
    return { found: true, value: '<uncommitted>', invalid: true };
  }
  if (el.type === 'checkbox' || el.type === 'radio') {
    return { found: true, value: el.checked ? 'checked' : '', invalid: false };
  }
  if (el.tagName && el.tagName.toLowerCase() === 'select') {
    const opt = el.selectedOptions && el.selectedOptions[0];
    return { found: true, value: clean(opt ? opt.textContent : ''), invalid: false };
  }

  // React-select (Greenhouse) keeps the committed choice in a sibling node and
  // leaves input.value EMPTY. Reading only input.value reported every such
  // control as unfilled -- fill_fields said "picked option: No" and then
  // ok:false, so the agent redid all seven fields with browser primitives at
  // 50-90 extra tool calls. Ported from the greenhouse filler, which had to
  // learn the same thing.
  const placeholder = (v) => {
    const k = clean(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return !k || k === 'select' || k.startsWith('select ') || k === 'choose' || k === 'choose one';
  };
  const roots = [
    el.closest('.select__control'),
    el.closest('[class*="select-shell"]'),
    el.closest('.select__container'),
    el.closest('.select'),
    el.closest('[role="group"]'),
    el.parentElement,
  ].filter(Boolean);
  for (const root of roots) {
    const single = root.querySelector(
      '.select__single-value, [class*="singleValue"], [class*="single-value"]');
    const text = clean(single && single.textContent);
    if (text && !placeholder(text)) return { found: true, value: text, invalid: false };
    const chips = Array.from(root.querySelectorAll(
      '.select__multi-value__label, [class*="multi-value__label"]'))
      .map((x) => clean(x.textContent)).filter((t) => t && !placeholder(t));
    if (chips.length) return { found: true, value: chips.join(', '), invalid: false };
  }

  return {
    found: true,
    value: clean(el.value || el.textContent).slice(0, 80),
    invalid: el.getAttribute('aria-invalid') === 'true'
      || (typeof el.checkValidity === 'function' && !el.checkValidity()),
  };
}"""

TOOLS = [
    {
        "name": "form_state",
        "description": (
            "The application form right now. `problems` is what the page has REJECTED, "
            "with its own message. `required_empty` is what is still BLANK -- an "
            "untouched form has no problems but plenty of empty required fields, so "
            "never read an empty `problems` as nothing to do. `submit_buttons` is "
            "best-first: on Greenhouse an 'Apply' button often only scrolls to the "
            "form. Also reports an existing confirmation and whether a CAPTCHA blocks. "
            "Call this FIRST instead of a snapshot, and again after filling."
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "fill_fields",
        "description": (
            "Set one or more form controls by id and verify each value actually stuck. "
            "Handles text, textarea, select, checkbox, radio and typeahead/combobox "
            "controls, and reads every value back — a clicked option that React dropped "
            "is reported as a failure, not a success. Prefer this over click/type: it is "
            "one call for the whole repair."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "fields": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "control name, id or data-field-path"},
                            "value": {"type": "string"},
                        },
                        "required": ["id", "value"],
                    },
                }
            },
            "required": ["fields"],
            "additionalProperties": False,
        },
    },
    {
        "name": "submit_and_verify",
        "description": (
            "Click the application's submit button and report what the page became: the "
            "confirmation text if one appeared, any controls still invalid, whether a "
            "CAPTCHA blocked it. Does NOT decide success on its own — read the result. "
            "On Greenhouse, acquire_otp_lock must succeed before calling this."
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]


class FormTools:
    """Holds the CDP connection and the one tab this recovery owns."""

    def __init__(self, cdp_url: str, tab_marker: str, tab_id: str = ""):
        self.cdp_url = cdp_url
        self.tab_marker = tab_marker
        self.tab_id = tab_id
        self._pw = None
        self._browser = None
        self._page = None

    async def page(self):
        if self._page is not None and not self._page.is_closed():
            return self._page
        from playwright.async_api import async_playwright

        if self._pw is None:
            self._pw = await async_playwright().start()
        if self._browser is None:
            self._browser = await self._pw.chromium.connect_over_cdp(self.cdp_url)

        # Several tabs can share an apply URL -- earlier failed attempts are
        # left open on purpose -- so the agent must not touch another job's tab.
        #
        # Identity is a window property, not the title. The title used to carry
        # it, which made every title writer a hazard: a tab label re-asserting
        # itself on an interval wiped the marker inside 700ms and this lookup
        # then failed for the whole run. A window property set from an init
        # script also survives navigation, which an evaluate-set title does not.
        pages = [pg for ctx in self._browser.contexts for pg in ctx.pages]

        if self.tab_id:
            for pg in pages:
                try:
                    got = await pg.evaluate(
                        "function () { return window[%s] || ''; }" % json.dumps(TAB_ID_PROP)
                    )
                except Exception:
                    continue
                if got and str(got) == self.tab_id:
                    self._page = pg
                    return pg

        # Fallback for a tab opened before the token existed.
        if self.tab_marker:
            for pg in pages:
                try:
                    title = await pg.title()
                except Exception:
                    continue
                if title.startswith(self.tab_marker):
                    self._page = pg
                    return pg

        raise RuntimeError(
            f"no tab matching id={self.tab_id!r} or title prefix {self.tab_marker!r}"
        )

    # The form is not always in the top document. One careers site embeds its
    # Greenhouse application in an iframe, and these tools read only the top
    # document: form_state reported "problems: [], required_empty: [],
    # submit_buttons: []" on a form with an empty required field -- nothing to
    # do -- and fill_fields could not find a single control. The agent fell
    # back to hand-written frame code and burned its three minutes. So every
    # operation goes to the frame that actually holds the form.

    async def _form_frame(self, fid: str = ""):
        """The frame holding control `fid`, or else the one with the most
        controls. The top document wins ties, so a plain page is unchanged.

        For an id, the form's own frame is asked first: a careers page can
        have its own newsletter box named "email", and filling that would
        leave the application's email empty."""
        pg = await self.page()
        if fid:
            form = await self._form_frame()
            for fr in [form, *(f for f in pg.frames if f is not form)]:
                try:
                    if await fr.evaluate(_CONTROLS_JS, fid):
                        return fr
                except Exception:
                    continue  # detached, or a frame that will not answer
            return form
        best, best_n = pg.main_frame, -1
        for fr in pg.frames:
            try:
                n = await fr.evaluate(_CONTROLS_JS, "")
            except Exception:
                continue
            if n > best_n:
                best, best_n = fr, n
        if not fid and best is not pg.main_frame:
            # Remembered, because after a submit the confirmation replaces the
            # form inside this same frame -- it then has no controls and would
            # never be chosen again.
            self._seen_form_frame = best
            self._form_host = urlparse(best.url).netloc
        return best

    async def _state(self) -> dict[str, Any]:
        """The form frame's state, with evidence from the rest of the tab: a
        CAPTCHA can sit in any frame, and the confirmation can render either in
        the top document or in place of the form inside its own frame."""
        pg = await self.page()
        form = await self._form_frame()
        form_host = getattr(self, "_form_host", "")
        seen_form = getattr(self, "_seen_form_frame", None)
        primary: dict[str, Any] | None = None
        captcha, confirmation = False, ""
        for fr in pg.frames:
            try:
                st = self._decide(await fr.evaluate(_STATE_JS))
            except Exception:
                continue
            captcha = captcha or bool(st.get("captcha_visible"))
            # Confirmation only from where it can honestly appear: the top
            # document, the form's frame, or a frame on the form's own site.
            # Not a chat widget or an ad that happens to say "thank you".
            if (fr is pg.main_frame or fr is form or fr is seen_form
                    or (form_host and urlparse(fr.url).netloc == form_host)):
                confirmation = confirmation or st.get("confirmation") or ""
            if fr is form:
                primary = st
        if primary is None:
            primary = self._decide(await pg.evaluate(_STATE_JS))
        primary["captcha_visible"] = captcha
        primary["confirmation"] = confirmation
        if form is not pg.main_frame:
            primary["form_frame_url"] = primary.get("url")
            primary["url"] = pg.url
        return primary

    async def form_state(self) -> dict[str, Any]:
        return await self._state()

    @staticmethod
    def _decide(state: dict) -> dict:
        """Apply the fillers' own confirmation rule to the page evidence."""
        body = state.pop("body_text", "") or ""
        state["confirmation"] = (
            confirmation_text(body) or confirmation_url(state.get("url") or "")
        )
        return state

    async def _read_back(self, pg, fid: str) -> dict[str, Any]:
        try:
            return await pg.evaluate(_READBACK_JS, fid)
        except Exception as exc:
            return {"found": False, "error": f"{type(exc).__name__}: {exc}"}

    async def fill_fields(self, fields: list[dict[str, Any]]) -> dict[str, Any]:
        results = []
        for item in fields or []:
            fid = str((item or {}).get("id") or "").strip()
            value = str((item or {}).get("value") or "")
            if not fid:
                continue
            fr = await self._form_frame(fid)
            note = await self._fill_one(fr, fid, value)
            back = await self._read_back(fr, fid)
            got = str(back.get("value") or "")
            ok = bool(back.get("found")) and got not in ("", "<uncommitted>") and not back.get("invalid")
            results.append({"id": fid, "ok": ok, "value": got, "note": note})
        return {"results": results}

    async def _fill_one(self, pg, fid: str, value: str) -> str:
        # [id="..."], never #id. An id selector cannot begin with a digit, and
        # Ashby's custom fields are UUIDs -- "#50000000-0000-..." is a CSS
        # syntax error, so the whole comma-joined selector threw and every such
        # control came back "locator failed". That was 21 of the 29 remaining
        # fill failures in a six-job probe. The attribute form has no such rule.
        esc = fid.replace("\\", "\\\\").replace('"', '\\"')
        loc = pg.locator(
            f'[name="{esc}"], [id="{esc}"], '
            f'[data-field-path="{esc}"] input, [data-field-path="{esc}"] textarea, '
            f'[data-field-path="{esc}"] select, [data-field-path="{esc}"] [role="combobox"]'
        ).first
        try:
            if not await loc.count():
                return "control not found"
        except Exception as exc:
            return f"locator failed: {type(exc).__name__}"

        tag = (await loc.evaluate("el => el.tagName.toLowerCase()")) or ""
        typ = (await loc.evaluate("el => (el.getAttribute('type') || '').toLowerCase()")) or ""

        try:
            if tag == "select":
                try:
                    await loc.select_option(label=value, timeout=5000)
                except Exception:
                    await loc.select_option(value=value, timeout=5000)
                return "selected"
            if typ in ("checkbox", "radio"):
                # check() waits for the control to be actionable and throws when
                # something overlays it -- a cookie banner, a sticky footer --
                # even though the box may already hold the right state. Read
                # first, and scroll into view before clicking, rather than
                # spending 5s to fail.
                if await loc.is_checked():
                    return "already checked"
                try:
                    await loc.check(timeout=4000)
                    return "checked"
                except Exception:
                    pass
                # Ashby hides the real input and renders a label the user
                # clicks. Both check() and scroll_into_view_if_needed() fail on
                # a zero-size element -- five of the seven remaining failures in
                # a six-job probe were that, each costing 3s to discover. Click
                # what a person would click, then confirm the box actually moved.
                clicked = await pg.evaluate(
                    """(id) => {
                        const el = document.querySelector(`[name="${id}"]`)
                          || document.getElementById(id);
                        if (!el) return false;
                        const lab = (el.id && document.querySelector(`label[for="${el.id}"]`))
                          || el.closest('label')
                          || el.parentElement?.querySelector('label');
                        (lab || el).click();
                        return true;
                    }""",
                    fid,
                )
                if clicked and await loc.is_checked():
                    return "checked via label"
                return "could not check"
            if typ == "file":
                refused = upload_guard.refusal(value)
                if refused:
                    return refused
                await loc.set_input_files(value, timeout=15000)
                return "file set"

            # Everything else is typed. A combobox needs its menu resolved, so
            # type, then take a matching option if one appears; committing is
            # what the read-back afterwards actually checks.
            await loc.click(timeout=5000)
            await loc.fill("", timeout=5000)
            await loc.press_sequentially(value, delay=40, timeout=15000)
            # Wait for the menu before looking for a match. Ashby's location
            # combobox fetches its options from a geocoding API, so reading the
            # menu immediately finds nothing, falls through to Enter, and leaves
            # aria-expanded true -- which the read-back correctly calls
            # <uncommitted>. The ashby filler learned to wait 2.5s here.
            try:
                await pg.wait_for_selector(
                    '[role="option"], [role="listbox"] [role="option"], [cmdk-item]',
                    timeout=2500,
                )
            except Exception:
                pass  # no menu: a plain text input, handled below
            picked = await pg.evaluate(
                """(expected) => {
                    const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                    const want = norm(expected);
                    const opts = Array.from(document.querySelectorAll(
                        '[role=option], [role=listbox] li, [cmdk-item]'))
                      .filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
                    if (!opts.length) return '';
                    let best = null;
                    for (const o of opts) {
                      const t = norm(o.textContent);
                      if (!t) continue;
                      if (t === want) { best = o; break; }
                      if (!best && (t.includes(want) || want.includes(t))) best = o;
                    }
                    if (!best) return '';
                    best.click();
                    return (best.textContent || '').trim().slice(0, 60);
                }""",
                value,
            )
            if picked:
                await pg.wait_for_timeout(300)
                return f"picked option: {picked}"
            # Enter is ONLY for a combobox waiting to commit a typed value. In a
            # plain text input it submits the form -- a test form with one field
            # went straight to "Thank you for applying" in the middle of
            # fill_fields, which would send an application before the rest of it
            # was filled in.
            is_combo = await loc.evaluate(
                "el => el.getAttribute('role') === 'combobox'"
                " || el.getAttribute('aria-autocomplete') != null"
                " || el.getAttribute('aria-expanded') != null"
                " || !!el.closest('[data-field-path]')"
            )
            if is_combo:
                await loc.press("Enter", timeout=5000)
                return "typed, committed with Enter"
            return "typed"
        except Exception as exc:
            return f"{type(exc).__name__}: {str(exc)[:80]}"

    async def submit_and_verify(self) -> dict[str, Any]:
        before = await self._state()
        pg = await self._form_frame()
        clicked = await pg.evaluate(
            """() => {
                const vis = el => { const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0; };
                // Ranked, not first-match. A Greenhouse posting shows an "Apply"
                // button that only scrolls to the form; taking it and reporting
                // a click is how a blank application looked submitted.
                const score = (b) => {
                    const t = (b.innerText || b.value || '').trim().toLowerCase();
                    let s = 0;
                    if (/^submit\b/.test(t) || /submit application/.test(t)) s += 100;
                    else if (/^apply\b/.test(t)) s += 10;
                    else if (/send/.test(t)) s += 50;
                    if (b.type === 'submit') s += 40;
                    if (b.closest('form')) s += 20;
                    return s;
                };
                const cands = Array.from(document.querySelectorAll(
                    'button[type=submit], input[type=submit], button'))
                  .filter(vis)
                  .filter(b => /submit|apply|send/i.test(b.innerText || b.value || ''))
                  .map(b => ({ b, s: score(b) }))
                  .sort((x, y) => y.s - x.s);
                if (!cands.length) return '';
                cands[0].b.click();
                return (cands[0].b.innerText || cands[0].b.value || '').trim().slice(0, 40);
            }"""
        )
        if not clicked:
            return {"clicked": False, "reason": "no visible submit button", "state": before}
        # Settle before judging: a confirmation that has not rendered yet is not
        # a failure, and calling it one is how a submitted application gets
        # reported as broken.
        tab = await self.page()
        for _ in range(6):
            # On the tab, not the frame: a submit can replace or detach the
            # form's frame, and a wait on a detached frame throws.
            await tab.wait_for_timeout(1000)
            state = await self._state()
            if state.get("confirmation") or state.get("captcha_visible"):
                break
        return {"clicked": True, "button": clicked, "state": state}


def _reply(msg_id: Any, result: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": result}) + "\n")
    sys.stdout.flush()


def _text_reply(msg_id: Any, payload: Any, is_error: bool = False) -> None:
    body = {"content": [{"type": "text", "text": json.dumps(payload, default=str)}]}
    if is_error:
        body["isError"] = True
    _reply(msg_id, body)


async def _dispatch(tools: FormTools, name: str, args: dict[str, Any]) -> Any:
    if name == "form_state":
        return await tools.form_state()
    if name == "fill_fields":
        return await tools.fill_fields(args.get("fields") or [])
    if name == "submit_and_verify":
        return await tools.submit_and_verify()
    raise ValueError(f"unknown tool {name!r}")


async def serve(tools: FormTools, stdin: Any = None) -> None:
    """Answer MCP requests until stdin closes.

    The event loop must keep running between requests, not only during them.
    This server used to block in `for line in sys.stdin` and spin the loop up
    per tool call. Once the first call connects to Chrome, nobody reads the
    Playwright driver's event stream while the agent is thinking; the stream
    backs up and the driver stops answering Chrome. Chrome holds every newly
    created tab until each attached client lets it start, so from then on
    every new tab in the browser froze -- every other filler's page.goto timed
    out, and every new connect_over_cdp hung waiting for the frozen tabs. All of
    it released at once on the agent's next form_tools call. That was seven
    of the fourteen failures in one run, all starting while a recovery was up.

    So stdin is read on a worker thread and the loop stays live throughout.
    """
    stdin = stdin or sys.stdin
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, stdin.readline)
        if not line:
            return
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        method = msg.get("method")
        msg_id = msg.get("id")

        if method == "initialize":
            _reply(msg_id, {
                "protocolVersion": (msg.get("params") or {}).get("protocolVersion", PROTOCOL_VERSION),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "form-tools", "version": "1.0"},
            })
        elif method == "tools/list":
            _reply(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = msg.get("params") or {}
            try:
                out = await _dispatch(tools, params.get("name"), params.get("arguments") or {})
                _text_reply(msg_id, out)
            except Exception as exc:
                # Never kill the session: the agent still has the playwright
                # tools and can finish the application without this server.
                _text_reply(msg_id, {"error": f"{type(exc).__name__}: {exc}"}, is_error=True)
        elif msg_id is not None:
            _reply(msg_id, {})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cdp-url", default="http://127.0.0.1:9222")
    parser.add_argument("--tab-marker", default="")
    parser.add_argument("--tab-id", default="")
    parser.add_argument("--payload", default="")
    # Upload rule shared with the fillers (upload_guard). Absent: legacy runs.
    parser.add_argument("--upload-resume", default=None)
    parser.add_argument("--upload-root", default="")
    args = parser.parse_args()
    if args.upload_resume is not None:
        upload_guard.configure({"resume_path": args.upload_resume}, (args.upload_root,))

    asyncio.run(serve(FormTools(args.cdp_url, args.tab_marker, args.tab_id)))


if __name__ == "__main__":
    main()
