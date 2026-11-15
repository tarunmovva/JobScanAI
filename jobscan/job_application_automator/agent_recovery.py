#!/usr/bin/env python3
"""AI recovery pass for failed form fills.

When a deterministic filler ends in a recoverable failure (validation error,
unanswered conditional field, unconfirmed submit...), this module drives a
Codex CLI agent armed with Playwright MCP attached over CDP to the SAME
shared Chrome that holds the failed tab. The agent diagnoses the page, fixes
only what is wrong using the payload answers, submits, and reports a
structured verdict. The filler then re-runs its own submission detector —
only a detector-confirmed "submitted" flips the result.

Recoveries run fully parallel: each failing filler spawns its own codex exec
process with its own playwright-mcp instance, mirroring how the fillers
themselves share one CDP Chrome. The prompt pins each agent to its own tab.

Environment:
    JOB_AUTOMATOR_AI_RECOVERY=0        disable (default: enabled)
    JOB_AUTOMATOR_RECOVERY_TIMEOUT     seconds per attempt (default 720)
    JOB_AUTOMATOR_RECOVERY_MODEL      codex -m override (default: config.toml)
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import re
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

try:
    from job_application_automator.browser_cdp import CDP_ENDPOINT
    from job_application_automator.fill_logging import FillLog
    from job_application_automator.runtime_support import submit_enabled
    from job_application_automator.submission_signals import posting_gone
    from job_application_automator import tab_tag
    from job_application_automator.recovery_focus import (
        AgentMetrics, build_context, build_focus, context_bytes, load_skill,
    )
except ImportError:
    from browser_cdp import CDP_ENDPOINT
    from fill_logging import FillLog
    from runtime_support import submit_enabled
    from submission_signals import posting_gone
    import tab_tag  # type: ignore
    from recovery_focus import (
        AgentMetrics, build_context, build_focus, context_bytes, load_skill,
    )

RECOVERY_PROMPT_REV = "8"
PLAYWRIGHT_MCP_VERSION = "0.0.78"
DEFAULT_TIMEOUT_S = 720

# asyncio gives a subprocess StreamReader a 64KiB line limit by default, and a
# codex --json event carrying a tool result or a file read blows straight past it
# ("ValueError: Separator is found, but chunk is longer than limit"). Raising the
# limit keeps those events parseable; the reader also survives anything bigger.
STREAM_LIMIT_BYTES = 32 * 1024 * 1024

# Statuses worth handing to the agent, per platform. Everything else either
# cannot be fixed in-page (captcha, otp, closed tab) or must not be retried
# (duplicate_application).
RECOVERABLE_STATUSES: dict[str, frozenset[str]] = {
    "ashby": frozenset({"verification_failed", "not_confirmed", "submit_button_not_found"}),
    "lever": frozenset({"validation_failed", "not_confirmed", "submit_button_not_found",
                        "api_failed", "blocked_captcha"}),
    # blocked_captcha_puzzle is deliberately absent from every fix set below: the
    # form is already complete and only a person can clear the challenge, so a
    # recovery attempt costs ~2 minutes and ~64k tokens to re-report what the
    # detector already knows.
    # blocked_captcha is fix-mode: a checkbox captcha is one click away from a
    # submission; the prompt tells the agent to leave puzzle challenges alone.
    "greenhouse": frozenset({"validation_errors", "clicked", "submit_not_found", "blocked_captcha"}),
}

# Failures the agent cannot fix but CAN explain: it inspects the marked tab
# read-only and reports why the fill failed (OTP email never arrived vs code
# rejected...). Never flips the status.
DIAGNOSE_STATUSES: dict[str, frozenset[str]] = {
    "ashby": frozenset(),
    # blocked_captcha_puzzle is in NEITHER set. Diagnose mode looked worth having
    # — a read-only explanation naming the vendor — but measuring it killed the
    # idea: the recorded runs spent minutes to report "Submission is blocked by an
    # active hCaptcha", which is exactly what the status already says. There is
    # nothing left to find out, so the run is skipped entirely.
    "lever": frozenset(),
    "greenhouse": frozenset({
        "otp_required", "otp_timeout",
        "otp_unavailable", "otp_failed", "otp_rejected",
    }),
}

VERDICT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "outcome": {"type": "string", "enum": ["submitted", "failed", "gave_up"]},
        "tab_url": {"type": "string"},
        "fixed": {"type": "array", "items": {"type": "string"}},
        "inferred": {"type": "array", "items": {"type": "string"}},
        "unfixable": {"type": "array", "items": {"type": "string"}},
        "notes": {"type": "string"},
    },
    "required": ["outcome", "tab_url", "fixed", "inferred", "unfixable", "notes"],
    "additionalProperties": False,
}

DIAGNOSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "outcome": {"type": "string", "enum": ["diagnosed", "gave_up"]},
        "tab_url": {"type": "string"},
        "diagnosis": {"type": "string"},
        "evidence": {"type": "array", "items": {"type": "string"}},
        "remedy": {"type": "string"},
    },
    "required": ["outcome", "tab_url", "diagnosis", "evidence", "remedy"],
    "additionalProperties": False,
}

# FALLBACK ONLY. The live procedure is skills/recovery-triage/SKILL.md, loaded by
# load_skill(); these literals are used when that file is missing from a trimmed
# package, and the run then records skill_rev="fallback" rather than pretending
# nothing changed.
RECOVERY_SYSTEM = """You are a job-application completion agent. A deterministic form filler
partially filled a job application in an already-open browser tab and stopped. Your mission:
complete this application and submit it — a submitted application is success. You have
Playwright browser tools attached to a shared browser; other agents work in other tabs.

