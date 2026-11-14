#!/usr/bin/env python3
"""What each automated Chrome tab says it is doing.

Up to nine tabs are open at once -- six application agents and three
extractors -- and until now every one of them showed the site's own title and
favicon. Nine tabs reading "Job Application for ..." behind the same icon tell
the user nothing about which job is where. The tabs that LINGER are precisely
the failed ones the user is expected to finish by hand: close_policy closes a
successful tab and leaves a failed one open.

Each tab carries two independent things:

  identity  window.__jobscan_tab__ -- a token the recovery agent uses to find
            the one tab it owns among duplicates of the same job.
  stage     a short code, a colour, and the job's name, shown in the tab strip.

Identity deliberately does NOT live in document.title. It used to: recovery
stamped "[fix-PID-TS] " onto the title and form_tools_mcp matched it with
startswith(). That made the title load-bearing, so anything else writing a
title -- like this feature -- silently broke the agent's tab lookup. Measured:
a title enforcer wipes the marker within 700ms and every recovery then fails
with "no tab whose title starts with". The window token also survives
navigation, which an evaluate-set title does not.

Only <title> and the favicon <link> are touched. Nothing is appended to the
body: form_state returns body_text and regexes it for confirmation phrases, so
a visible "submitted" label would be read as a submission that never happened.
That was measured too -- it flipped form_state's verdict from '' to
'application submitted' on an unsubmitted form.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

# The token the enforcer puts on the window, and the key the stage is persisted
# under so it survives a navigation inside the same tab.
TAB_ID_PROP = "__jobscan_tab__"
STAGE_STORAGE_KEY = "__jobscan_stage__"

# Codes are four characters so the tab strip stays column-aligned. At nine tabs
# roughly fifteen characters are legible, so the code costs about seven and the
# rest goes to the job -- measured on a real strip, not guessed.
STAGES: dict[str, dict[str, str]] = {
    "extract": {"code": "EXTR", "color": "#6b7280", "meaning": "Reading the form"},
    "fill": {"code": "FILL", "color": "#ffb224", "meaning": "Answering and submitting"},
    "fix": {"code": "FIX!", "color": "#f97316", "meaning": "Repair agent is fixing a problem"},
    "needs": {"code": "YOU!", "color": "#ef4444", "meaning": "Needs you — finish in this tab"},
    "failed": {"code": "FAIL", "color": "#a1382f", "meaning": "Attempt failed — left open for you"},
    "done": {"code": "DONE", "color": "#22c55e", "meaning": "Submitted"},
}

DEFAULT_STAGE = "fill"

# Substrings that mean the tab is waiting on a person rather than on us.
_NEEDS_USER = ("captcha", "otp", "manual", "verify", "challenge")


def stage_for_status(status: str, *, needs_user: bool = False) -> str:
    """Map a filler submission status onto a tab stage.

    Anything that is not a clean submit leaves the tab open, so the stage has
    to say whether the user is expected to act on it or not.
    """
    s = (status or "").strip().lower()
    if s in ("submitted", "not_submitted"):
        return "done"
    if needs_user or any(k in s for k in _NEEDS_USER):
        return "needs"
    return "failed"


def new_tab_id() -> str:
    return uuid.uuid4().hex[:12]


def tab_text(company: str = "", title: str = "") -> str:
    """What to show after the code.

    Company first: it is the part the user recognises, and at roughly fifteen
    legible characters the role is usually cut off anyway.
    """
    company = " ".join(str(company or "").split())
    title = " ".join(str(title or "").split())
    if company and title:
        return f"{company} — {title}"
    return company or title or "job application"


def label(stage: str, text: str) -> str:
    """The exact string the tab title becomes."""
    code = STAGES.get(stage, STAGES[DEFAULT_STAGE])["code"]
    return f"[{code}] {' '.join(str(text or '').split())}".strip()


# Runs before the site's own scripts, so the title it sets is overwritten a
# moment later -- hence the interval that re-asserts it.
_ENFORCER_JS = r"""
  try {
    Object.defineProperty(window, spec.prop, {value: spec.id, configurable: true});
  } catch (e) {
    window[spec.prop] = spec.id;
  }

  var read = function () {
    try {
      var v = sessionStorage.getItem(spec.key);
      if (v && spec.stages[v]) return v;
    } catch (e) { /* storage is blocked on some origins */ }
    return spec.stage;
  };

  var wanted = function () {
    var st = spec.stages[read()] || spec.stages[spec.stage];
    return {title: '[' + st.code + '] ' + spec.text, color: st.color};
  };

  var applyTitle = function (w) {
    if (document.title !== w.title) document.title = w.title;
  };

  var applyIcon = function (w) {
    var cur = document.getElementById('__jobscan_icon__');
    if (cur && cur.getAttribute('data-color') === w.color) return;
    var c = document.createElement('canvas');
    c.width = c.height = 32;
    var x = c.getContext('2d');
    x.fillStyle = w.color;
    if (x.roundRect) { x.beginPath(); x.roundRect(2, 2, 28, 28, 7); x.fill(); }
    else { x.fillRect(2, 2, 28, 28); }
    var links = document.querySelectorAll("link[rel~='icon']");
    for (var i = 0; i < links.length; i++) links[i].remove();
    var link = document.createElement('link');
    link.id = '__jobscan_icon__';
    link.rel = 'icon';
    link.setAttribute('data-color', w.color);
    link.href = c.toDataURL('image/png');
    (document.head || document.documentElement).appendChild(link);
  };

  // Nothing is appended to the body on purpose: form_state regexes body text
  // for confirmation phrases, and a "submitted" label there reads as a real
  // submission.
  var go = function () {
    var w = wanted();
    applyTitle(w);
    applyIcon(w);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', go, {once: true});
  } else {
    go();
  }
  setInterval(go, 700);
