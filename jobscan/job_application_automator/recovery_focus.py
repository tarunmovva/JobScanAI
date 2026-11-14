#!/usr/bin/env python3
"""What the AI recovery agent is shown, and what it cost.

Three concerns that used to live inside ``agent_recovery.py`` as a prompt literal
plus a whole-form context dump:

* **Skill loading** — the recovery procedure lives in ``skills/recovery-triage/*.md``
  so it can be reviewed and versioned as a skill, and is injected into the prompt
  from here.
* **The focus dossier** — the filler was driving the page when it broke and knows
  exactly which controls failed. Handing the agent that list with live DOM evidence
  is what lets it repair a named selector instead of paying 4-10k tokens for a
  full-page snapshot it does not need.
* **Agent metrics** — token/tool accounting parsed off the codex ``--json`` event
  stream, so a change to any of the above is attributable afterwards.
"""

from __future__ import annotations

import ast
import json
import re
import time
from pathlib import Path
from typing import Any

# ── Skill loading ────────────────────────────────────────────────────────────
#
# INJECTED, not discovered. `codex exec --ephemeral` gives no guarantee the agent
# chooses to invoke a skill it discovered (a skipped skill is a silent regression),
# `-C` points at the per-job output dir rather than a project root holding
# .codex/skills/, and a packaged app cannot assume $CODEX_HOME/skills exists.

SKILL_DIR = Path(__file__).resolve().parent / "skills" / "recovery-triage"

_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def load_skill(filename: str, fallback: str) -> tuple[str, str]:
    """Return ``(prompt_text, skill_rev)``.

    A missing skill file (trimmed package, bad build) falls back to the caller's
    in-code literal and reports rev ``"fallback"`` — never a silent behaviour
    change, and the rev lands in the persisted recovery block.
    """
    try:
        raw = (SKILL_DIR / filename).read_text(encoding="utf-8")
    except Exception:
        return fallback, "fallback"
    rev = ""
    match = _FRONTMATTER_RE.match(raw)
    if match:
        for line in match.group(1).splitlines():
            key, _, value = line.partition(":")
            if key.strip() == "rev":
                rev = value.strip().strip("\"'")
        raw = raw[match.end():]
    body = raw.strip()
    if not body:
        return fallback, "fallback"
    return body, rev or "unversioned"


# ── Focus dossier ────────────────────────────────────────────────────────────

MAX_FOCUS_CONTROLS = 8

# Page-level pseudo ids the fillers use for whole-form outcomes — not controls, so
# a failure carrying only these is genuinely blind. Enumerated explicitly rather
# than matched on a leading underscore: Ashby's real controls are ALL named
# _systemfield_* (_systemfield_location alone appears in dozens of recorded failures), and
# a prefix rule silently classified every Ashby failure as un-localisable.
PSEUDO_FIELD_IDS = frozenset({"_submission", "_verification", "_ai_diagnosis"})

# The greenhouse filler appends the REAL rendered menu to a dropdown error detail
# ("...; runtime_options=['Male', 'Female']"). Promoting it back to structured data
# is the single most useful thing in the dossier and costs nothing to recover.
_RUNTIME_OPTIONS_RE = re.compile(r"runtime_options=(\[.*?\])\s*(?:;|$)", re.DOTALL)

