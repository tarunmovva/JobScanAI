#!/usr/bin/env python3
"""Ashby job application form extractor.

Navigates to an Ashby apply URL (jobs.ashbyhq.com/{slug}/{id}/application),
extracts all form fields, and writes a JSON payload file.

Usage:
    python ashby_form_extractor.py <apply_url> [output_dir]
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


HELP_TEXT = """Ashby form extractor

Usage:
  python -m job_application_automator.ashby_form_extractor <apply_url> [output_dir]

Arguments:
  apply_url   Ashby application URL, usually https://jobs.ashbyhq.com/<company>/<job_id>/application
  output_dir  Optional directory for extracted_fields.json, fill_payload.json, screenshots, and HTML artifacts.

Output:
  Writes extracted_fields.json and an editable fill_payload.json for ashby_form_filler.py.
"""


FORM_SELECTOR = "[class*='application-form'], form, main"
NAV_TIMEOUT = 25_000
RENDER_WAIT = 4_500  # Ashby is React — needs time


UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)
SKIP_NAMES = {"g-recaptcha-response", "h-captcha-response", ""}


def _parse_ashby_url(url: str) -> tuple[str, str]:
    """Return (company_slug, job_id) from an Ashby apply URL."""
    parts = urlparse(url).path.strip("/").split("/")
    # jobs.ashbyhq.com/{slug}/{job_id}/application
    if len(parts) >= 2:
        return parts[0], parts[1]
    return parts[0] if parts else "", ""


async def extract(apply_url: str, output_dir: Path) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    slug, job_id = _parse_ashby_url(apply_url)

    result = {
        "platform": "ashby",
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

            await page.wait_for_timeout(RENDER_WAIT)

            # Job title
            try:
                result["job_title"] = (
                    await page.text_content("h1.ashby-job-posting-heading") or
                    await page.text_content("h1") or
                    await page.title()
                )
                result["job_title"] = (result["job_title"] or "").strip()
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

    out_file = output_dir / "extracted_fields.json"
    out_file.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Extracted {len(result['fields'])} fields -> {out_file}")
    return result


async def _extract_fields(page) -> list[dict]:
    """Extract all form fields from the rendered Ashby React form."""
    fields = []

    # Use JS to walk data-field-path containers — most reliable Ashby entry point
    raw = await page.evaluate(_FIELD_EXTRACTION_JS)
    seen_ids = set()

    for r in raw:
        fid = r.get("id", "")
        if not fid or fid in SKIP_NAMES or fid in seen_ids:
            continue
        seen_ids.add(fid)

        ftype = r.get("type", "text")
        label = (r.get("label") or fid).strip()
        required = bool(r.get("required"))
        options = r.get("options") or []
        selector = r.get("selector", "")

        field: dict = {
            "id": fid,
            "label": label,
            "type": ftype,
            "required": required,
            "selector": selector,
        }
        if options:
            field["options"] = options

        fields.append(field)

    # If JS extraction found nothing, fall back to simple input scan
    if not fields:
        fields = await _fallback_scan(page)

    return fields


_FIELD_EXTRACTION_JS = """
() => {
    const fields = [];
    const seenIds = new Set();
    const fieldMetaByPath = new Map();

    function collectFieldMeta(node, seen = new WeakSet()) {
        if (!node || typeof node !== 'object') return;
        if (seen.has(node)) return;
        seen.add(node);

        const field = node.field && typeof node.field === 'object' ? node.field : node;
        if (field.path && (field.title || field.type || field.selectableValues)) {
            const existing = fieldMetaByPath.get(field.path) || {};
            fieldMetaByPath.set(field.path, {
                ...existing,
                ...field,
                isRequired: Boolean(existing.isRequired || node.isRequired || field.isRequired),
            });
        }

        for (const value of Object.values(node)) {
            if (value && typeof value === 'object') collectFieldMeta(value, seen);
        }
    }

    collectFieldMeta(window.__appData);

    function getFieldMeta(fieldPath) {
        return fieldMetaByPath.get(fieldPath) || {};
    }

    function getOptions(fieldPath) {
        const values = getFieldMeta(fieldPath).selectableValues || [];
        return values
            .map(v => ({ label: (v.label || v.value || '').trim(), value: v.value || v.label || '' }))
            .filter(v => v.label);
    }

    function normalizeType(meta, fallback) {
        const ashbyType = String(meta.type || '').toLowerCase();
        if (ashbyType === 'date') return 'date';
        if (ashbyType === 'longtext') return 'textarea';
        if (ashbyType === 'email') return 'email';
        if (ashbyType === 'phone') return 'tel';
        if (ashbyType === 'url') return 'url';
        return fallback || 'text';
    }

    function inputSelector(fieldPath, inputEl, tagName = 'input') {
        const tag = tagName.toLowerCase();
        if (inputEl?.name) return `${tag}[name="${CSS.escape(inputEl.name)}"]`;
        if (inputEl?.id) return `#${CSS.escape(inputEl.id)}`;
        return `[data-field-path="${CSS.escape(fieldPath)}"] ${tag}:not([type=hidden])`;
    }

    // ── Helper: get question label from a field-entry container ──────────────
    function getLabel(container) {
        const lbl = container.querySelector(
            'label.ashby-application-form-question-title, label._label_17tft_43, label'
        );
        return (lbl?.textContent || '').trim().replace(/[*✱]+$/, '').trim();
    }

    // ── Helper: is element required? ─────────────────────────────────────────
    function isRequired(el) {
        return el.required || el.getAttribute('aria-required') === 'true';
    }

    // Ashby's NATIVE inputs (text, email, file, textarea) carry the `required`
    // attribute, so isRequired finds them. Its custom widgets -- radio groups,
    // checkboxes, multi-checkboxes, comboboxes -- are div-based and carry
    // neither `required` nor aria-required. For those the only DOM signal is a
    // CSS-module class on the question label:
    //
    //   <label class="_heading_f7cvd_52 _required_f7cvd_91 ...">Have you used our product before?
    //   <label class="_heading_f7cvd_52 _label_1e3gg_42 ...">Do you have a Github to share?
    //
    // Missing it made half of all captured Ashby forms report at least one
    // required field as optional, which the payload stage then answered with ""
    // and the filler skipped as "empty value" -- so the form refused to submit
    // and a blind AI recovery run had to infer the answers.
    //
    // The hash suffix is per-build, so match the class PREFIX, and only on the
    // label/heading: elsewhere in the tree "_required_" can appear on wrappers
    // that describe a different control.
    function labelMarkedRequired(container) {
        if (!container) return false;
        // Only THIS container's own label counts. Field containers nest, so a
        // plain querySelector picks up a child field's marker and reports its
        // parent as required -- measured on a real form where one consent
        // checkbox is required and the one beside it is not.
        const path = container.getAttribute('data-field-path') || '';
        const labels = container.querySelectorAll('label[class*="_required_"]');
        for (const l of labels) {
            if (l.closest('[data-field-path]') !== container) continue;
            // When a label names a control it must name THIS one. Repeating
            // sections (_systemfield_education_history) nest sub-controls that
            // have no container of their own, so their required labels would
            // otherwise mark the whole section required.
            const target = l.getAttribute('for');
            if (target && path && target !== path) continue;
            return true;
        }
        return false;
    }

    // ── Walk data-field-path containers ──────────────────────────────────────
    document.querySelectorAll('[data-field-path]').forEach(container => {
        const fieldPath = container.getAttribute('data-field-path') || '';
        const entryId   = container.getAttribute('data-field-entry-id') || '';
        if (!fieldPath || seenIds.has(fieldPath)) return;

        const label = getLabel(container);
        const reqByLabel = labelMarkedRequired(container);

        // ── File inputs ───────────────────────────────────────────────────────
        const fileEl = container.querySelector('input[type=file]');
        if (fileEl) {
            const fid = fileEl.name || fileEl.id || fieldPath;
            if (fid && !seenIds.has(fid)) {
                seenIds.add(fid);
                seenIds.add(fieldPath);
                fields.push({
                    id: fid,
                    field_path: fieldPath,
                    label: label || 'Resume',
                    type: 'file',
                    required: isRequired(fileEl) || reqByLabel,
                    selector: fid ? `input[name="${fid}"]` : 'input[type=file]',
                    accept: fileEl.accept || '',
                });
            }
            return;
        }

        // ── Combobox (location/select dropdown) ───────────────────────────────
        const comboEl = container.querySelector('[role=combobox]');
        if (comboEl) {
            seenIds.add(fieldPath);
            const inputEl = container.querySelector('input');
            const fid = (inputEl?.name || inputEl?.id) || fieldPath;
            const meta = getFieldMeta(fieldPath);
            fields.push({
                id: fieldPath,
                field_path: fieldPath,
                label: label || meta.title || 'Location',
                type: 'combobox',
                required: isRequired(comboEl) || Boolean(meta.isRequired) || reqByLabel,
                selector: fieldPath ? `[data-field-path="${fieldPath}"] [role=combobox]` : '[role=combobox]',
                input_selector: fid ? `input[name="${fid}"]` : null,
                options: getOptions(fieldPath),
            });
            return;
        }

        // ── Radio group ───────────────────────────────────────────────────────
        const directInputEl = container.querySelector(
            'input:not([type=hidden]):not([type=file]):not([type=radio]):not([type=checkbox])'
        );
        if (directInputEl) {
            const meta = getFieldMeta(fieldPath);
            const fid = directInputEl.name || directInputEl.id || fieldPath;
            if (!fid || seenIds.has(fid)) { seenIds.add(fieldPath); return; }
            if (fid.includes('recaptcha') || fid.includes('captcha')) { seenIds.add(fieldPath); return; }
            seenIds.add(fid);
            seenIds.add(fieldPath);
            fields.push({
                id: fid,
                field_path: fieldPath,
                label: label || meta.title || fid,
                type: normalizeType(meta, directInputEl.type || 'text'),
                required: isRequired(directInputEl) || Boolean(meta.isRequired) || reqByLabel,
                selector: inputSelector(fieldPath, directInputEl, 'input'),
            });
            return;
        }

        const radioEls = container.querySelectorAll('input[type=radio]');
        if (radioEls.length > 0) {
            seenIds.add(fieldPath);
            // Collect options: label text paired with selector
            const options = [];
            radioEls.forEach(r => {
                const lbl = document.querySelector(`label[for="${r.id}"]`);
                const text = (lbl?.textContent || '').trim();
                if (text) options.push({ label: text, selector: `#${CSS.escape(r.id)}`, name: r.name });
            });
            // Group name from first radio
            const groupName = radioEls[0]?.name || entryId || fieldPath;
            fields.push({
                id: fieldPath,
                field_path: fieldPath,
                label: label || fieldPath,
                type: 'radio',
                required: isRequired(radioEls[0]) || reqByLabel,
                selector: `[data-field-path="${fieldPath}"] input[type=radio]`,
                group_name: groupName,
                options: options,
            });
            return;
        }

        // ── Checkbox group ────────────────────────────────────────────────────
        const checkEls = container.querySelectorAll('input[type=checkbox]');
        if (checkEls.length > 0) {
            seenIds.add(fieldPath);
            // Single GDPR/consent checkbox
            if (checkEls.length === 1) {
                const cb = checkEls[0];
                const fid = cb.name || cb.id || fieldPath;
                const meta = getFieldMeta(fieldPath);
                const cbLabel = document.querySelector(`label[for="${cb.id}"]`)?.textContent?.trim()
                    || label || fid;
                fields.push({
                    id: fid,
                    field_path: fieldPath,
                    label: label || meta.title || cbLabel,
                    type: 'checkbox',
                    required: isRequired(cb) || Boolean(meta.isRequired) || reqByLabel,
                    selector: cb.name ? `input[name="${CSS.escape(cb.name)}"]` : `#${CSS.escape(cb.id)}`,
                    options: cbLabel ? [{ label: cbLabel, selector: `#${CSS.escape(cb.id)}`, name: cb.name }] : [],
                });
                return;
            }
            // Multi-select checkboxes
            const options = [];
            checkEls.forEach(cb => {
                const lbl = document.querySelector(`label[for="${cb.id}"]`);
                const text = (lbl?.textContent || '').trim();
                if (text) options.push({ label: text, selector: `#${CSS.escape(cb.id)}`, name: cb.name });
            });
            fields.push({
                id: fieldPath,
                field_path: fieldPath,
                label: label || fieldPath,
                type: 'multi_checkbox',
                required: reqByLabel,
                selector: `[data-field-path="${fieldPath}"] input[type=checkbox]`,
                options: options,
            });
            return;
        }

        // ── Select ────────────────────────────────────────────────────────────
        const selectEl = container.querySelector('select');
        if (selectEl) {
            seenIds.add(fieldPath);
            const opts = Array.from(selectEl.options).map(o => o.text.trim()).filter(Boolean);
            fields.push({
                id: selectEl.name || fieldPath,
                field_path: fieldPath,
                label: label || fieldPath,
                type: 'select',
                required: isRequired(selectEl) || reqByLabel,
                selector: selectEl.name ? `select[name="${selectEl.name}"]` : 'select',
                options: opts,
            });
            return;
        }

        // ── Textarea ──────────────────────────────────────────────────────────
        const textareaEl = container.querySelector('textarea');
        if (textareaEl) {
            const fid = textareaEl.name || textareaEl.id || fieldPath;
            if (!fid || seenIds.has(fid)) { seenIds.add(fieldPath); return; }
            seenIds.add(fid);
            seenIds.add(fieldPath);
            fields.push({
                id: fid,
                field_path: fieldPath,
                label: label || fid,
                type: 'textarea',
                required: isRequired(textareaEl) || reqByLabel,
                selector: `textarea[name="${fid}"]`,
            });
            return;
        }

        // ── Standard text/email/url/tel input ─────────────────────────────────
        const inputEl = container.querySelector('input:not([type=hidden]):not([type=file])');
        if (inputEl) {
            const meta = getFieldMeta(fieldPath);
            const fid = inputEl.name || inputEl.id || fieldPath;
            if (!fid || seenIds.has(fid)) { seenIds.add(fieldPath); return; }
            // Skip recaptcha
            if (fid.includes('recaptcha') || fid.includes('captcha')) { seenIds.add(fieldPath); return; }
            seenIds.add(fid);
            seenIds.add(fieldPath);
            fields.push({
                id: fid,
                field_path: fieldPath,
                label: label || meta.title || fid,
                type: normalizeType(meta, inputEl.type || 'text'),
                required: isRequired(inputEl) || Boolean(meta.isRequired) || reqByLabel,
                selector: inputSelector(fieldPath, inputEl, 'input'),
            });
        }
    });

    // ── Catch resume file input not under data-field-path ────────────────────
    document.querySelectorAll('input[type=file]').forEach(el => {
        const fid = el.name || el.id;
        if (fid && !seenIds.has(fid) && !fid.includes('autofill')) {
            seenIds.add(fid);
            fields.push({
                id: fid,
                label: 'Resume / CV',
                type: 'file',
                required: el.required,
                selector: `input[name="${fid}"]`,
                accept: el.accept || '',
            });
        }
    });

    return fields;
}
"""


async def _fallback_scan(page) -> list[dict]:
    """Fallback: extract fields by scanning all inputs when data-field-path missing."""
    raw = await page.evaluate("""
    () => {
        const fields = [];
        const seen = new Set();
        document.querySelectorAll('input:not([type=hidden]), textarea, select').forEach(el => {
            const fid = el.name || el.id || '';
            if (!fid || seen.has(fid)) return;
            if (fid.includes('recaptcha') || fid.includes('captcha')) return;
            seen.add(fid);
            const type = el.tagName === 'TEXTAREA' ? 'textarea'
                       : el.tagName === 'SELECT' ? 'select'
                       : (el.type || 'text');
            const label = el.closest('[class*="field"], [class*="Field"]')
                ?.querySelector('label')?.textContent?.trim() || fid;
            const options = el.tagName === 'SELECT'
                ? Array.from(el.options).map(o => o.text.trim()).filter(Boolean)
                : [];
            fields.push({ id: fid, label, type, required: el.required,
                          selector: `${el.tagName.toLowerCase()}[name="${fid}"]`, options });
        });
        return fields;
    }
    """)
    return raw


def _generate_empty_payload(result: dict, output_dir: Path) -> None:
    """Write fill_payload.json with empty values for manual editing."""
    payload = {
        "platform": "ashby",
        "apply_url": result["apply_url"],
        "company_slug": result["company_slug"],
        "job_id": result["job_id"],
        "job_title": result["job_title"],
        "answers": {},
    }
    for f in result["fields"]:
        ftype = f["type"]
        fid = f["id"]
        if ftype == "file":
            payload["answers"][fid] = "/path/to/resume.pdf"
        elif ftype == "radio":
            opts = f.get("options", [])
            payload["answers"][fid] = opts[0]["label"] if opts else ""
        elif ftype in ("checkbox", "multi_checkbox"):
            payload["answers"][fid] = False if ftype == "checkbox" else []
        elif ftype == "combobox":
            payload["answers"][fid] = ""
        elif ftype == "select":
            opts = f.get("options", [])
            payload["answers"][fid] = opts[0] if opts else ""
        else:
            payload["answers"][fid] = ""

    out = output_dir / "fill_payload.json"
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Empty payload -> {out}")


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
    slug, job_id = _parse_ashby_url(apply_url)
    output_dir = (
        Path(sys.argv[2])
        if len(sys.argv) > 2
        else Path("output") / f"{slug}_{job_id[:8]}_ashby_extract"
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    result = await extract(apply_url, output_dir)
    _generate_empty_payload(result, output_dir)

    if result["errors"]:
        print("ERRORS:", result["errors"])


if __name__ == "__main__":
    asyncio.run(main())