"""


def init_script(tab_id: str, stage: str, text: str) -> str:
    """JS run at the start of every document in the tab.

    An init script re-runs after each navigation, which is the point: a
    one-shot evaluate is wiped by the next page load.

    The stage is read from sessionStorage so a change made mid-run survives a
    navigation; the value baked in here is only the starting point.
    """
    spec = {
        "id": tab_id,
        "stage": stage if stage in STAGES else DEFAULT_STAGE,
        "text": " ".join(str(text or "").split()),
        "stages": STAGES,
        "prop": TAB_ID_PROP,
        "key": STAGE_STORAGE_KEY,
    }
    return "(function (spec) {%s})(%s)" % (_ENFORCER_JS, json.dumps(spec))


def set_stage_script(stage: str, text: str | None = None) -> str:
    """JS that moves a live tab to another stage.

    Writes sessionStorage as well as nudging the title, so the change shows at
    once and is still correct after the next navigation.
    """
    stage = stage if stage in STAGES else DEFAULT_STAGE
    spec = {
        "stage": stage,
        "key": STAGE_STORAGE_KEY,
        "code": STAGES[stage]["code"],
        "text": " ".join(str(text).split()) if text else "",
    }
    return (
        "(function (p) {"
        " try { sessionStorage.setItem(p.key, p.stage); } catch (e) {}"
        " var icon = document.getElementById('__jobscan_icon__');"
        # Clear the colour stamp so the next tick repaints the favicon.
        " if (icon) icon.setAttribute('data-color', '');"
        # Swap the code in place when no new text is given, rather than waiting
        # for the next tick: a caller that changes stage and immediately reads
        # the title -- or a user watching the strip -- would otherwise see the
        # old stage for up to 700ms.
        " var rest = p.text;"
        " if (!rest) {"
        "   var m = /^\\[[^\\]]{1,8}\\]\\s*([\\s\\S]*)$/.exec(document.title || '');"
        "   rest = m ? m[1] : (document.title || '');"
        " }"
        " document.title = '[' + p.code + '] ' + rest;"
        " return true;"
        "})(%s)" % json.dumps(spec)
    )


async def apply_stage(page: Any, stage: str, text: str | None = None) -> bool:
    """Move an already-tagged tab to a new stage. Never raises."""
    try:
        await page.evaluate(set_stage_script(stage, text))
        return True
    except Exception:
        return False


async def read_tab_id(page: Any) -> str:
    """The tab's identity token, or "" when it carries none."""
    try:
        got = await page.evaluate(
            "function () { return window[%s] || ''; }" % json.dumps(TAB_ID_PROP)
        )
        return str(got or "")
    except Exception:
        return ""
