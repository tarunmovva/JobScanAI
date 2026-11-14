#!/usr/bin/env python3
"""Sync the app's applied-jobs history with on-disk fill results.

Out-of-band submissions (AI-recovery reruns, batch tests) write
fill_result.json with submission.status='submitted' but never touch the
Electron store — no Applied badge, skip-if-clean unaware. Conversely, the
pre-fix Go status mapping recorded some captcha/OTP-blocked jobs as
submitted. This script reconciles both directions.

Usage (CLOSE THE APP FIRST — it holds config.json):
    python scripts/sync_applied_jobs.py            # report + ADD missing submitted jobs
    python scripts/sync_applied_jobs.py --dry-run  # report only, write nothing
    python scripts/sync_applied_jobs.py --prune    # also demote entries whose
                                                   # current fill_result is NOT submitted

A timestamped backup of config.json is written next to it before any change.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

CONFIG = Path(os.path.expandvars(r"%APPDATA%\jobscan-app\config.json"))
APPS = Path(os.environ.get("JOB_AUTOMATOR_HOME", Path(__file__).resolve().parent.parent / ".job-automator")) / "applications"


def scan_results() -> dict[str, dict]:
    """job_id -> {platform, status, mtime, dir} from every fill_result.json."""
    found: dict[str, dict] = {}
    for f in APPS.glob("*/*/fill_result.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        # A record known to be wrong must never be backfilled as an application.
        # Two Ashby runs recorded submission.status='submitted' for postings that
        # were already gone (the pre-fix network check matched any "graphql" URL,
        # so job-not-found read as acceptance). They are kept on disk as evidence
        # of that regression, which makes them indistinguishable from real
        # submissions to anything that scans this tree -- hence the marker.
        if d.get("record_invalidated"):
            continue
        status = (d.get("submission") or {}).get("status") or d.get("status") or ""
        job_id = f.parent.name
        prev = found.get(job_id)
        if prev is None or f.stat().st_mtime > prev["mtime"]:
            found[job_id] = {
                "platform": f.parts[len(APPS.parts)],
                "status": status,
                "mtime": f.stat().st_mtime,
                "dir": f.parent,
                "apply_url": d.get("apply_url", ""),
            }
    return found


def job_meta(info: dict) -> tuple[str, str]:
    """(title, company) — prefer payload job_context, fall back to dir names."""
    try:
        p = json.loads((info["dir"] / "fill_payload.json").read_text(encoding="utf-8"))
        ctx = p.get("job_context") or {}
        title = ctx.get("title") or p.get("job_title") or ""
        company = ctx.get("company") or p.get("company") or p.get("company_slug") or ""
        if title or company:
            return title, company
    except Exception:
        pass
    return "", ""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--prune", action="store_true")
    args = ap.parse_args()

    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    applied_ids: list[str] = list(cfg.get("appliedJobIds") or [])
    log: list[dict] = list(cfg.get("appliedJobsLog") or [])
    results = scan_results()

    # ── ADD: submitted on disk, missing from history ──
    to_add = [jid for jid, info in results.items()
              if info["status"] == "submitted" and jid not in applied_ids]
    print(f"disk results: {len(results)} | appliedJobIds: {len(applied_ids)} | to add: {len(to_add)}")
    for jid in sorted(to_add):
        info = results[jid]
        title, company = job_meta(info)
        print(f"  + {info['platform']}:{jid}  {company} {title}".rstrip())
        applied_ids.append(jid)
        log.append({
            "company": company or info["platform"],
            "jobId": jid,
            "platform": info["platform"],
            "title": title,
            "applyUrl": info["apply_url"],
            "status": "submitted",
            "message": "synced from fill_result",
            "via": "sync",
            "ts": datetime.fromtimestamp(info["mtime"], tz=timezone.utc).isoformat(),
        })

    # ── PRUNE: in history as applied, but current fill_result says otherwise ──
    demoted = 0
    if args.prune:
        bogus = [jid for jid in applied_ids
                 if jid in results and results[jid]["status"] not in ("submitted", "")]
        print(f"prune candidates (current result non-submitted): {len(bogus)}")
        for jid in sorted(bogus):
            print(f"  - {results[jid]['platform']}:{jid}  status={results[jid]['status']}")
        applied_ids = [j for j in applied_ids if j not in set(bogus)]
        for entry in log:
            if entry.get("jobId") in set(bogus) and entry.get("status") == "submitted":
                entry["status"] = "failed"
                entry["message"] = f"corrected by sync: fill_result says {results[entry['jobId']]['status']}"
                demoted += 1

    if args.dry_run:
        print("\nDRY RUN — nothing written")
        return
    if not to_add and demoted == 0 and not args.prune:
        print("\nnothing to change")
        return

    backup = CONFIG.with_name(f"config.backup-{time.strftime('%Y%m%d-%H%M%S')}.json")
    shutil.copy(CONFIG, backup)
    cfg["appliedJobIds"] = applied_ids
    cfg["appliedJobsLog"] = log
    CONFIG.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    print(f"\nwritten. added={len(to_add)} demoted={demoted} backup={backup.name}")


if __name__ == "__main__":
    main()
