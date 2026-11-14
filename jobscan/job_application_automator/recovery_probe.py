#!/usr/bin/env python3
"""Hand the recovery agent a real form and see what it can actually do.

This exists because unit tests kept passing while the thing was broken. In its
first three uses it found: a KeyError that killed recovery outright on Ashby
and Lever, a skill file that quietly overrode the prompt so the new tools were
never called, a submit button chooser that clicked "Apply" (which only scrolls
to the form) and reported a submission, and a stray Enter keypress that
submitted a form mid-fill. None of those were visible from a fixture.

Two scenarios, both against live postings:

  empty    the form is opened and NOTHING is filled. The agent is the only
           thing that ever touches it. This is the ceiling: whatever it cannot
           complete here, it cannot complete anywhere.
  partial  a fraction of the answers are filled, the rest left blank, and the
           agent is asked to finish. This is the shape of a real recovery.

Everything the agent does is recorded per field, so a failure names the control
rather than the job.

  python fix_agent_probe.py --jobs jobs.json --out DIR --mode empty|partial
                            [--fraction 0.5] [--submit]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

# Importable as a module; no absolute path pinning.

from job_application_automator.agent_recovery import attempt_recovery  # noqa: E402
from job_application_automator.browser_cdp import ensure_cdp_chrome, open_cdp_page  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402


async def _state(page) -> dict:
    """What the page says about itself, using the form tools' own probe.

    Goes through FormTools._decide, not a raw evaluate: the JS reports evidence
    and Python decides whether the page is a confirmation. Reading the JS result
    directly leaves `confirmation` absent, which reads as "not submitted" for
    every run -- three probe runs reported recovered=False against verdicts
    saying the application had gone through.
    """
    from job_application_automator.form_tools_mcp import _STATE_JS, FormTools
    try:
        return FormTools._decide(await page.evaluate(_STATE_JS))
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}", "problems": []}


async def _fill_fraction(page, payload: dict, fraction: float) -> list[str]:
    """Fill the first `fraction` of answered fields, leave the rest blank."""
    from job_application_automator.form_tools_mcp import FormTools
    answers = {k: v for k, v in (payload.get("answers") or {}).items()
               if isinstance(v, str) and v.strip()}
    ids = list(answers)
    take = ids[: max(0, int(len(ids) * fraction))]
    if not take:
        return []
    tools = FormTools("", "")
    tools._page = page
    res = await tools.fill_fields([{"id": i, "value": answers[i]} for i in take])
    return [r["id"] for r in res["results"] if r["ok"]]


async def run_case(job: dict, out_root: Path, mode: str, fraction: float) -> dict:
    platform = job["platform"]
    job_id = job["job_id"]
    out = out_root / f"{platform}-{job_id}"
    out.mkdir(parents=True, exist_ok=True)

    payload_src = Path(job["payload"])
    payload = json.loads(payload_src.read_text(encoding="utf-8"))
    apply_url = payload.get("apply_url") or job.get("apply_url")

    row = {"platform": platform, "job_id": job_id, "company": job.get("company"),
           "mode": mode, "apply_url": apply_url}

    await ensure_cdp_chrome()
    session = None
    pw = None
    try:
        pw = await async_playwright().start()
        session = await open_cdp_page(pw)
        page = session.page
        await page.goto(apply_url, wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(3000)

        prefilled = []
        if mode == "partial":
            prefilled = await _fill_fraction(page, payload, fraction)
        row["prefilled"] = prefilled

        # Nudge native validation so invalid controls are marked, which is what
        # a real failed submit would have left behind.
        try:
            await page.evaluate(
                "() => { const f = document.querySelector('form'); if (f && f.reportValidity) f.reportValidity(); }"
            )
        except Exception:
            pass

        before = await _state(page)
        row["before"] = {"problems": [p["id"] for p in before.get("problems", [])],
                         "confirmation": before.get("confirmation", "")}

        async def detect() -> bool:
            st = await _state(page)
            return bool(st.get("confirmation"))

        started = time.time()
        result_ref = {"platform": platform, "errors": [], "filled": []}
        recovered = await attempt_recovery(
            platform=platform, apply_url=apply_url, payload=payload,
            result=result_ref,
            output_dir=out,
            failure={"status": "validation_errors" if platform == "greenhouse" else "not_confirmed",
                     "reason": f"probe:{mode}", "errors": []},
            page=page, detect=detect,
        )
        row["seconds"] = round(time.time() - started, 1)
        row["recovered"] = bool(recovered)
        # The skip reason lives here and nowhere else.
        row["recovery"] = result_ref.get("recovery")

        after = await _state(page)
        row["after"] = {"problems": [p["id"] for p in after.get("problems", [])],
                        "confirmation": after.get("confirmation", "")}
    except Exception as exc:
        row["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if session is not None:
            try:
                await session.cleanup()
            except Exception:
                pass
        if pw is not None:
            try:
                await pw.stop()
            except Exception:
                pass

    v = out / "recovery_verdict.json"
    if v.is_file():
        try:
            row["verdict"] = json.loads(v.read_text(encoding="utf-8"))
        except Exception:
            pass
    ev = out / "recovery_events.jsonl"
    if ev.is_file():
        lines = ev.read_text(encoding="utf-8", errors="ignore").splitlines()
        calls = [json.loads(l)["item"]["tool"] for l in lines
                 if '"mcp_tool_call"' in l and '"item.completed"' in l]
        row["tool_calls"] = len(calls)
        row["tools"] = {t: calls.count(t) for t in sorted(set(calls))}
    return row


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mode", choices=["empty", "partial"], default="empty")
    ap.add_argument("--fraction", type=float, default=0.5)
    args = ap.parse_args()

    jobs = json.loads(Path(args.jobs).read_text(encoding="utf-8"))
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)

    rows = []
    for job in jobs:
        print(f"\n=== {args.mode}: {job.get('company')} ({job['platform']}/{job['job_id']})", flush=True)
        row = await run_case(job, out_root, args.mode, args.fraction)
        rows.append(row)
        print(f"    recovered={row.get('recovered')} {row.get('seconds')}s "
              f"calls={row.get('tool_calls')} before={len(row.get('before',{}).get('problems',[]))} "
              f"after={len(row.get('after',{}).get('problems',[]))}", flush=True)
        if row.get("verdict"):
            print(f"    verdict: {str(row['verdict'].get('notes'))[:120]}", flush=True)
    (out_root / "probe-results.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    print(f"\nwrote {out_root / 'probe-results.json'}")


if __name__ == "__main__":
    asyncio.run(main())