WORKFLOW:
1. Prefer mcp__formtools__* — those tools already resolve your tab and never act on another.
   Only if you fall back to browser tools: list the open tabs and select the one whose TITLE
   begins with tab_marker from the context. Several tabs may share the application URL, but
   only yours carries that code — tabs from earlier attempts read [FAIL] or [YOU!]. Work
   exclusively inside that tab. When no tab title carries the marker, finish with
   outcome "gave_up".
2. Call mcp__formtools__form_state. It reports every control the page marks invalid with its message,
   the submit buttons, whether a confirmation is already showing, and whether a CAPTCHA
   is blocking — the same picture as a snapshot for a twentieth of the tokens. Use it
   instead of browser_snapshot unless it returns something you cannot act on. When it
   reports a confirmation, finish with outcome "submitted".
2b. Repair with mcp__formtools__fill_fields: pass every id and value in ONE call. It sets text, select,
   checkbox, radio and typeahead controls and reads each value back, so an option that
   was clicked but did not commit comes back ok:false rather than looking fixed. Fall
   back to the browser tools only for what it reports it could not do.
2c. Submit with mcp__formtools__submit_and_verify, which clicks and then reports what the page became.
   Read its result: it does not decide success for you.
   Three calls are the whole job on a
   normal form. Reach for snapshot/click/type only when those are not enough.
3. Complete every field that is wrong, cleared, or missing — including newly revealed
   conditional questions, dropdown selections, consent boxes, and file uploads. Source each
   answer in this order:
   a. the provided answers,
   b. the candidate_profile (work authorization, sponsorship, clearance, salary, EEO),
   c. the resume_text (education, employers, titles, dates, skills, locations),
   d. the job_context (title, company, description),
   e. INFERENCE — when the data above is silent, choose the highest-probability answer that
      fits everything you know about this candidate and this job, fill it, and continue.
   Give every required field a value. List each inferred value in "inferred" so it can be
   reviewed later.
4. Typeahead dropdowns show only a sample of their full option list — type the real value
   into the control to search the complete list, then select the matching option.
5. For file fields, upload from the absolute path given in the answers.
6. When an "I'm not a robot" checkbox captcha is present, click the checkbox, wait for it to
   pass, and continue. When a picture or puzzle challenge appears, finish with outcome
   "failed" and note "captcha_puzzle" — a human completes it in the open tab.
7. Click Submit once, wait for the page to settle, and verify success: confirmation text,
   the form disappearing, or a URL change. Re-check the page state before any further click.
   When the page reports this candidate already applied, finish with outcome "gave_up".

Your FINAL message must be JSON matching the required schema:
{"outcome": "submitted"|"failed"|"gave_up", "tab_url": "<url of the tab you worked on>",
 "fixed": ["<what you fixed>"], "inferred": ["<answers you inferred>"],
 "unfixable": ["<fields impossible to complete>"], "notes": "<short summary>"}
"""

OTP_LOCK_ADDENDUM = """
GREENHOUSE VERIFICATION (the acquire_otp_lock tool is available):
- Immediately before clicking Submit, call the acquire_otp_lock tool and wait for it to
  succeed — other applications share the same verification mailbox, so it may take a moment.
  A successful acquire_otp_lock call is your green light to click Submit.
- When acquire_otp_lock returns an error, finish with outcome "failed" and note
  "lock_unavailable".
- When an email-verification / security-code screen appears after your submit, finish with
  outcome "failed" and note "otp_pending" — the system completes the verification step
  automatically after you finish.
"""

# FALLBACK ONLY — see skills/recovery-triage/DIAGNOSE.md.
RECOVERY_DIAGNOSE_SYSTEM = """You are a job-application failure INSPECTOR. A form filler failed on
a job application in an ALREADY-OPEN browser tab for a reason that cannot be auto-fixed (captcha,
OTP email verification...). Your ONLY job is to look at the page and explain precisely WHY the
fill failed. You have Playwright browser tools attached to a SHARED browser where OTHER agents
are working in OTHER tabs concurrently.

HARD RULES:
1. Prefer mcp__formtools__*, which resolve your tab for you. Falling back to browser tools:
   list the open tabs and select ONLY the one whose TITLE begins with the tab_marker string
   given in the context. Duplicate tabs of the same URL may exist — the URL alone is NOT
   sufficient. If no tab title carries the marker, STOP and report outcome "gave_up".
   NEVER interact with, close, or create any other tab.
