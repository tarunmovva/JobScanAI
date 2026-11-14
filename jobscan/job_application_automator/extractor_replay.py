#!/usr/bin/env python3
"""Replay the field extractors against forms already captured on disk.

Every application directory keeps ``form.html`` -- the page exactly as the
extractor saw it -- next to the ``extracted_fields.json`` it produced. That is a
frozen corpus of hundreds of real forms, so an extractor change can be measured
against all of them at once instead of against whichever posting is open today.

This matters because the alternative is destructive: validating an extractor
change on a live posting costs a real job application, and the same posting
cannot be tried twice.

    python -m job_application_automator.extractor_replay --platform ashby
    python -m job_application_automator.extractor_replay --platform ashby --limit 50 --show 10

The page is loaded with ``set_content`` and never navigated to, so nothing is
requested from the employer and nothing can be submitted.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
from pathlib import Path
from typing import Any

from playwright.async_api import async_playwright

try:
    from job_application_automator import ashby_form_extractor as ashby
    from job_application_automator.browser_cdp import open_cdp_page
except ImportError:  # direct-script execution
    import ashby_form_extractor as ashby
    from browser_cdp import open_cdp_page


def default_home() -> Path:
    import os
    env = os.environ.get("JOB_AUTOMATOR_HOME")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / ".job-automator"


# Ashby renders required-ness as a CSS-module class on the LABEL
# (``_required_f7cvd_91``), not as a DOM attribute on the control. This is the
# independent ground truth the extractor is graded against: it reads the saved
# HTML directly rather than asking the extractor what it thinks.
_ASHBY_REQUIRED_LABEL = re.compile(
    r'<label[^>]*class="[^"]*_required_[^"]*"[^>]*for="([^"]+)"', re.I)


def ashby_dom_required(html: str) -> set[str]:
    return set(_ASHBY_REQUIRED_LABEL.findall(html))


# The same extraction JS with the label signal neutralised. Running both against
# one page shows exactly which fields the label signal changed, so a fix can be
# proved to add nothing it should not.
_JS_WITHOUT_LABEL_SIGNAL = ashby._FIELD_EXTRACTION_JS.replace("|| reqByLabel", "|| false")
assert _JS_WITHOUT_LABEL_SIGNAL != ashby._FIELD_EXTRACTION_JS, "label signal not present in extractor JS"
_JS_WITHOUT_LABEL_SIGNAL = _JS_WITHOUT_LABEL_SIGNAL.replace("required: reqByLabel,", "required: false,")


def _as_fields(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, dict):
        return list(raw.get("fields") or [])
    return list(raw or [])


_SCRIPT_RE = re.compile(r"<script[^>]*>.*?</script\s*>", re.I | re.S)


def freeze(html: str) -> str:
    """Strip <script> so the captured DOM stays as captured.

    A saved Ashby page still carries its bundle. Handed to set_content, React
    re-mounts and REPLACES the markup -- one probe went from 9 data-field-path
    nodes in the file to 0 in the DOM, body 41KB -> 17KB. The extractor then
    reports nothing and the form looks empty rather than broken.
    """
    return _SCRIPT_RE.sub("", html)


async def replay_ashby(page: Any, html: str) -> list[dict[str, Any]]:
    """Run the production extraction JS against a frozen page."""
    await page.set_content(freeze(html), wait_until="domcontentloaded")
    return _as_fields(await page.evaluate(ashby._FIELD_EXTRACTION_JS))


async def replay_ashby_baseline(page: Any) -> list[dict[str, Any]]:
    """Same page, extractor as it behaved before the label signal."""
    return _as_fields(await page.evaluate(_JS_WITHOUT_LABEL_SIGNAL))


async def run(platform: str, limit: int, show: int, home: Path) -> int:
    apps = home / "applications" / platform
    if not apps.is_dir():
        print(f"no captured forms under {apps}")
        return 1

    cases = []
    for job in sorted(apps.iterdir()):
        form = job / "form.html"
        if form.is_file():
            cases.append((job.name, form))
        if limit and len(cases) >= limit:
            break

    forms = fields_seen = missed = extra = 0
    jobs_affected = 0
    by_type: dict[str, int] = {}
    shown = 0
    shown_extra = [0]
    changed = [0]
    unparseable = 0
    unjustified: list = []

    # The shared CDP Chrome, same browser the fillers drive. Avoids a separate
    # headless download, and one blank tab that only ever receives set_content
    # cannot reach an employer's site.
    async with async_playwright() as pw:
        session = await open_cdp_page(pw, viewport={"width": 1366, "height": 900})
        page = session.page
        for job_id, form in cases:
            try:
                html = form.read_text(encoding="utf-8", errors="replace")
                fields = await replay_ashby(page, html)
                base = {str(b.get("field_path") or b.get("id")): bool(b.get("required"))
                        for b in await replay_ashby_baseline(page)}
            except Exception as exc:
                print(f"  !! {job_id}: {exc}")
                continue
            forms += 1
            # A saved page that yields no fields is NOT a clean pass -- it is a
            # page this harness could not reconstruct. Some captures re-parse
            # with the form subtree missing (present in the file, absent from
            # the DOM). Counting them as "0 missed" would silently inflate every
            # result, so they are excluded from the denominator and reported.
            if not fields and ashby_dom_required(html):
                unparseable += 1
                continue
            truth = ashby_dom_required(html)
            hit = False
            for f in fields:
                fid = str(f.get("field_path") or f.get("id") or "")
                if bool(f.get("required")) and not base.get(fid, False):
                    changed[0] += 1
                    if fid not in truth:
                        unjustified.append((job_id[:8], str(f.get("type")), str(f.get("label"))[:52]))
            for f in fields:
                fields_seen += 1
                fid = str(f.get("field_path") or f.get("id") or "")
                got = bool(f.get("required"))
                want = fid in truth
                if want and not got:
                    missed += 1
                    hit = True
                    t = str(f.get("type"))
                    by_type[t] = by_type.get(t, 0) + 1
                    if shown < show:
                        shown += 1
                        print(f"  MISSED  {job_id[:8]}  {t:<16} {str(f.get('label'))[:56]}")
                elif got and not want:
                    # Marked required with no label marker. Legitimate when the
                    # control carries a native `required` attribute or Ashby's
                    # own config said so -- tracked to catch OVER-marking, which
                    # would make the filler refuse to submit a valid form.
                    extra += 1
                    if shown_extra[0] < show:
                        shown_extra[0] += 1
                        print(f"  EXTRA?  {job_id[:8]}  {str(f.get('type')):<16} {str(f.get('label'))[:56]}")
            if hit:
                jobs_affected += 1

        await session.cleanup()

    print()
    print(f"platform                    : {platform}")
    print(f"forms found                 : {forms}")
    print(f"  ...unreplayable (no fields): {unparseable}")
    print(f"  ...actually graded         : {forms - unparseable}")
    print(f"fields extracted            : {fields_seen}")
    print(f"required MISSED by extractor: {missed}")
    print(f"forms affected              : {jobs_affected} ({100*jobs_affected/(forms or 1):.1f}%)")
    print(f"by field type               : {dict(sorted(by_type.items(), key=lambda kv: -kv[1]))}")
    print(f"marked required w/o label   : {extra}  (native attr or Ashby config -- not necessarily wrong)")
    print(f"NEWLY required vs baseline   : {changed[0]}")
    print(f"  ...of those UNJUSTIFIED     : {len(unjustified)}  (must be 0 -- required with no label marker)")
    for u in unjustified[:6]:
        print("     ", u)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--platform", default="ashby", choices=["ashby"])
    ap.add_argument("--limit", type=int, default=0, help="0 = every captured form")
    ap.add_argument("--show", type=int, default=8, help="how many misses to print")
    ap.add_argument("--home", type=Path, default=None)
    args = ap.parse_args()
    return asyncio.run(run(args.platform, args.limit, args.show, args.home or default_home()))


if __name__ == "__main__":
    raise SystemExit(main())
