#!/usr/bin/env python3
"""Lever job application form extractor.

Navigates to a Lever apply URL (jobs.lever.co/{slug}/{id}/apply),
extracts all form fields, and writes a JSON payload file.

Usage:
    python lever_form_extractor.py <apply_url> [output_dir]
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright

try:
    from job_application_automator.browser_cdp import open_cdp_page
    from job_application_automator import tab_tag
except ImportError:
    from browser_cdp import open_cdp_page
    import tab_tag  # type: ignore


HELP_TEXT = """Lever form extractor

Usage:
  python -m job_application_automator.lever_form_extractor <apply_url> [output_dir]

Arguments:
  apply_url   Lever application URL, usually https://jobs.lever.co/<company>/<job_id>/apply
  output_dir  Optional directory for extracted_fields.json, fill_payload.json, screenshots, and HTML artifacts.

Output:
  Writes extracted_fields.json and an editable fill_payload.json for lever_form_filler.py.
"""


FORM_WAIT = "#application-form"
NAV_TIMEOUT = 25_000
RENDER_WAIT = 3_000
PROFILE_PATH = Path(__file__).resolve().parents[1] / "test_data" / "profile_resume.json"


def _parse_lever_url(url: str) -> tuple[str, str]:
    """Return (company_slug, job_id) from a Lever apply URL."""
    parts = urlparse(url).path.strip("/").split("/")
    # jobs.lever.co/{slug}/{job_id}/apply
    if len(parts) >= 2:
        return parts[0], parts[1]
    return parts[0] if parts else "", ""


async def extract(apply_url: str, output_dir: Path) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    slug, job_id = _parse_lever_url(apply_url)

    result = {
        "platform": "lever",
        "apply_url": apply_url,
        "company_slug": slug,
        "job_id": job_id,
        "job_title": "",
        "extracted_at": datetime.now().isoformat(timespec="seconds"),
        "fields": [],
        "errors": [],
    }

    async with async_playwright() as pw:
        session = await open_cdp_page(
            pw, viewport={"width": 1366, "height": 900},
            tab_stage="extract",
            tab_text=tab_tag.tab_text(result.get("company_slug") or ""),
        )
        page = session.page
        try:
            try:
                await page.goto(apply_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
            except Exception as exc:
                result["errors"].append(f"navigate: {exc}")
                return result

            # Wait for form container
            try:
                await page.wait_for_selector(FORM_WAIT, timeout=10_000)
            except Exception:
                result["errors"].append("form not found after 10s")

            await page.wait_for_timeout(RENDER_WAIT)

            # Job title
            try:
                result["job_title"] = await page.text_content("h2.posting-headline") or ""
                if not result["job_title"]:
                    result["job_title"] = await page.title()
            except Exception:
                pass

            # Screenshot + HTML dump
            try:
                await page.screenshot(path=str(output_dir / "form.png"), full_page=True)
                (output_dir / "form.html").write_text(await page.content(), encoding="utf-8")
            except Exception:
                pass

            fields = await _extract_fields(page)
            result["fields"] = fields
        finally:
            # Any exception above used to skip this and leave the tab open
            # in the user's Chrome for the rest of the session.
            await session.cleanup()

    # Save
    out_file = output_dir / "extracted_fields.json"
    out_file.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Extracted {len(result['fields'])} fields -> {out_file}")
    return result


async def _extract_fields(page) -> list[dict]:
    """Extract all form fields from the rendered Lever form."""
    fields = []

    # Standard text/email/tel/url fields by name
    std_names = [
        ("name", "Full name", "text", True),
        ("email", "Email address", "email", True),
        ("phone", "Phone", "tel", False),
        ("org", "Current company", "text", False),
        ("location", "Location", "text", False),
    ]
    for name, label_fallback, ftype, req_fallback in std_names:
        sel = f'input[name="{name}"]'
        el = page.locator(sel).first
        if await el.count():
            label = await _lever_field_label(page, sel) or label_fallback
            required = await _is_required(el) or req_fallback
            fields.append({
                "id": name,
                "label": label,
                "type": ftype,
                "required": required,
                "selector": sel,
            })

    # URL fields
    url_keys = ["LinkedIn", "GitHub", "Portfolio", "Twitter", "Other"]
    for key in url_keys:
        sel = f'input[name="urls[{key}]"]'
        el = page.locator(sel).first
        if await el.count():
            label = await _lever_field_label(page, sel) or key
            fields.append({
                "id": f"urls[{key}]",
                "label": label,
                "type": "url",
                "required": await _is_required(el),
                "selector": sel,
            })

    # Resume file upload
    for sel in ['input[type="file"][name="resume"]', 'input[type="file"]']:
        el = page.locator(sel).first
        if await el.count():
            fields.append({
                "id": "resume",
                "label": "Resume / CV",
                "type": "file",
                "required": False,
                "selector": sel,
            })
            break

    # Cover letter textarea
    for name in ["comments", "cover_letter"]:
        sel = f'textarea[name="{name}"]'
        el = page.locator(sel).first
        if await el.count():
            label = await _lever_field_label(page, sel) or name.replace("_", " ").title()
            fields.append({
                "id": name,
                "label": label,
                "type": "textarea",
                "required": await _is_required(el),
                "selector": sel,
            })

    # EEO fields — may be <select> or radio inputs depending on job
    eeo_names = ["eeo[gender]", "eeo[race]", "eeo[veteran]", "eeo[disability]"]
    for name in eeo_names:
        sel = f'select[name="{name}"]'
        el = page.locator(sel).first
        if await el.count():
            label = await _lever_field_label(page, sel) or name
            options = await _select_options(page, sel)
            fields.append({
                "id": name,
                "label": label,
                "type": "select",
                "required": False,
                "options": options,
                "selector": sel,
            })
        else:
            # Check for radio group
            radio_sel = f'input[type="radio"][name="{name}"]'
            radio_el = page.locator(radio_sel).first
            if await radio_el.count():
                options = await page.evaluate(f"""
                () => {{
                    const opts = [];
                    document.querySelectorAll('input[type="radio"][name="{name}"]').forEach(r => {{
                        opts.push(r.value);
                    }});
                    return opts;
                }}
                """)
                label = await _lever_field_label(page, radio_sel) or name
                fields.append({
                    "id": name,
                    "label": label or name,
                    "type": "radio",
                    "required": False,
                    "options": options,
                    "selector": radio_sel,
                })

    # Card sections — parse from hidden baseTemplate inputs
    card_fields = await _extract_card_fields(page)
    fields.extend(card_fields)
    fields.extend(await _extract_unseen_form_controls(page, {f["id"] for f in fields}))

    return fields


async def _extract_unseen_form_controls(page, seen_ids: set[str]) -> list[dict]:
    """Extract visible named controls missed by standard/card scans."""
    raw = await page.evaluate(
        """
        (seen) => {
            const seenSet = new Set(seen);
            const form = document.querySelector('#application-form') || document.body;
            const visible = (el) => {
                const style = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && el.type !== 'hidden';
            };
            const labelFor = (el, groupEls = null) => {
                const labelEl = el.closest('label');
                if (labelEl) {
                    const cloned = labelEl.cloneNode(true);
                    cloned.querySelectorAll('input,select,textarea,button').forEach(n => n.remove());
                    const text = (cloned.textContent || '').replace(/\\s+/g, ' ').trim();
                    if (text) return text;
                }
                const container = el.closest('li.application-question, li.custom-question, div.application-question, div.application-field');
                if (container) {
                    const lbl = container.querySelector('.application-label .text, .application-label');
                    const text = (lbl?.textContent || '').replace(/\\s+/g, ' ').trim().replace(/[✱*]+$/, '').trim();
                    if (text) return text;
                    if (groupEls && groupEls.length === 1) {
                        const text2 = (container.textContent || '').replace(/\\s+/g, ' ').trim();
                        if (text2) return text2;
                    }
                }
                return el.getAttribute('aria-label') || el.name || el.id || '';
            };

            const ignored = new Set([
                'accountId', 'linkedInData', 'origin', 'referer', 'timezone',
                'socialReferralKey', 'socialSource', 'resumeStorageId',
                'selectedLocation', 'source', 'h-captcha-response',
            ]);
            const byName = {};
            form.querySelectorAll('input[name], textarea[name], select[name]').forEach(el => {
                const name = el.name || '';
                if (!name || seenSet.has(name) || ignored.has(name)) return;
                if (name.includes('[baseTemplate]')) return;
                if (el.type === 'hidden' || !visible(el)) return;
                if (!byName[name]) byName[name] = [];
                byName[name].push(el);
            });

            const selectorFor = (type, tag, name) => {
                const esc = CSS.escape(name);
                if (tag === 'TEXTAREA') return `textarea[name="${esc}"]`;
                if (tag === 'SELECT') return `select[name="${esc}"]`;
                if (type === 'checkbox') return `input[type="checkbox"][name="${esc}"]`;
                if (type === 'radio') return `input[type="radio"][name="${esc}"]`;
                return `input[name="${esc}"]`;
            };

            const out = [];
            for (const [name, els] of Object.entries(byName)) {
                const el = els[0];
                const tag = el.tagName;
                const type = tag === 'TEXTAREA' ? 'textarea'
                    : tag === 'SELECT' ? (el.multiple ? 'checkbox' : 'select')
                    : (el.type || 'text');
                const field = {
                    id: name,
                    label: labelFor(el, els),
                    type,
                    required: els.some(e => e.required || e.getAttribute('aria-required') === 'true'),
                    selector: selectorFor(type, tag, name),
                };
                if (type === 'select') {
                    field.options = Array.from(el.options).map(o => o.text.trim()).filter(Boolean);
                } else if (type === 'checkbox' || type === 'radio') {
                    field.options = els.map(input => {
                        const label = input.closest('label');
                        const cloned = label ? label.cloneNode(true) : null;
                        if (cloned) cloned.querySelectorAll('input,select,textarea,button').forEach(n => n.remove());
                        return ((cloned?.textContent || input.value || '').replace(/\\s+/g, ' ').trim());
                    }).filter(Boolean);
                }
                out.push(field);
            }
            return out;
        }
        """,
        list(seen_ids),
    )
    return raw or []


async def _extract_card_fields(page) -> list[dict]:
    """Extract card (custom question) fields from actual rendered DOM inputs.

    Scans all unique card UUIDs from rendered inputs (not baseTemplate hidden inputs),
    which gives the current instance UUIDs that actually appear in the form.
    Uses baseTemplate JSON only to supplement label/option data when DOM labels are missing.
    """
    # Step 1: Collect baseTemplate definitions keyed by template ID (for label supplement)
    templates_by_uuid: dict = {}
    tpl_entries = await page.evaluate("""
    () => {
        const results = {};
        document.querySelectorAll('input[type=hidden][name*="[baseTemplate]"]').forEach(el => {
            const m = el.name.match(/^cards\\[([^\\]]+)\\]\\[baseTemplate\\]$/);
            if (!m) return;
            let tpl = null;
            try { tpl = JSON.parse(el.value); } catch(e) {}
            results[m[1]] = tpl;
        });
        return results;
    }
    """)
    templates_by_uuid = tpl_entries or {}

    # Step 2: Scan actual rendered card inputs to find current instance UUIDs
    rendered = await page.evaluate("""
    () => {
        const uuids = new Set();
        document.querySelectorAll('[name]').forEach(el => {
            const m = el.name.match(/^cards\\[([^\\]]+)\\]\\[/);
            if (m && !el.name.includes('[baseTemplate]')) uuids.add(m[1]);
        });
        return Array.from(uuids);
    }
    """)

    cards = []
    for uuid in rendered:
        dom_fields = await _scan_card_dom(page, uuid)
        cards.extend(dom_fields)

    # If no rendered cards found, fall back to baseTemplate-based extraction
    if not cards:
        for uuid, tpl in templates_by_uuid.items():
            if not tpl:
                continue
            tpl_fields = tpl.get("fields", [])
            for i, tf in enumerate(tpl_fields):
                field_name = f"cards[{uuid}][field{i}]"
                label = tf.get("prompt") or tf.get("text") or f"Card field {i}"
                required = bool(tf.get("required"))
                ftype = tf.get("type", "input_text")
                if ftype in ("input_text", "input_url", "input_numeric"):
                    cards.append({"id": field_name, "label": label, "type": "text",
                                  "required": required, "selector": f'input[name="{field_name}"]'})
                elif ftype == "textarea":
                    cards.append({"id": field_name, "label": label, "type": "textarea",
                                  "required": required, "selector": f'textarea[name="{field_name}"]'})
                elif ftype in ("multiple_choice", "dropdown", "yes_no"):
                    opts = [o.get("text", "") for o in tf.get("options", []) if o.get("text")]
                    if not opts and ftype == "yes_no":
                        opts = ["Yes", "No"]
                    cards.append({"id": field_name, "label": label, "type": "radio",
                                  "required": required, "options": opts,
                                  "selector": f'input[name="{field_name}"]'})
                elif ftype == "multiple_select":
                    opts = [o.get("text", "") for o in tf.get("options", []) if o.get("text")]
                    cards.append({"id": field_name, "label": label, "type": "checkbox",
                                  "required": required, "options": opts,
                                  "selector": f'input[name="{field_name}"]'})

    return cards


async def _scan_card_dom(page, uuid: str) -> list[dict]:
    """Extract card fields by scanning actual rendered DOM inputs for cards[UUID]."""
    fields = []
    raw = await page.evaluate(f"""
    () => {{
        const results = [];
        const seen = new Set();
        // Group all inputs by name first
        const byName = {{}};
        document.querySelectorAll('[name^="cards[{uuid}]"]').forEach(el => {{
            const n = el.name;
            if (n.includes('[baseTemplate]')) return;
            if (!byName[n]) byName[n] = [];
            byName[n].push(el);
        }});
        for (const [name, els] of Object.entries(byName)) {{
            const el = els[0];  // representative element
            const tag = el.tagName;
            // Walk up past option-level li to find question container
            let container = null;
            let cur = el.parentElement;
            while (cur) {{
                if (cur.matches('li.application-question, li.custom-question, div.application-question')) {{
                    container = cur;
                    break;
                }}
                cur = cur.parentElement;
            }}
            // Get question label from container
            let label = name;
            if (container) {{
                const labelEl = container.querySelector('.application-label .text, .application-label');
                label = (labelEl?.textContent || '').trim().replace(/[✱*]+$/, '').trim() || name;
            }}
            const required = el.required || el.getAttribute('aria-required') === 'true';
            let type;
            if (el.tagName === 'TEXTAREA') {{
                type = 'textarea';
            }} else if (el.tagName === 'SELECT') {{
                type = el.multiple ? 'checkbox' : 'select';
            }} else {{
                type = el.type || 'text';
            }}
            // Collect all options
            let options = [];
            if (type === 'radio') {{
                els.forEach(r => {{
                    const span = r.closest('label')?.querySelector('span.application-answer-alternative');
                    const txt = span?.textContent?.trim() || r.value;
                    if (txt) options.push(txt);
                }});
            }} else if (type === 'select') {{
                Array.from(el.options).forEach(o => {{
                    if (o.text.trim()) options.push(o.text.trim());
                }});
            }} else if (type === 'checkbox') {{
                if (el.tagName === 'SELECT') {{
                    Array.from(el.options).forEach(o => {{
                        if (o.text.trim()) options.push(o.text.trim());
                    }});
                }} else {{
                    // input checkboxes — collect values/labels
                    els.forEach(cb => {{
                        const lbl = document.querySelector('label[for="' + cb.id + '"]');
                        const txt = (lbl?.textContent || cb.value || '').trim();
                        if (txt) options.push(txt);
                    }});
                }}
            }}
            results.push({{ name, label, type, required, options, tag }});
        }}
        return results;
    }}
    """)
    for r in raw:
        ftype = r["type"]
        if ftype == "textarea":
            sel = f'textarea[name="{r["name"]}"]'
        elif ftype == "select" or (ftype == "checkbox" and r.get("tag") == "SELECT"):
            # select or multi-select SELECT element
            sel = f'select[name="{r["name"]}"]'
        elif ftype == "checkbox":
            sel = f'input[type="checkbox"][name="{r["name"]}"]'
        else:
            sel = f'input[name="{r["name"]}"]'
        f = {
            "id": r["name"],
            "label": r["label"],
            "type": ftype,
            "required": bool(r["required"]),
            "selector": sel,
        }
        if r["options"]:
            f["options"] = r["options"]
        fields.append(f)
    return fields


async def _lever_field_label(page, selector: str) -> str:
    """Get label text for a Lever form field."""
    try:
        return await page.evaluate(f"""
        () => {{
            const el = document.querySelector({json.dumps(selector)});
            if (!el) return '';
            const li = el.closest('li.application-question, li');
            if (!li) return el.getAttribute('placeholder') || '';
            const lbl = li.querySelector('.application-label .text, .application-label, label div');
            return (lbl?.textContent || '').trim().replace(/✱$/, '').trim();
        }}
        """)
    except Exception:
        return ""


async def _is_required(el) -> bool:
    try:
        return await el.get_attribute("required") is not None or \
               await el.get_attribute("aria-required") == "true"
    except Exception:
        return False


async def _select_options(page, selector: str) -> list[str]:
    try:
        return await page.evaluate(f"""
        () => {{
            const el = document.querySelector({json.dumps(selector)});
            if (!el) return [];
            return Array.from(el.options).map(o => o.text.trim()).filter(Boolean);
        }}
        """)
    except Exception:
        return []


def _load_profile() -> dict:
    if PROFILE_PATH.exists():
        try:
            return json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _infer_answer(field: dict, profile: dict) -> object:
    """Infer answer for a Lever field from profile data."""
    fid = field["id"]
    ftype = field["type"]
    label = (field.get("label") or "").lower()
    opts = field.get("options", [])

    # Standard fields
    if fid == "name":
        return profile.get("full_name", "")
    if fid == "email":
        return profile.get("email", "")
    if fid == "phone":
        return profile.get("phone", "")
    if fid == "org":
        return profile.get("current_company", "")
    if fid == "location":
        return profile.get("location", "")
    if fid == "urls[LinkedIn]":
        return profile.get("linkedin", "")
    if fid == "urls[GitHub]":
        return profile.get("github", "")
    if fid in ("urls[Portfolio]", "urls[Twitter]", "urls[Other]"):
        return profile.get("website", "")
    if fid == "resume":
        return profile.get("resume_path", "")

    # EEO fields
    if fid == "eeo[veteran]":
        return _pick_option(opts, ["not a veteran", "i am not a veteran"], "I am not a veteran")
    if fid == "eeo[gender]":
        return _pick_option(opts, ["prefer not", "decline", "do not wish"], "Decline to state")
    if fid == "eeo[race]":
        return _pick_option(opts, ["prefer not", "decline", "do not wish"], "Decline to state")
    if fid == "eeo[disability]":
        return _pick_option(opts, ["no, i do not", "do not have", "don't have"], "No, I do not have a disability")

    # Card fields — infer from label
    if ftype == "file":
        return profile.get("resume_path", "")
    if ftype in ("radio", "select") and opts:
        # Work authorization and sponsorship are legal declarations only the
        # candidate can make, so the draft leaves them for the person to answer.
        if any(k in label for k in ("authorized to work", "legally authorized", "right to work")):
            return ""
        if re.search(r"\b(?:sponsor\w*|visa|h-?1b|opt)\b", label):
            return ""
        if any(k in label for k in ("veteran", "protected veteran")):
            return _pick_option(opts, ["not a protected", "i am not"], opts[0])
        if any(k in label for k in ("disability",)):
            return _pick_option(opts, ["no, i do not", "do not have"], opts[0])
        if any(k in label for k in ("relocat", "onsite", "in-office", "in office", "hybrid")):
            return _pick_option(opts, ["yes", "open"], opts[0])
        if any(k in label for k in ("how did you hear", "hear about")):
            return _pick_option(opts, ["linkedin"], opts[0])
        if any(k in label for k in ("gender", "race", "ethnicity", "hispanic", "sexual")):
            return _pick_option(opts, ["prefer not", "decline", "do not wish"], opts[0])
        # yes/no default → yes for most required questions
        if set(o.lower().strip() for o in opts) & {"yes", "no"}:
            return _pick_option(opts, ["yes"], opts[0])
        return opts[1] if len(opts) > 1 else opts[0]  # skip "Select..."
    if ftype == "checkbox":
        return []
    if ftype == "textarea":
        return ""  # leave blank — needs manual/AI fill
    return ""


def _pick_option(opts: list, markers: list, fallback: str) -> str:
    for marker in markers:
        for opt in opts:
            if marker in opt.lower():
                return opt
    return fallback


def _build_filled_payload(result: dict, output_dir: Path) -> None:
    """Write fill_payload.json with answers inferred from profile."""
    profile = _load_profile()
    payload = {
        "platform": "lever",
        "apply_url": result["apply_url"],
        "company_slug": result["company_slug"],
        "job_id": result["job_id"],
        "job_title": result["job_title"],
        "answers": {},
    }
    for f in result["fields"]:
        payload["answers"][f["id"]] = _infer_answer(f, profile)

    out = output_dir / "fill_payload.json"
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Filled payload -> {out}")


async def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] in {"-h", "--help"}:
        print(HELP_TEXT)
        if len(sys.argv) < 2:
            sys.exit(1)
        return
    if len(sys.argv) > 3:
        print(HELP_TEXT)
        sys.exit(1)

    apply_url = sys.argv[1]
    output_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("output/lever_extract") / urlparse(apply_url).path.strip("/").replace("/", "_")
    output_dir.mkdir(parents=True, exist_ok=True)

    result = await extract(apply_url, output_dir)
    _build_filled_payload(result, output_dir)

    if result["errors"]:
        print("ERRORS:", result["errors"])


if __name__ == "__main__":
    asyncio.run(main())
