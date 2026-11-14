#!/usr/bin/env python3
"""Shared runtime helpers for logs, artifacts, and console output."""

from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable, Tuple

RUNTIME_HOME_ENV = "JOB_AUTOMATOR_HOME"


def submit_enabled() -> bool:
    """False when JOB_AUTOMATOR_SUBMIT=0 — fill and verify, never click submit.

    Greenhouse always had a `--submit` flag, but Lever and Ashby had no gate of
    any kind: every run clicked submit, so the only way to exercise those two
    fillers was to send a real application to a real employer. This env var is
    the shared off switch, and it can also force greenhouse off regardless of
    the flag the Go CLI hardcodes.

    Default is ON, so nothing changes for a normal run.
    """
    return os.environ.get("JOB_AUTOMATOR_SUBMIT", "1").strip() != "0"


def unattended_run() -> bool:
    """True when the app's loop mode launched this process (JOB_AUTOMATOR_UNATTENDED=1).

    Nobody is at the computer during a loop run, so nothing may be left for a
    person to finish: every tab closes when its job ends.
    """
    return os.environ.get("JOB_AUTOMATOR_UNATTENDED", "").strip() == "1"


def configure_stdio_utf8() -> None:
    """Best-effort UTF-8 console configuration for Windows terminals."""
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream and hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


def safe_print(*args: Any, sep: str = " ", end: str = "\n", file=None, flush: bool = False) -> None:
    """Print text without crashing when the active console encoding is limited."""
    configure_stdio_utf8()
    target = file or sys.stdout
    text = sep.join(str(arg) for arg in args)
    try:
        print(text, end=end, file=target, flush=flush)
    except UnicodeEncodeError:
        encoding = getattr(target, "encoding", None) or "utf-8"
        sanitized = text.encode(encoding, errors="replace").decode(encoding, errors="replace")
        print(sanitized, end=end, file=target, flush=flush)


def _is_writable_dir(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".write_test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except Exception:
        return False


def get_runtime_home() -> Path:
    """Resolve a writable home for logs and artifacts."""
    candidates = []

    env_home = os.environ.get(RUNTIME_HOME_ENV)
    if env_home:
        candidates.append(Path(env_home).expanduser())

    candidates.append(Path.cwd() / ".job-automator")

    try:
        candidates.append(Path.home() / ".job-automator")
    except Exception:
        pass

    candidates.append(Path(tempfile.gettempdir()) / "job-automator")

    for candidate in candidates:
        if _is_writable_dir(candidate):
            return candidate

    fallback = Path(tempfile.gettempdir()) / "job-automator"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def get_runtime_subdir(*parts: str) -> Path:
    """Create and return a writable runtime subdirectory."""
    path = get_runtime_home()
    for part in parts:
        path /= part
    path.mkdir(parents=True, exist_ok=True)
    return path


def build_logger(name: str, log_filename: str, level: int = logging.INFO) -> Tuple[logging.Logger, Path]:
    """Create a module logger that always has a writable file target."""
    logger = logging.getLogger(name)

    if getattr(logger, "_job_automator_configured", False):
        logger.setLevel(level)
        return logger, Path(getattr(logger, "_job_automator_log_file"))

    logger.handlers.clear()
    logger.setLevel(level)
    logger.propagate = False

    formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    logger.addHandler(stream_handler)

    log_path = get_runtime_subdir("logs") / log_filename
    try:
        file_handler = logging.FileHandler(log_path, encoding="utf-8")
    except Exception:
        log_path = Path(tempfile.gettempdir()) / log_filename
        file_handler = logging.FileHandler(log_path, encoding="utf-8")

    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    logger._job_automator_configured = True
    logger._job_automator_log_file = str(log_path)
    return logger, log_path


def append_jsonl(relative_path: Iterable[str] | str, payload: Any) -> Path:
    """Append a JSON object to a runtime-managed JSONL file."""
    if isinstance(relative_path, str):
        path = get_runtime_home() / relative_path
    else:
        parts = list(relative_path)
        if not parts:
            raise ValueError("relative_path must not be empty")
        path = get_runtime_home()
        for part in parts[:-1]:
            path /= part
        path.mkdir(parents=True, exist_ok=True)
        path /= parts[-1]

    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return path