# When the filler reports no field-level failure, the PAGE still knows. A
# not_confirmed or submit_button_not_found failure carries only the pseudo id
# _submission, so every one of them went to the agent blind -- and blind runs
# succeed 20/26 where focused runs succeed 18/18. This asks the form which of
# its own controls are invalid or required-and-empty, which is what a person
# would look at first.
_PAGE_PROBLEM_JS = """() => {
  const out = [];
  const seen = new Set();
  const nodes = document.querySelectorAll(
    'input:not([type=hidden]), textarea, select, [role=combobox], [contenteditable=true]');
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || st.display === 'none') continue;
    const id = el.getAttribute('name') || el.id
      || (el.closest('[data-field-path]') || {}).getAttribute?.('data-field-path') || '';
    if (!id || seen.has(id)) continue;
    const ariaInvalid = el.getAttribute('aria-invalid') === 'true';
    const nativeInvalid = typeof el.checkValidity === 'function' && !el.checkValidity();
    const required = !!el.required || el.getAttribute('aria-required') === 'true';
    const value = (el.value || el.textContent || '').trim();
    // Invalidity ONLY. A required-and-empty test was tried and dropped:
    // measured against the captured corpus it fired 40 times to the invalid
    // signal's 5, and the extras were controls like country and phone that
    // React had populated -- .value simply does not read back the way this
    // probe sees it. Sending the agent to re-fill a correct field costs a
    // turn and risks overwriting a good answer, which is the exact failure
    // this whole effort exists to avoid. Natively required-and-empty
    // controls already fail checkValidity(), so nothing real is lost.
    if (!ariaInvalid && !nativeInvalid) continue;
    let msg = el.validationMessage || '';
    const describedBy = el.getAttribute('aria-describedby');
    if (!msg && describedBy) {
      const d = document.getElementById(describedBy);
      if (d) msg = (d.innerText || '').trim();
    }
    seen.add(id);
    out.push({
      id,
      required,
      invalid: ariaInvalid || nativeInvalid,
      empty: !value,
      message: String(msg).slice(0, 160),
    });
    if (out.length >= 8) break;
  }
  return out;
}"""


async def page_problem_specs(page: Any) -> list[dict[str, Any]]:
    """Controls the live page itself reports as invalid or required-and-empty.

    Used only when the filler recorded nothing field-level. Never raises: a
    failed probe returns [] and the dossier degrades to blind, which is the
    pre-existing behaviour.
    """
    try:
        found = await page.evaluate(_PAGE_PROBLEM_JS)
    except Exception:
        return []
    specs: list[dict[str, Any]] = []
    for item in found or []:
        if not isinstance(item, dict):
            continue
        fid = str(item.get("id") or "").strip()
        if not fid or fid in PSEUDO_FIELD_IDS:
            continue
        # Only invalid controls reach here; see the note in _PAGE_PROBLEM_JS.
        if not item.get("invalid"):
            continue
        why = item.get("message") or "the page marks this control invalid"
        # Same shape as broken_control_specs. Emitting a narrower dict here
        # raised KeyError: 'runtime_options' in the consumer and killed the
        # whole recovery -- on exactly the blind runs this was meant to help.
        specs.append({
            "id": fid,
            "label": "",
            "type": str(item.get("type") or ""),
            "why": str(why),
            "observed_actual": item.get("value"),
            "expected_hint": None,
            "required": bool(item.get("required")),
            "runtime_options": [],
            "from_page_scan": True,
        })
    return specs


_CONTROL_EVIDENCE_JS = """(selector) => {
    let el = null;
    try { el = document.querySelector(selector); } catch (e) { return {found: false, bad_selector: true}; }
    if (!el) return {found: false};
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const container = el.closest('[class*="field"], [class*="form"], fieldset, label') || el.parentElement || el;
    const errNode = container.querySelector('[class*="error"], [role="alert"], [aria-live="assertive"], [class*="invalid"]');
    const menu = Array.from(document.querySelectorAll('[role="option"], .select__option'))
        .map((o) => (o.innerText || o.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean);
    return {
        found: true,
        value: ('value' in el) ? String(el.value == null ? '' : el.value) : '',
        visible: rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
        disabled: Boolean(el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true'
                          || el.closest('fieldset[disabled], [class*="--is-disabled"]')),
        validation_text: errNode ? (errNode.innerText || errNode.textContent || '').trim().slice(0, 200) : '',
        control_html: (container.outerHTML || '').slice(0, 2000),
        open_menu_options: menu.slice(0, 40),
    };
}"""


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def runtime_options_from_detail(detail: Any) -> list[str]:
    match = _RUNTIME_OPTIONS_RE.search(str(detail or ""))
    if not match:
        return []
    try:
        value = ast.literal_eval(match.group(1))
    except Exception:
        return []
    return [str(v) for v in value][:40] if isinstance(value, list) else []


