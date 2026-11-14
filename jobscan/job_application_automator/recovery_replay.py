#!/usr/bin/env python3
"""Offline replay corpus for the AI recovery agent.

Live A/B cannot measure recovery accuracy: detecting 71% -> 85% at 80% power needs
~150 runs per arm and the whole recorded history is ~190 recoveries. So the submit
rate stays a non-regression guardrail and *accuracy* is measured here instead —
against frozen pages, deterministically, without burning real applications.

A case is one failed fill, captured by ``agent_recovery`` at handoff time:

    recovery_page.html          the page exactly as the filler left it
    recovery_context.json       what the agent is shown
    recovery_focus.json         the dossier
    fill_result.json            the filler's own failure record (ground truth)

``build`` harvests those into a corpus; ``run`` serves a case over localhost,
points a real Chrome at it, runs the agent with the production argv, and grades
which field ids the agent named against the ids the filler recorded as broken.

    python -m job_application_automator.recovery_replay build
    python -m job_application_automator.recovery_replay run --all
    python -m job_application_automator.recovery_replay run --case tests/recovery_replay/greenhouse-<job_id>

SCOPE: a frozen React page is not guaranteed to be drivable — its JS bundle is
gone, so controls may not respond to clicks. The corpus therefore grades
DIAGNOSIS (did the agent name the right controls) reliably, and REPAIR only for
cases marked ``drivable: true`` by ``run --probe``.
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import http.server
import json
import shutil
import socketserver
import threading
import time
from pathlib import Path
from typing import Any

try:
    from job_application_automator import agent_recovery as ar
    from job_application_automator import recovery_focus as rf
    from job_application_automator.fill_logging import FillLog
    from job_application_automator.recovery_stats import default_home
except ImportError:  # direct-script execution
    import agent_recovery as ar
    import recovery_focus as rf
    from fill_logging import FillLog
    from recovery_stats import default_home

DEFAULT_CORPUS = Path(__file__).resolve().parent.parent / "tests" / "recovery_replay"
CASE_FILES = ("recovery_page.html", "recovery_context.json", "recovery_focus.json")


# ── build ────────────────────────────────────────────────────────────────────

def _ground_truth_ids(result: dict[str, Any]) -> list[str]:
    """Field ids the filler itself recorded as broken, minus the page-level pseudo
    ids. Uses the same explicit set as the dossier so ground truth and the thing
    being graded cannot drift apart."""
    ids: list[str] = []
    for key in ("required_unfilled", "verification_failed", "errors", "unanswered_visible_controls"):
        for entry in result.get(key) or []:
            if not isinstance(entry, dict):
                continue
            fid = str(entry.get("id") or "").strip()
            if fid and fid not in rf.PSEUDO_FIELD_IDS and fid not in ids:
                ids.append(fid)
    return ids


def build(home: Path, corpus: Path, limit: int) -> int:
    corpus.mkdir(parents=True, exist_ok=True)
    apps = home / "applications"
    if not apps.is_dir():
        print(f"no applications dir under {home}")
        return 1
    added = 0
    for platform_dir in sorted(apps.iterdir()):
        if not platform_dir.is_dir():
            continue
        for job_dir in sorted(platform_dir.iterdir()):
            if added >= limit:
                break
            page = job_dir / "recovery_page.html"
            result_path = job_dir / "fill_result.json"
            if not (page.is_file() and result_path.is_file()):
                continue
            try:
                result = json.loads(result_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            recovery = result.get("recovery") or {}
            expected = _ground_truth_ids(result)
            case_dir = corpus / f"{platform_dir.name}-{job_dir.name}"
            case_dir.mkdir(parents=True, exist_ok=True)
            for name in CASE_FILES:
                src = job_dir / name
                if src.is_file():
                    shutil.copy2(src, case_dir / name)
            (case_dir / "case.json").write_text(json.dumps({
                "platform": platform_dir.name,
                "job_id": job_dir.name,
                "trigger_status": recovery.get("trigger_status") or result.get("status"),
                "focus_mode": recovery.get("focus_mode"),
                "expected_field_ids": expected,
                "live_outcome": recovery.get("outcome"),
                "drivable": None,     # set by `run --probe`
            }, indent=2), encoding="utf-8")
            added += 1
    print(f"corpus: {added} cases -> {corpus}")
    return 0 if added else 1


# ── serve ────────────────────────────────────────────────────────────────────

class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args: Any) -> None:  # noqa: D102 - silence the server
        pass


class _Server:
    """Serve one case directory over localhost for the duration of a replay."""

    def __init__(self, root: Path):
        handler = functools.partial(_QuietHandler, directory=str(root))
        socketserver.TCPServer.allow_reuse_address = True
        self.httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self) -> "_Server":
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:
            pass

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/recovery_page.html"


# ── grade ────────────────────────────────────────────────────────────────────

def grade(verdict: dict[str, Any] | None, expected: list[str]) -> dict[str, Any]:
    """Precision/recall over the field ids the agent named.

    The agent writes free text into fixed[]/unfixable[], so an id counts as named
    when it appears anywhere in those strings — the skill asks for ids explicitly,
    and substring matching keeps a correct answer from being graded wrong over
    phrasing.
    """
    verdict = verdict or {}
    blob = " ".join(
        str(item) for item in
        [*(verdict.get("fixed") or []), *(verdict.get("unfixable") or []), verdict.get("notes") or ""]
    )
    named = [fid for fid in expected if fid and fid in blob]
    missed = [fid for fid in expected if fid not in named]
    recall = len(named) / len(expected) if expected else None
    return {
        "expected": expected,
        "named": named,
        "missed": missed,
        "recall": round(recall, 3) if recall is not None else None,
        "outcome": verdict.get("outcome"),
    }


# ── run ──────────────────────────────────────────────────────────────────────

async def _probe_drivable(page: Any, focus: dict[str, Any]) -> bool:
    """A frozen React page has no JS bundle — its controls may be inert. Try to
    set the first dossier control and see whether the DOM accepts it."""
    controls = focus.get("controls") or []
    if not controls:
        return False
    selector = str(controls[0].get("selector") or "")
    if not selector:
        return False
    try:
        return bool(await page.evaluate(
            """(sel) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                if (!('value' in el)) return Boolean(el.querySelector('input, select, [role="combobox"]'));
                const before = el.value;
                el.value = '__probe__';
                const ok = el.value === '__probe__';
                el.value = before;
                return ok;
            }""", selector))
    except Exception:
        return False


async def run_case(case_dir: Path, *, probe_only: bool = False, timeout_s: float | None = None) -> dict[str, Any]:
    from playwright.async_api import async_playwright

    try:
        from job_application_automator.browser_cdp import open_cdp_page
    except ImportError:
        from browser_cdp import open_cdp_page

    case = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    focus = json.loads((case_dir / "recovery_focus.json").read_text(encoding="utf-8")) \
        if (case_dir / "recovery_focus.json").is_file() else {"focus_mode": "blind", "controls": []}
    context = json.loads((case_dir / "recovery_context.json").read_text(encoding="utf-8"))
    log = FillLog("replay", case.get("job_id") or case_dir.name, case_dir)
    started = time.monotonic()
    row: dict[str, Any] = {"case": case_dir.name, "trigger_status": case.get("trigger_status")}

    with _Server(case_dir) as server:
        async with async_playwright() as playwright:
            session = await open_cdp_page(playwright, logger=log)
            try:
                await session.page.goto(server.url, wait_until="domcontentloaded")
                marker = f"[replay-{int(time.time()) % 100000}]"
                await session.page.evaluate(
                    "(m) => { document.title = m + ' ' + document.title; }", marker)
                row["drivable"] = await _probe_drivable(session.page, focus)
                if probe_only:
                    case["drivable"] = row["drivable"]
                    (case_dir / "case.json").write_text(json.dumps(case, indent=2), encoding="utf-8")
                    return row

                # Same prompt assembly and argv as production, with the frozen
                # page substituted for the live tab.
                replay_context = {**context, "tab_marker": marker,
                                  "current_tab_url": server.url, "apply_url": server.url}
                (case_dir / "recovery_context.replay.json").write_text(
                    json.dumps(replay_context, indent=2, ensure_ascii=False), encoding="utf-8")
                system, skill_rev = ar.load_skill("SKILL.md", ar.RECOVERY_SYSTEM)
                (case_dir / "recovery_schema.json").write_text(
                    json.dumps(ar.VERDICT_SCHEMA, indent=2), encoding="utf-8")
                argv = ar._build_codex_argv(case_dir)
                if argv is None:
                    row["error"] = "codex binary not found on PATH"
                    return row
                prompt = f"{system}\n\n--- CONTEXT ---\n{json.dumps(replay_context, ensure_ascii=False)}"
                metrics = ar.AgentMetrics()
                await asyncio.wait_for(
                    ar._run_codex_streaming(argv, prompt, case_dir, log, metrics),
                    timeout=timeout_s or ar._timeout_s(),
                )
                verdict = ar._parse_verdict(case_dir)
                row["skill_rev"] = skill_rev
                row["grade"] = grade(verdict, case.get("expected_field_ids") or [])
                row.update({k: v for k, v in metrics.as_dict().items()})
            finally:
                await session.cleanup()
    row["duration_s"] = round(time.monotonic() - started, 1)
    (case_dir / "replay_result.json").write_text(json.dumps(row, indent=2), encoding="utf-8")
    return row


def _summarize(rows: list[dict[str, Any]]) -> str:
    graded = [r for r in rows if r.get("grade")]
    if not graded:
        return "no graded cases"
    recalls = [r["grade"]["recall"] for r in graded if r["grade"]["recall"] is not None]
    tokens = [(r.get("usage") or {}).get("uncached_input_tokens", 0) for r in graded]
    snaps = [(r.get("tools") or {}).get("snapshot", 0) for r in graded]
    durs = [r.get("duration_s", 0) for r in graded]
    mean = lambda xs: round(sum(xs) / len(xs), 2) if xs else 0
    return "\n".join([
        f"cases graded            {len(graded)}",
        f"field-id recall (mean)  {mean(recalls)}",
        f"uncached input (mean)   {mean(tokens):,.0f}",
        f"snapshot calls (mean)   {mean(snaps)}",
        f"duration s (mean)       {mean(durs)}",
    ])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="harvest frozen cases out of the job-automator home")
    b.add_argument("--home", type=Path, default=default_home())
    b.add_argument("--out", type=Path, default=DEFAULT_CORPUS)
    b.add_argument("--limit", type=int, default=40)

    r = sub.add_parser("run", help="replay one case or the whole corpus")
    r.add_argument("--case", type=Path, default=None)
    r.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    r.add_argument("--all", action="store_true")
    r.add_argument("--probe", action="store_true", help="only check whether the frozen page is drivable")
    r.add_argument("--timeout", type=float, default=None)

    args = parser.parse_args()
    if args.cmd == "build":
        return build(args.home, args.out, args.limit)

    cases = [args.case] if args.case else sorted(
        d for d in args.corpus.glob("*") if (d / "case.json").is_file())
    if not cases:
        print(f"no cases under {args.corpus} — run `build` first")
        return 1
    if not args.all and not args.case:
        cases = cases[:1]

    rows = []
    for case_dir in cases:
        try:
            row = asyncio.run(run_case(case_dir, probe_only=args.probe, timeout_s=args.timeout))
        except Exception as exc:
            row = {"case": case_dir.name, "error": f"{type(exc).__name__}: {exc}"}
        rows.append(row)
        print(json.dumps(row, indent=1)[:900])
    print("\n" + _summarize(rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
