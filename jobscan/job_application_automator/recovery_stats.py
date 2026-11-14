#!/usr/bin/env python3
"""Cost and outcome statistics for AI recovery runs.

Reads every ``fill_result.json`` under a job-automator home and reports the
metrics the recovery work is judged on: confirmed-submit rate, latency, uncached
input tokens, tool calls, and the fabrication/tab guardrails.

New runs carry these in ``fill_result.json["recovery"]`` directly. Older runs
predate that instrumentation, so their numbers are back-derived from
``recovery_events.jsonl`` — which is why the historical baseline is reproducible
from code rather than from a one-off script.

    python -m job_application_automator.recovery_stats
    python -m job_application_automator.recovery_stats --home <dir> --json
    python -m job_application_automator.recovery_stats --group focus_mode
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

_MUTATING_TOOLS = frozenset({
    "browser_click", "browser_type", "browser_select_option", "browser_fill_form",
    "browser_press_key", "browser_file_upload", "browser_run_code_unsafe",
})


def default_home() -> Path:
    env = os.environ.get("JOB_AUTOMATOR_HOME")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / ".job-automator"


def _events_fallback(events_path: Path) -> dict[str, Any]:
    """Back-derive usage/tools for runs recorded before AgentMetrics existed."""
    usage = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
    by_tool: Counter[str] = Counter()
    errors = 0
    try:
        lines = events_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return {}
    for line in lines:
        try:
            event = json.loads(line)
        except Exception:
            continue
        item = event.get("item") or {}
        if event.get("type") == "item.started" and item.get("type") == "mcp_tool_call":
            by_tool[str(item.get("tool") or "?")] += 1
        elif (event.get("type") == "item.completed" and item.get("type") == "mcp_tool_call"
              and item.get("error")):
            errors += 1
        elif event.get("type") == "turn.completed":
            for key in usage:
                usage[key] += (event.get("usage") or {}).get(key) or 0
    usage["uncached_input_tokens"] = usage["input_tokens"] - usage["cached_input_tokens"]
    return {
        "usage": usage,
        "tools": {
            "total": sum(by_tool.values()),
            "errors": errors,
            "snapshot": by_tool.get("browser_snapshot", 0),
            "run_code_unsafe": by_tool.get("browser_run_code_unsafe", 0),
            "by_tool": dict(by_tool),
        },
        "_derived": True,
    }


def collect(home: Path) -> list[dict[str, Any]]:
    """One row per attempted recovery."""
    rows: list[dict[str, Any]] = []
    apps = home / "applications"
    if not apps.is_dir():
        return rows
    for platform_dir in sorted(apps.iterdir()):
        if not platform_dir.is_dir():
            continue
        for job_dir in sorted(platform_dir.iterdir()):
            result_path = job_dir / "fill_result.json"
            if not result_path.is_file():
                continue
            try:
                result = json.loads(result_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            recovery = result.get("recovery")
            if not (isinstance(recovery, dict) and recovery.get("attempted")):
                continue
            if "usage" not in recovery:
                recovery = {**recovery, **_events_fallback(job_dir / "recovery_events.jsonl")}
            verdict = recovery.get("verdict") or {}
            usage = recovery.get("usage") or {}
            tools = recovery.get("tools") or {}
            rows.append({
                "platform": platform_dir.name,
                "job_id": job_dir.name,
                "mode": recovery.get("mode"),
                "outcome": recovery.get("outcome"),
                "trigger_status": recovery.get("trigger_status") or "(not recorded)",
                "focus_mode": recovery.get("focus_mode") or "(not recorded)",
                "skill_rev": recovery.get("skill_rev") or "(pre-skill)",
                "prompt_rev": recovery.get("prompt_rev"),
                "duration_s": recovery.get("duration_s"),
                "uncached_input_tokens": usage.get("uncached_input_tokens", 0),
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
                "tool_calls": tools.get("total", 0),
                "snapshot_calls": tools.get("snapshot", 0),
                "run_code_unsafe": tools.get("run_code_unsafe", 0),
                "time_to_first_mutation_s": tools.get("time_to_first_mutation_s"),
                "context_bytes": (recovery.get("context_bytes") or {}).get("_total"),
                "inferred": len(verdict.get("inferred") or []),
                "unfixable": len(verdict.get("unfixable") or []),
                "tab_url_mismatch": bool(recovery.get("tab_url_mismatch")),
                "derived": bool(recovery.get("_derived")),
            })
    return rows


def _pct(values: Iterable[Any], q: float) -> Any:
    clean = sorted(v for v in values if isinstance(v, (int, float)))
    if not clean:
        return None
    return clean[min(int(len(clean) * q), len(clean) - 1)]


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    fix = [r for r in rows if r["mode"] == "fix"]
    submitted = [r for r in fix if r["outcome"] == "submitted"]

    def dist(key: str) -> dict[str, Any]:
        values = [r[key] for r in rows if isinstance(r.get(key), (int, float))]
        if not values:
            return {}
        return {
            "n": len(values), "p50": _pct(values, 0.5), "p90": _pct(values, 0.9),
            "max": max(values), "mean": round(statistics.mean(values), 1),
            "sum": sum(values),
        }

    return {
        "runs": len(rows),
        "fix_runs": len(fix),
        "fix_submitted": len(submitted),
        "fix_submit_rate": round(len(submitted) / len(fix), 3) if fix else None,
        "outcomes": dict(Counter(r["outcome"] for r in rows).most_common()),
        "trigger_status": dict(Counter(r["trigger_status"] for r in rows).most_common()),
        "focus_mode": dict(Counter(r["focus_mode"] for r in rows).most_common()),
        "skill_rev": dict(Counter(r["skill_rev"] for r in rows).most_common()),
        "duration_s": dist("duration_s"),
        "uncached_input_tokens": dist("uncached_input_tokens"),
        "input_tokens": dist("input_tokens"),
        "output_tokens": dist("output_tokens"),
        "tool_calls": dist("tool_calls"),
        "snapshot_calls": dist("snapshot_calls"),
        "run_code_unsafe": dist("run_code_unsafe"),
        "context_bytes": dist("context_bytes"),
        "guardrails": {
            "inferred_mean": round(statistics.mean([r["inferred"] for r in rows]), 2) if rows else 0,
            "inferred_any_pct": round(
                100 * len([r for r in rows if r["inferred"]]) / len(rows), 1) if rows else 0,
            "unfixable_mean": round(statistics.mean([r["unfixable"] for r in rows]), 2) if rows else 0,
            "tab_url_mismatch_pct": round(
                100 * len([r for r in rows if r["tab_url_mismatch"]]) / len(rows), 1) if rows else 0,
            "gave_up_pct": round(
                100 * len([r for r in rows if r["outcome"] == "gave_up"]) / len(rows), 1) if rows else 0,
        },
    }


def _render(summary: dict[str, Any]) -> str:
    lines = [
        f"recoveries attempted        {summary['runs']}",
        f"fix-mode confirmed submit   {summary['fix_submitted']} / {summary['fix_runs']}"
        f"  ({(summary['fix_submit_rate'] or 0) * 100:.0f}%)",
        "",
        f"{'metric':26} {'p50':>10} {'p90':>10} {'max':>10} {'mean':>10}",
    ]
    for key in ("duration_s", "uncached_input_tokens", "input_tokens", "tool_calls",
                "snapshot_calls", "run_code_unsafe", "context_bytes"):
        d = summary.get(key) or {}
        if not d:
            continue
        lines.append(f"{key:26} {d['p50']:>10,} {d['p90']:>10,} {d['max']:>10,} {d['mean']:>10,}")
    guard = summary["guardrails"]
    lines += [
        "",
        "guardrails",
        f"  inferred[] mean           {guard['inferred_mean']}  (>=1 in {guard['inferred_any_pct']}% of runs)",
        f"  unfixable[] mean          {guard['unfixable_mean']}",
        f"  tab_url_mismatch          {guard['tab_url_mismatch_pct']}%",
        f"  gave_up                   {guard['gave_up_pct']}%",
        "",
        f"outcomes      {summary['outcomes']}",
        f"focus_mode    {summary['focus_mode']}",
        f"skill_rev     {summary['skill_rev']}",
        f"trigger       {summary['trigger_status']}",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--home", type=Path, default=default_home())
    parser.add_argument("--json", action="store_true", help="emit the summary as JSON")
    parser.add_argument("--group", default="", help="also break the summary down by this row key")
    parser.add_argument("--csv", type=Path, default=None, help="write the per-run rows to CSV")
    args = parser.parse_args()

    rows = collect(args.home)
    if not rows:
        print(f"no recovery runs found under {args.home}")
        return 1

    summary = summarize(rows)
    groups = {}
    if args.group:
        for key in sorted({str(r.get(args.group)) for r in rows}):
            groups[key] = summarize([r for r in rows if str(r.get(args.group)) == key])

    if args.csv:
        import csv

        with args.csv.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        print(f"wrote {len(rows)} rows -> {args.csv}")

    if args.json:
        print(json.dumps({"overall": summary, "groups": groups}, indent=2))
        return 0

    print(_render(summary))
    for key, group in groups.items():
        print(f"\n=== {args.group} = {key} ===")
        print(_render(group))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