# A skipped entry whose reason is one of these means the filler had no value to
# type, not that the control was missing or deliberately withheld. On a REQUIRED
# control that is precisely what blocks submission.
_EMPTY_ANSWER_SKIP_REASONS = ("empty value", "empty answer", "no answer", "blank answer")


def broken_control_specs(
    failure: dict[str, Any], fields: list[dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    """Ordered, de-duplicated list of what the filler says is wrong.

    Required-unfilled first (a required empty control blocks submission outright),
    then verification failures, then remaining errors, then controls the filler saw
    on the page but had no answer for. Only PSEUDO_FIELD_IDS are dropped.

    ``fields`` is the payload's field list. It is what lets a *skipped* control be
    judged: skip entries carry only an id and a reason, so without the field
    definitions there is no way to tell "left a required question blank" from
    "correctly left an optional question alone".
    """
    specs: list[dict[str, Any]] = []
    seen: dict[str, dict[str, Any]] = {}

    def add(entry: Any, why: str, *, required: bool) -> None:
        if not isinstance(entry, dict):
            return
        fid = str(entry.get("id") or "").strip()
        if not fid or fid in PSEUDO_FIELD_IDS:
            return
        verification = entry.get("verification") if isinstance(entry.get("verification"), dict) else {}
        if fid in seen:
            # Same control reported by two lists — greenhouse records a control in
            # verification_failed AND errors[], and only the errors[] entry carries
            # the live menu. Merge rather than drop, or runtime_options is lost.
            prior = seen[fid]
            options = runtime_options_from_detail(entry.get("error"))
            if options and not prior["runtime_options"]:
                prior["runtime_options"] = options
            detail = str(entry.get("error") or "")
            # The form's own validation message ("Please enter a URL.") is the most
            # informative thing available and is often the SHORTEST, so length alone
            # is the wrong tie-break — once we have one, keep it.
            if not prior.get("why_authoritative") and len(detail) > len(prior["why"]):
                prior["why"] = detail
            for key, value in (("observed_actual", verification.get("actual", entry.get("actual"))),
                               ("expected_hint", verification.get("expected", entry.get("expected")))):
                if prior.get(key) in (None, "") and value not in (None, ""):
                    prior[key] = value
            prior["required"] = prior["required"] or required
            return
        spec = {
            "id": fid,
            "label": entry.get("label") or verification.get("label") or "",
            "type": entry.get("type") or verification.get("type") or "",
            "why": str(entry.get("error") or why),
            "observed_actual": verification.get("actual", entry.get("actual")),
            "expected_hint": verification.get("expected", entry.get("expected")),
            "required": bool(entry.get("required") or verification.get("required") or required),
            "runtime_options": runtime_options_from_detail(entry.get("error")),
        }
        seen[fid] = spec
        specs.append(spec)

    for entry in failure.get("required_unfilled") or []:
        add(entry, "required field left empty", required=True)
    for entry in failure.get("verification_failed") or []:
        add(entry, "post-fill verification failed", required=False)
    # Lever and Ashby report per-control results under verification.checks instead
    # of a verification_failed list, and their errors[] carries only _submission.
    # Without this, every Lever failure looked un-localisable (none of the recorded ones).
    verification = failure.get("verification")
    if isinstance(verification, dict):
        for entry in verification.get("checks") or []:
            if isinstance(entry, dict) and entry.get("pass") is False:
                add(entry, "post-fill verification failed", required=False)
    # Lever's own DOM validation names the rejected controls under `name`, with the
    # browser's validationMessage — a different shape from the error dicts above.
    for entry in failure.get("invalid_controls") or []:
        if not isinstance(entry, dict):
            continue
        add({
            "id": entry.get("name"),
            "label": entry.get("label"),
            "type": entry.get("type"),
            "error": entry.get("message") or "rejected by the form's own validation",
            "actual": entry.get("value"),
        }, "rejected by the form's own validation", required=True)
        spec = seen.get(str(entry.get("name") or "").strip())
        if spec is not None and entry.get("message"):
            spec["why_authoritative"] = True
    for entry in failure.get("errors") or []:
        add(entry, "fill error", required=False)
    for entry in failure.get("unanswered_visible_controls") or []:
        add(entry, "visible control with no answer", required=False)
    # A REQUIRED control the filler skipped for want of a value is the single most
    # actionable thing it knows, and it was not being forwarded at all. One Ashby
    # job skipped three required questions as "empty value",
    # reported errors: [] with every verification check passing, and so handed the
    # agent an empty dossier -- which then explored the page from scratch and
    # inferred the answers itself.
    field_index = {
        str(f.get("id")): f for f in (fields or []) if isinstance(f, dict) and f.get("id")
    }
    for entry in failure.get("skipped") or []:
        if not isinstance(entry, dict):
            continue
        reason = str(entry.get("reason") or "").lower()
        if not any(marker in reason for marker in _EMPTY_ANSWER_SKIP_REASONS):
            continue
        definition = field_index.get(str(entry.get("id") or "")) or {}
        # Optional questions are SUPPOSED to be skipped. Only a required one is
        # evidence of a problem, so without a field definition proving that,
        # stay quiet rather than send the agent after a non-issue.
        if not definition.get("required"):
            continue
        add({
            "id": entry.get("id"),
            "label": definition.get("label"),
            "type": definition.get("type"),
            "error": "required question left blank — the filler had no answer for it",
            "options": definition.get("options"),
        }, "required question left blank", required=True)
    return specs[:MAX_FOCUS_CONTROLS]


async def _control_evidence(page: Any, selector: str) -> dict[str, Any]:
    """Live DOM evidence for one selector, searching the page and every frame —
    greenhouse embeds its form in an iframe on some boards."""
    if not selector:
        return {}
    contexts: list[Any] = [page]
    try:
        main = page.main_frame
        contexts.extend([f for f in page.frames if f is not main])
    except Exception:
        pass
    for ctx in contexts:
        try:
            data = await ctx.evaluate(_CONTROL_EVIDENCE_JS, selector)
        except Exception:
            continue
        if isinstance(data, dict) and data.get("found"):
            return data
    return {}


async def build_focus(
    page: Any, payload: dict[str, Any], failure: dict[str, Any]
) -> dict[str, Any]:
    """Build the dossier written to ``recovery_focus.json``.

    ``focus_mode: "blind"`` means the filler recorded no field-level failure (the
    submit-not-confirmed class) — the skill keeps the old explore-first path for
    those. Never raises: a dossier that cannot be built degrades to blind mode.
    """
    try:
        specs = broken_control_specs(failure, payload.get("fields"))
    except Exception:
        specs = []
    # The filler knew nothing field-level, but the form may still be showing
    # its own errors. Asking it turns a blind run into a focused one.
    scanned = False
    if not specs:
        specs = await page_problem_specs(page)
        scanned = bool(specs)
    if not specs:
        return {
            "focus_mode": "blind",
            "captured_at": now_iso(),
            "controls": [],
            "note": "filler recorded no field-level failure — assess the page yourself",
        }

    fields_by_id = {
        str(f.get("id")): f for f in (payload.get("fields") or []) if isinstance(f, dict)
    }
    answers = payload.get("answers") or {}
    controls: list[dict[str, Any]] = []
    for spec in specs:
        field = fields_by_id.get(spec["id"]) or {}
        selector = str(field.get("selector") or "").strip()
        try:
            evidence = await _control_evidence(page, selector)
        except Exception:
            evidence = {}
        expected = answers.get(spec["id"])
        if expected in (None, "") and spec.get("expected_hint") not in (None, ""):
            expected = spec["expected_hint"]
        # .get, not [] -- a spec from any producer must not be able to kill
        # the run by omitting a key.
        runtime = spec.get("runtime_options") or evidence.get("open_menu_options") or []
        control: dict[str, Any] = {
            "id": spec["id"],
            "label": spec["label"] or field.get("label") or "",
            "type": spec["type"] or field.get("type") or "",
            "required": bool(spec["required"] or field.get("required")),
            "selector": selector,
            "expected": expected,
            "observed_actual": spec["observed_actual"]
            if spec["observed_actual"] is not None
            else evidence.get("value"),
            "why": spec["why"][:300],
        }
        if evidence.get("found"):
            control["live"] = {
                "visible": evidence.get("visible"),
                "disabled": evidence.get("disabled"),
                "validation_text": evidence.get("validation_text") or "",
                "control_html": evidence.get("control_html") or "",
            }
        elif selector:
            control["live"] = {"found": False}
        if runtime:
            control["runtime_options"] = runtime
        controls.append(control)

    return {"focus_mode": "focused", "captured_at": now_iso(), "controls": controls,
            # Recorded so the two sources can be told apart when measuring.
            "source": "page_scan" if scanned else "filler"}


# ── Context assembly ─────────────────────────────────────────────────────────

# resume_text is 43% of the median prompt and irrelevant to a verification-only
# failure ("expected Yes, actual No"). It earns its place only when the agent
# has to answer something the payload never answered.
def resume_is_needed(failure: dict[str, Any]) -> bool:
    return bool(failure.get("required_unfilled") or failure.get("unanswered_visible_controls"))


def field_index(fields: list[Any], answers: dict[str, Any], focus_ids: set[str]) -> list[str]:
    """One line per field — enough for the agent to orient without shipping the
    whole form. The complete form goes to recovery_context_full.json on disk."""
    lines: list[str] = []
    for field in fields:
        if not isinstance(field, dict):
            continue
        fid = str(field.get("id") or "")
        answer = answers.get(fid)
        if fid in focus_ids:
            state = "FAILED"
        elif answer in (None, "") or (isinstance(answer, list) and not answer):
            state = "blank"
        else:
            state = "answered"
        lines.append(
            f"{fid} | {field.get('label') or ''} | {field.get('type') or ''} | "
            f"{'req' if field.get('required') else 'opt'} | {state}"
        )
    return lines


def build_context(
    *,
    platform: str,
    apply_url: str,
    page_url: str,
    page_title: str,
    marker: str,
    payload: dict[str, Any],
    failure: dict[str, Any],
    resume_text: str,
    focus: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return ``(context, full_context)``.

    ``context`` goes in the prompt and carries only what the agent needs to start:
    the failure, the focused controls' answers, and a one-line-per-field index.
    ``full_context`` is written beside it on disk — the skill tells the agent to
    read it when the dossier is not enough, so it costs nothing until used.
    """
    fields = payload.get("fields") or []
    answers = payload.get("answers") or {}
    focus_ids = {str(c.get("id")) for c in focus.get("controls") or []}
    blind = focus.get("focus_mode") != "focused"

    scoped_answers = (
        dict(answers) if blind else {k: v for k, v in answers.items() if k in focus_ids}
    )
    # File paths must survive scoping — the agent may need to re-upload a resume
    # whose field never appeared in the failure list.
    for key, value in answers.items():
        if isinstance(value, str) and value.lower().endswith((".pdf", ".doc", ".docx", ".txt")):
            scoped_answers.setdefault(key, value)

    context: dict[str, Any] = {
        "platform": platform,
        "apply_url": apply_url,
        "current_tab_url": page_url,
        "current_tab_title": page_title,
        "tab_marker": marker,
        "focus_mode": focus.get("focus_mode"),
        "failure": failure,
        "focus": focus,
        "answers": scoped_answers,
        "field_index": field_index(fields, answers, focus_ids),
        "candidate_profile": payload.get("candidate_profile", ""),
        "job_context": payload.get("job_context", {}),
        "full_context_file": "recovery_context_full.json",
        "resume_file": "recovery_resume.txt",
    }
    if resume_text and (blind or resume_is_needed(failure)):
        context["resume_text"] = resume_text

    # resume_text lives in its own file rather than inside the sidecar. A blind
    # agent reads the sidecar with a single `Get-Content -Raw`, and codex emits
    # that command's whole output as ONE --json event line — a 63KB sidecar blew
    # asyncio's stream limit and killed a live recovery. Splitting keeps any
    # single read smaller and lets the agent take only what it needs.
    full_context = {
        "fields": fields,
        "answers": answers,
        "candidate_profile": payload.get("candidate_profile", ""),
        "job_context": payload.get("job_context", {}),
        "resume_file": "recovery_resume.txt",
    }
    return context, full_context


def context_bytes(context: dict[str, Any]) -> dict[str, int]:
    out: dict[str, int] = {}
    for key, value in context.items():
        try:
            out[key] = len(json.dumps(value, ensure_ascii=False))
        except Exception:
            out[key] = 0
    out["_total"] = sum(v for k, v in out.items() if not k.startswith("_"))
    return out


# ── Agent metrics ────────────────────────────────────────────────────────────

_MUTATING_TOOLS = frozenset({
    "browser_click", "browser_type", "browser_select_option", "browser_fill_form",
    "browser_press_key", "browser_file_upload", "browser_run_code_unsafe",
})


class AgentMetrics:
    """Token and tool accounting scraped off the codex --json event stream.

    Without this, "which failure class did the change improve" is unanswerable —
    the trigger status is not persisted anywhere else, and 107 of 191 historical
    runs read status "?" because fill_result.status is overwritten to "pass" once
    a recovery confirms.
    """

    def __init__(self) -> None:
        self.started = time.monotonic()
        self.input_tokens = 0
        self.cached_input_tokens = 0
        self.output_tokens = 0
        self.reasoning_output_tokens = 0
        self.tool_calls = 0
        self.tool_errors = 0
        self.by_tool: dict[str, int] = {}
        self.first_tool_name: str | None = None
        self.time_to_first_tool_s: float | None = None
        self.time_to_first_mutation_s: float | None = None

    def observe(self, event: dict[str, Any]) -> None:
        etype = event.get("type")
        item = event.get("item") or {}
        if etype == "item.started" and item.get("type") == "mcp_tool_call":
            tool = str(item.get("tool") or "?")
            self.tool_calls += 1
            self.by_tool[tool] = self.by_tool.get(tool, 0) + 1
            elapsed = round(time.monotonic() - self.started, 1)
            if self.first_tool_name is None:
                self.first_tool_name = tool
                self.time_to_first_tool_s = elapsed
            if self.time_to_first_mutation_s is None and tool in _MUTATING_TOOLS:
                self.time_to_first_mutation_s = elapsed
        elif etype == "item.completed" and item.get("type") == "mcp_tool_call" and item.get("error"):
            self.tool_errors += 1
        elif etype == "turn.completed":
            usage = event.get("usage") or {}
            self.input_tokens += usage.get("input_tokens") or 0
            self.cached_input_tokens += usage.get("cached_input_tokens") or 0
            self.output_tokens += usage.get("output_tokens") or 0
            self.reasoning_output_tokens += usage.get("reasoning_output_tokens") or 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "usage": {
                "input_tokens": self.input_tokens,
                "cached_input_tokens": self.cached_input_tokens,
                "uncached_input_tokens": self.input_tokens - self.cached_input_tokens,
                "output_tokens": self.output_tokens,
                "reasoning_output_tokens": self.reasoning_output_tokens,
            },
            "tools": {
                "total": self.tool_calls,
                "errors": self.tool_errors,
                "snapshot": self.by_tool.get("browser_snapshot", 0),
                "run_code_unsafe": self.by_tool.get("browser_run_code_unsafe", 0),
                "first_tool_name": self.first_tool_name,
                "time_to_first_tool_s": self.time_to_first_tool_s,
                "time_to_first_mutation_s": self.time_to_first_mutation_s,
                "by_tool": dict(sorted(self.by_tool.items(), key=lambda kv: -kv[1])),
            },
        }