2. READ-ONLY: take snapshots and read the page. NEVER fill a field, click a button, submit,
   or navigate. You are an observer.
3. Diagnose using the snapshot plus the failure report in the context (it includes the filler's
   own submission/OTP details): which captcha vendor and whether a challenge is actually visible;
   whether OTP inputs are present and whether the failure was the email never arriving vs the
   code being rejected; visible validation banners; disabled submit buttons; closed posting
   notices — the concrete root cause, not a guess.
4. Give a practical remedy (e.g. "solve the captcha manually in the open tab and click Submit",
   "check the IMAP inbox credentials — no code email arrived within the timeout").

Your FINAL message must be JSON matching the required schema:
{"outcome": "diagnosed"|"gave_up", "tab_url": "<url of the tab you inspected>",
 "diagnosis": "<why the fill failed>", "evidence": ["<what you saw>"], "remedy": "<what the user should do>"}
"""


def _enabled() -> bool:
    return os.environ.get("JOB_AUTOMATOR_AI_RECOVERY", "1") != "0"


def _timeout_s() -> float:
    try:
        return float(os.environ.get("JOB_AUTOMATOR_RECOVERY_TIMEOUT", DEFAULT_TIMEOUT_S))
    except ValueError:
        return DEFAULT_TIMEOUT_S


def _resolve_codex() -> list[str] | None:
    """Resolve codex into an argv prefix.

    JOB_AUTOMATOR_CODEX_BIN wins when set: the app passes down the Codex it
    runs itself (the user's own CLI, or a copy an earlier JobScan downloaded),
    so recovery runs on the SAME binary as the app-server side. Falling through to PATH
    would silently split the two surfaces across versions — and a version skew
    only shows up when a fill fails, which is the worst time to discover it.

    On Windows `shutil.which` finds the npm `.cmd` shim, but `cmd /c` mangles
    multiline/quoted arguments (the prompt dies at the first newline), so
    prefer the native binary inside the npm package, then `node codex.js`,
    and use the shim only as a last resort.
    """
    pinned = os.environ.get("JOB_AUTOMATOR_CODEX_BIN", "").strip()
    if pinned and Path(pinned).is_file():
        return [pinned]

    found = shutil.which("codex")
    if not found:
        return None
    if not found.lower().endswith((".cmd", ".bat")):
        return [found]

    pkg = Path(found).parent / "node_modules" / "@openai" / "codex"
    if pkg.is_dir():
        # The binary moved from vendor/<triple>/codex/ to vendor/<triple>/bin/ in 0.153.
        for sub in ("bin", "codex"):
            for exe in sorted(pkg.glob(f"node_modules/@openai/codex-*/vendor/*/{sub}/codex.exe")):
                return [str(exe)]
        cli = pkg / "bin" / "codex.js"
        node = shutil.which("node")
        if cli.exists() and node:
            return [node, str(cli)]
    return ["cmd", "/c", found]


def _resolve_playwright_mcp() -> list[str] | None:
    """Direct `node cli.js` launch of the pinned playwright-mcp. Concurrent
    `npx` starts contend on the npm cache and can blow codex's MCP startup
    window, which silently drops the server — the agent then runs toolless."""
    node = shutil.which("node")
    if not node:
        return None
    candidates: list[Path] = []
    appdata = os.environ.get("APPDATA", "")
    if appdata:
        candidates.append(Path(appdata) / "npm" / "node_modules" / "@playwright" / "mcp")
    localappdata = os.environ.get("LOCALAPPDATA", "")
    if localappdata:
        candidates.extend(sorted(Path(localappdata).glob("npm-cache/_npx/*/node_modules/@playwright/mcp")))
    for pkg in candidates:
        cli = pkg / "cli.js"
        manifest = pkg / "package.json"
        if not (cli.exists() and manifest.exists()):
            continue
        try:
            version = json.loads(manifest.read_text(encoding="utf-8")).get("version")
        except Exception:
            continue
        if version == PLAYWRIGHT_MCP_VERSION:
            return [node, str(cli)]
    return None


def _mcp_args() -> list[str]:
    """playwright-mcp server command — attach to the shared CDP Chrome."""
    server_args = ["--cdp-endpoint", CDP_ENDPOINT, "--allow-unrestricted-file-access"]
    resolved = _resolve_playwright_mcp()
    if resolved:
        return [*resolved, *server_args]
    npx = ["npx", "-y", f"@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}", *server_args]
    if os.name == "nt":
        return ["cmd", "/c", *npx]
    return npx


def _toml_str_array(items: list[str]) -> str:
    return "[" + ",".join(json.dumps(i) for i in items) + "]"


# The cheapest model that can drive a form. Recovery used to pass no -m at all,
# so every run fell through to whatever codex config.toml pinned -- which
# can be the most expensive model, while the app itself was
# deliberately set to the cheapest. At a mean 286k input tokens per run that is
# the single largest cost in the whole recovery path, and nothing surfaced it:
# the model never appeared in a log line.
DEFAULT_RECOVERY_MODEL = "gpt-5.6-luna"


def _recovery_model() -> str:
    """Which model to run the agent on.

    Precedence: the explicit env override, then the model the user chose in the
    app, then the cheapest known. Never silently inherits config.toml.
    """
    explicit = os.environ.get("JOB_AUTOMATOR_RECOVERY_MODEL", "").strip()
    if explicit:
        return explicit
    # The app writes its choice here; the Python side is often launched by it.
    try:
        appdata = os.environ.get("APPDATA")
        if appdata:
            cfg = Path(appdata) / "jobscan-app" / "config.json"
            if cfg.is_file():
                chosen = str(json.loads(cfg.read_text(encoding="utf-8")).get("codexModel") or "").strip()
                if chosen:
                    return chosen
    except Exception:
        pass
    return DEFAULT_RECOVERY_MODEL


def _build_codex_argv(
    output_dir: Path,
    otp_lock: dict[str, Any] | None = None,
    form_tools: dict[str, Any] | None = None,
) -> list[str] | None:
    codex = _resolve_codex()
    if not codex:
        return None
    mcp = _mcp_args()
    argv = [
        *codex, "exec",
        "--skip-git-repo-check", "--ephemeral", "--color", "never", "--json",
        "--sandbox", "read-only",
        "-C", str(output_dir),
        "-c", f"mcp_servers.playwright.command={json.dumps(mcp[0])}",
        "-c", f"mcp_servers.playwright.args={_toml_str_array(mcp[1:])}",
        # Non-interactive runs cannot answer approval prompts; this per-server
        # mode auto-approves ONLY the playwright server's tools.
        "-c", 'mcp_servers.playwright.default_tools_approval_mode="approve"',
        # Codex silently drops MCP servers that miss its startup window
        # (default 10s) — under parallel recoveries the browser attach can
        # exceed it, leaving the agent toolless.
        "-c", "mcp_servers.playwright.startup_timeout_sec=90",
        # codex >= 0.125 defers MCP tools behind a tool_search step; agents
        # that don't search conclude "no browser tools" and give up. Force
        # direct tool injection.
        "-c", "features.tool_search=false",
        "-c", 'model_reasoning_effort="medium"',
        "--output-schema", str(output_dir / "recovery_schema.json"),
        "-o", str(output_dir / "recovery_verdict.json"),
    ]
    if otp_lock:
        # Second MCP server: the mailbox-lock tool the agent must call right
        # before clicking Submit on Greenhouse (see OTP_LOCK_ADDENDUM).
        lock_args = [
            "-m", "job_application_automator.otp_lock_mcp",
            "--mailbox-key", str(otp_lock["mailbox_key"]),
            "--grant-out", str(otp_lock["grant_path"]),
            "--imap-config", str(otp_lock["imap_config"]),
            "--timeout", str(otp_lock.get("timeout_s", 300)),
            "--stale", str(otp_lock.get("stale_s", 1800)),
            "--job-id", str(otp_lock.get("job_id", "")),
        ]
        if otp_lock.get("lock_dir"):
            lock_args += ["--lock-dir", str(otp_lock["lock_dir"])]
        argv += [
            "-c", f"mcp_servers.otplock.command={json.dumps(sys.executable or 'python')}",
            "-c", f"mcp_servers.otplock.args={_toml_str_array(lock_args)}",
            "-c", f"mcp_servers.otplock.cwd={json.dumps(str(otp_lock['pkg_root']))}",
            "-c", "mcp_servers.otplock.tool_timeout_sec=330",
            "-c", "mcp_servers.otplock.startup_timeout_sec=90",
            "-c", 'mcp_servers.otplock.default_tools_approval_mode="approve"',
        ]
    if form_tools:
        # Third MCP server: form_state / fill_fields / submit_and_verify.
        # Measured against the recorded history, the agent spent 7.3s per tool
        # call and browser_snapshot alone was 51% of all tool output at ~1,120
        # tokens a call; form_state is the same information in ~105. The
        # playwright server stays attached -- these three cover the common
        # path, not navigation or anything unusual.
        ft_args = [
            "-m", "job_application_automator.form_tools_mcp",
            "--tab-marker", str(form_tools.get("tab_marker") or ""),
            "--tab-id", str(form_tools.get("tab_id") or ""),
            "--cdp-url", str(form_tools.get("cdp_url") or "http://127.0.0.1:9222"),
        ]
        if form_tools.get("upload_resume") is not None:
            # Same upload rule as the fillers (upload_guard): the résumé, or
            # files written into this job's own folder -- nothing else.
            ft_args += [
                "--upload-resume", str(form_tools.get("upload_resume") or ""),
                "--upload-root", str(form_tools.get("upload_root") or ""),
            ]
        argv += [
            "-c", f"mcp_servers.formtools.command={json.dumps(sys.executable or 'python')}",
            "-c", f"mcp_servers.formtools.args={_toml_str_array(ft_args)}",
            "-c", f"mcp_servers.formtools.cwd={json.dumps(str(form_tools['pkg_root']))}",
            "-c", "mcp_servers.formtools.tool_timeout_sec=120",
            "-c", "mcp_servers.formtools.startup_timeout_sec=90",
            "-c", 'mcp_servers.formtools.default_tools_approval_mode="approve"',
        ]

    # Always explicit. An unset -m inherits config.toml, which is how every
    # recovery run ended up on the most expensive available model.
    argv += ["-m", _recovery_model()]
    # Prompt is fed via stdin ("-" sentinel): real contexts are 20k+ chars and
    # blow the Windows 32k command-line limit (WinError 206) as an argument.
    argv.append("-")
    return argv


def _kill_tree(proc: asyncio.subprocess.Process) -> None:
    """Kill codex and its npx/node MCP children — a plain kill orphans them."""
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                capture_output=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        else:
            proc.kill()
    except Exception:
        pass


def _parse_verdict(output_dir: Path) -> dict[str, Any] | None:
    path = output_dir / "recovery_verdict.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("outcome") not in (
        "submitted", "failed", "gave_up", "diagnosed",
    ):
        return None
    return data


_NO_TOOLS_RE = re.compile(
    r"no playwright"
    r"|tools?\b[^.]{0,60}\b(?:not (?:available|exposed)|unavailable)"
    r"|not available in th(?:is|e) tool"
    r"|without the required playwright",
    re.IGNORECASE,
)


def _verdict_reports_no_tools(verdict: dict[str, Any] | None) -> bool:
    """True when the agent says its MCP tools never showed up — a codex
    startup drop, not a form problem. Only consulted on failed outcomes."""
    if not verdict or verdict.get("outcome") == "submitted" or verdict.get("fixed"):
        return False
    blob = " ".join(
        [*(str(item) for item in verdict.get("unfixable") or []), str(verdict.get("notes") or "")]
    )
    return bool(_NO_TOOLS_RE.search(blob))


def _log_event(raw_line: str, log: FillLog, metrics: AgentMetrics | None = None) -> None:
    """Surface the interesting codex --json events as live log lines, and feed the
    metrics collector on the way past — token/tool cost is otherwise unrecoverable
    once the stream is consumed."""
    try:
        event = json.loads(raw_line)
    except Exception:
        return
    if metrics is not None:
        metrics.observe(event)
    etype = event.get("type")
    item = event.get("item") or {}
    if etype == "item.started" and item.get("type") == "mcp_tool_call":
        log("agent.tool", tool=item.get("tool"),
            args=json.dumps(item.get("arguments") or {}, ensure_ascii=False)[:120])
    elif etype == "item.completed":
        if item.get("type") == "mcp_tool_call" and item.get("error"):
            log("agent.tool.error", tool=item.get("tool"),
                message=(item.get("error") or {}).get("message"))
        elif item.get("type") == "agent_message":
            log("agent.note", text=(item.get("text") or "")[:200])
    elif etype == "turn.completed":
        usage = event.get("usage") or {}
        log("agent.usage", input_tokens=usage.get("input_tokens"),
            output_tokens=usage.get("output_tokens"))
    elif etype == "error":
        log("agent.error", message=str(event.get("message"))[:200])


async def _run_codex_streaming(
    argv: list[str], prompt: str, output_dir: Path, log: FillLog,
    metrics: AgentMetrics | None = None,
) -> int | None:
    """Run codex exec, feeding the prompt on stdin and streaming --json events:
    every raw line is persisted to recovery_events.jsonl; highlights are logged
    live. Kills the whole process tree on timeout/cancel."""
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        creationflags=creationflags,
        limit=STREAM_LIMIT_BYTES,
    )

    async def drive() -> None:
        try:
            proc.stdin.write(prompt.encode("utf-8"))
            await proc.stdin.drain()
            proc.stdin.close()
        except (BrokenPipeError, ConnectionResetError):
            pass
        events_path = output_dir / "recovery_events.jsonl"
        oversized = 0
        with events_path.open("a", encoding="utf-8") as fh:
            while True:
                try:
                    line = await proc.stdout.readline()
                except ValueError:
                    # One event exceeded the stream limit. readline() has already
                    # dropped it from the buffer, so reading resumes cleanly at
                    # the next event — losing one line beats losing the session,
                    # which is what happened when a 63KB command_execution result
                    # blew the 64KiB default and aborted a live recovery.
                    oversized += 1
                    log("agent.event.oversized", dropped=oversized, limit=STREAM_LIMIT_BYTES)
                    continue
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").rstrip()
                if not text:
                    continue
                fh.write(text + "\n")
                _log_event(text, log, metrics)
        await proc.wait()

    try:
        await asyncio.wait_for(drive(), timeout=_timeout_s())
    except (asyncio.TimeoutError, asyncio.CancelledError):
        _kill_tree(proc)
        raise
    finally:
        if proc.returncode is None:
            _kill_tree(proc)
    return proc.returncode


def _enrich_failure(result: dict[str, Any], verdict: dict[str, Any] | None, mode: str) -> None:
    """Put the agent's explanation where the user will see it: appended to
    submission.reason (flows to the app's Done-screen message untouched) and
    as an _ai_diagnosis entry in errors[] (rendered into the .md record)."""
    v = verdict or {}
    if mode == "diagnose":
        why = str(v.get("diagnosis") or "").strip()
        remedy = str(v.get("remedy") or "").strip()
        entry = why + (f" | remedy: {remedy}" if remedy else "")
    else:
        notes = str(v.get("notes") or "").strip()
        unfixable = "; ".join(str(u) for u in (v.get("unfixable") or []))
        inferred = "; ".join(str(i) for i in (v.get("inferred") or []))
        why = notes or unfixable
        entry = notes + (f" | inferred: {inferred}" if inferred else "") + (
            f" | unfixable: {unfixable}" if unfixable else "")
    if not why:
        return
    submission = result.get("submission")
    if isinstance(submission, dict):
        base = str(submission.get("reason") or "").strip()
        addition = f"AI: {why}"[:220]
        submission["reason"] = f"{base} — {addition}" if base else addition
    result.setdefault("errors", []).append({"id": "_ai_diagnosis", "error": entry[:400]})


def _extract_resume_text(answers: dict[str, Any], max_chars: int = 16000) -> str:
    """Pull the candidate's resume text from the file path embedded in answers,
    so the agent can truthfully answer resume-derivable questions (education,
    employers...) the payload left blank."""
    for value in answers.values():
        if not isinstance(value, str) or not value.strip():
            continue
        path = Path(value)
        try:
            if not (path.suffix.lower() in (".pdf", ".txt") and path.is_file()):
                continue
        except OSError:
            continue
        try:
            if path.suffix.lower() == ".txt":
                return path.read_text(encoding="utf-8", errors="replace")[:max_chars]
            from PyPDF2 import PdfReader

            reader = PdfReader(str(path))
            text = "\n".join((page.extract_text() or "") for page in reader.pages)
            return text[:max_chars]
        except Exception:
            return ""
    return ""


def _write_context(
    output_dir: Path,
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
) -> tuple[Path, dict[str, int]]:
    """Write the trimmed prompt context plus its full sidecar.

    The prompt used to carry the whole form and the whole resume — 43% of the
    median context was resume_text and another 42% was fields+answers, for a
    failure that typically touches one control. Everything dropped here is still
    on disk in recovery_context_full.json, which the skill tells the agent to read
    when the dossier is not enough.
    """
    context, full_context = build_context(
        platform=platform,
        apply_url=apply_url,
        page_url=page_url,
        page_title=page_title,
        marker=marker,
        payload=payload,
        failure=failure,
        resume_text=resume_text,
        focus=focus,
    )
    (output_dir / "recovery_focus.json").write_text(
        json.dumps(focus, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (output_dir / "recovery_context_full.json").write_text(
        json.dumps(full_context, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (output_dir / "recovery_resume.txt").write_text(resume_text or "", encoding="utf-8")
    path = output_dir / "recovery_context.json"
    path.write_text(json.dumps(context, indent=2, ensure_ascii=False), encoding="utf-8")
    return path, context_bytes(context)


async def _posting_is_gone(page: Any) -> str:
    """The page text says this posting no longer exists, or "" if it looks live.

    Checked BEFORE spending an agent turn. A dead posting is the single
    remaining reason a recovery run fails on current code: 5 of the 6
    non-captcha failures since 2026-09-07 were 404s, each costing 20-150s for
    the agent to reach the conclusion the page states in plain text.
    """
    try:
        body = await page.evaluate(
            "() => (document.body && document.body.innerText || '').slice(0, 1500)"
        )
    except Exception:
        # No page, no judgement. Staying silent hands the case to the agent,
        # which is the pre-existing behaviour.
        return ""
    return posting_gone(body)



async def attempt_recovery(
    *,
    platform: str,
    apply_url: str,
    payload: dict[str, Any],
    result: dict[str, Any],
    output_dir: Path,
    failure: dict[str, Any],
    page: Any,
    detect: Callable[[], Awaitable[bool]],
    log: FillLog | None = None,
    otp_lock: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Run one AI recovery attempt. Two modes, chosen by failure status:
    "fix" tries to repair and submit (detector-confirmed only); "diagnose"
    inspects read-only and explains why the fill failed. Returns a
    confirmed-submitted submission dict, or None (original failure stands,
    possibly with an enriched reason). Never raises."""
    status = str(failure.get("status") or "")
    if log is None:
        log = FillLog(platform, "", output_dir)

    def _skip(reason: str) -> None:
        result["recovery"] = {"attempted": False, "skipped": reason, "trigger_status": status}
        log("recovery.skip", reason=reason)

    if not _enabled():
        _skip("disabled via JOB_AUTOMATOR_AI_RECOVERY=0")
        return None
    # The recovery agent submits the application ITSELF — its whole mission is
    # "complete this application and submit it". A filler-level submit gate does
    # not contain it: ashby calls attempt_recovery from two places, one of them
    # BEFORE its submit block, so a fill-only run still sent a real application.
    # The gate has to live here, at the single choke point every platform shares.
    if not submit_enabled():
        _skip("JOB_AUTOMATOR_SUBMIT=0 — recovery would submit the application")
        return None
    # A posting that no longer exists cannot be applied to by anyone. The
    # agent reliably works this out -- and charges 20-150s of wall clock and a
    # full turn of tokens to report what the page says in its first line.
    gone = await _posting_is_gone(page)
    if gone:
        _skip(f"posting is gone: {gone!r}")
        result["submission"] = {"status": "posting_closed",
                                "reason": f"posting is gone: {gone!r}"}
        return None

    if status in RECOVERABLE_STATUSES.get(platform, frozenset()):
        mode = "fix"
    elif status in DIAGNOSE_STATUSES.get(platform, frozenset()):
        mode = "diagnose"
    else:
        _skip(f"status {status!r} not recoverable or diagnosable")
        return None

    # Data floor for fix mode: with zero candidate data (broken/ancient payload)
    # the completion-first inference has nothing to infer FROM — an agent run
    # would fabricate an identity. Diagnose mode is read-only and exempt.
    resume_text = _extract_resume_text(payload.get("answers", {}))
    if mode == "fix" and not payload.get("answers") and not resume_text and not payload.get("candidate_profile"):
        _skip("no candidate data (empty answers/resume/profile) — refusing to infer an application from nothing")
        return None

    try:
        page_url = page.url
    except Exception:
        page_url = apply_url
    page_title = ""
    try:
        page_title = await page.title()
    except Exception:
        pass

    # Tell this tab apart from stale duplicates of the same job -- earlier
    # failed attempts leave their tabs open by design, so URL matching alone is
    # ambiguous.
    #
    # Identity is a window property, read back from the tab itself. It used to
    # be a prefix on document.title, which made the title load-bearing: once the
    # tab carried a user-facing label that re-asserted itself, the marker was
    # wiped within 700ms and this lookup failed for the whole run. The property
    # is set from an init script, so unlike a title it also survives navigation.
    tab_id = await tab_tag.read_tab_id(page)

    # The label the user sees while the agent works. Stale tabs from earlier
    # attempts read [FAIL] or [YOU!], so the code alone separates this tab from
    # them in the strip -- and in the agent's own browser-tab fallback.
    await tab_tag.apply_stage(page, "fix")
    marker = f"[{tab_tag.STAGES['fix']['code']}]"

    # Declared before the try so the timeout/error paths can still report what
    # the run was triggered by and how far it got.
    focus: dict[str, Any] = {}
    ctx_bytes: dict[str, int] = {}
    skill_rev = "unknown"
    metrics = AgentMetrics()
    started = 0.0

    try:
        # The dossier is what lets the agent repair a named selector instead of
        # snapshotting the whole page first — build it while the filler's page is
        # still live, because none of this evidence survives the handoff.
        focus = await build_focus(page, payload, failure)
        # Frozen page for the offline replay corpus (recovery_replay.py). Written
        # unconditionally on the recovery path: the filler's own page.content()
        # dump is gated behind debug_artifacts, which is off in every real run.
        try:
            (output_dir / "recovery_page.html").write_text(
                await page.content(), encoding="utf-8"
            )
        except Exception:
            pass
        _, ctx_bytes = _write_context(
            output_dir,
            platform=platform,
            apply_url=apply_url,
            page_url=page_url,
            page_title=page_title,
            marker=marker,
            payload=payload,
            failure=failure,
            resume_text=resume_text,
            focus=focus,
        )
        schema = DIAGNOSE_SCHEMA if mode == "diagnose" else VERDICT_SCHEMA
        system, skill_rev = load_skill(
            "DIAGNOSE.md" if mode == "diagnose" else "SKILL.md",
            RECOVERY_DIAGNOSE_SYSTEM if mode == "diagnose" else RECOVERY_SYSTEM,
        )
        use_otp_lock = otp_lock if (otp_lock and mode == "fix") else None
        if use_otp_lock:
            system = system + OTP_LOCK_ADDENDUM
            # Stale-grant hygiene: a grant file must only ever describe THIS run.
            try:
                Path(use_otp_lock["grant_path"]).unlink(missing_ok=True)
            except Exception:
                pass
        (output_dir / "recovery_schema.json").write_text(
            json.dumps(schema, indent=2), encoding="utf-8"
        )
        context_text = (output_dir / "recovery_context.json").read_text(encoding="utf-8")
        prompt = f"{system}\n\n--- CONTEXT ---\n{context_text}"

        # The form tools drive the SAME tab the marker identifies, so they
        # need it too. Without a marker they cannot find their tab and the
        # server is left off rather than started to fail on every call.
        tab_marker = str(marker or "")
        form_tools = None
        if tab_marker or tab_id:
            form_tools = {
                "tab_marker": tab_marker,
                "tab_id": str(tab_id or ""),
                "cdp_url": os.environ.get("JOB_AUTOMATOR_CDP_URL", "http://127.0.0.1:9222"),
                "pkg_root": str(Path(__file__).resolve().parent.parent),
            }
            if "resume_path" in payload:
                form_tools["upload_resume"] = str(payload.get("resume_path") or "")
                form_tools["upload_root"] = str(output_dir)

        argv = _build_codex_argv(output_dir, use_otp_lock, form_tools)
        if argv is None:
            _skip("codex binary not found on PATH")
            return None

        log("recovery.launch", mode=mode, status=status, url=apply_url,
            model=_recovery_model(),
            focus_mode=focus.get("focus_mode"), controls=len(focus.get("controls") or []),
            skill_rev=skill_rev, context_bytes=ctx_bytes.get("_total"),
            mcp=" ".join(_mcp_args()[:2]))
        # Marker frees this job's filling slot in the Go submit queue while
        # the agent runs (recovery waits on the model, not the browser).
        marker_path = output_dir / ".recovery_active"
        try:
            marker_path.write_text(str(os.getpid()), encoding="utf-8")
        except Exception:
            pass
        started = time.monotonic()
        no_tools_retries = 0
        try:
            while True:
                returncode = await _run_codex_streaming(argv, prompt, output_dir, log, metrics)
                verdict = _parse_verdict(output_dir)
                # A session whose MCP servers were dropped reports it can't
                # act — one fresh session recovers the infra flake instead of
                # recording a fake fill failure.
                if no_tools_retries == 0 and _verdict_reports_no_tools(verdict):
                    no_tools_retries += 1
                    log("recovery.no_tools", retrying=True)
                    continue
                break
        finally:
            try:
                marker_path.unlink(missing_ok=True)
            except Exception:
                pass
        duration = round(time.monotonic() - started, 1)
        recovery: dict[str, Any] = {
            "attempted": True,
            "mode": mode,
            "prompt_rev": RECOVERY_PROMPT_REV,
            "skill_rev": skill_rev,
            # The trigger status is recorded HERE because fill_result.status is
            # overwritten to "pass" once a recovery confirms — without this, the
            # failure class that a change improved is unrecoverable afterwards.
            "trigger_status": status,
            "trigger_field_ids": [str(c.get("id")) for c in focus.get("controls") or []],
            "focus_mode": focus.get("focus_mode"),
            "duration_s": duration,
            "exit_code": returncode,
            "context_bytes": ctx_bytes,
            **metrics.as_dict(),
            "verdict": verdict,
            "events_path": str(output_dir / "recovery_events.jsonl"),
        }
        if no_tools_retries:
            recovery["no_tools_retries"] = no_tools_retries
        result["recovery"] = recovery

        if verdict and verdict.get("tab_url"):
            mismatch = apply_url.split("?")[0] not in str(verdict["tab_url"])
            recovery["tab_url_mismatch"] = mismatch
            if mismatch:
                log("recovery.tab_mismatch", verdict_tab=verdict["tab_url"])

        if mode == "diagnose":
            # Explanatory only: never flips the status, no detector run.
            recovery["outcome"] = (verdict or {}).get("outcome", "failed")
            _enrich_failure(result, verdict, mode)
            log("recovery.diagnosed", outcome=recovery["outcome"],
                diagnosis=(verdict or {}).get("diagnosis"), duration_s=duration)
            return None

        # Fix mode: the agent's claim is advisory only — the platform's own
        # detector is the sole authority on whether the application went through.
        confirmed = False
        try:
            confirmed = bool(await detect())
        except Exception as exc:
            recovery["detect_error"] = f"{type(exc).__name__}: {exc}"
        recovery["outcome"] = "submitted" if confirmed else (verdict or {}).get("outcome", "failed")

        if confirmed:
            log("recovery.confirmed", duration_s=duration,
                fixed=len((verdict or {}).get("fixed") or []),
                inferred=len((verdict or {}).get("inferred") or []))
            return {"status": "submitted", "reason": "recovered by AI agent"}
        _enrich_failure(result, verdict, mode)
        log("recovery.not_confirmed", agent_said=(verdict or {}).get("outcome"),
            duration_s=duration)
        return None
    except asyncio.TimeoutError:
        result["recovery"] = {"attempted": True, "mode": mode, "outcome": "timeout",
                              "duration_s": round(time.monotonic() - started, 1) if started else None,
                              "timeout_s": _timeout_s(), "trigger_status": status,
                              "focus_mode": focus.get("focus_mode"), "skill_rev": skill_rev,
                              "context_bytes": ctx_bytes, **metrics.as_dict()}
        log("recovery.timeout", timeout_s=_timeout_s())
        return None
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        result["recovery"] = {"attempted": True, "mode": mode, "outcome": "error",
                              "duration_s": round(time.monotonic() - started, 1) if started else None,
                              "error": f"{type(exc).__name__}: {exc}", "trigger_status": status,
                              "focus_mode": focus.get("focus_mode"), "skill_rev": skill_rev,
                              "context_bytes": ctx_bytes, **metrics.as_dict()}
        log("recovery.error", error=f"{type(exc).__name__}: {exc}")
        return None
