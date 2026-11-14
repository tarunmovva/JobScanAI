#!/usr/bin/env python3
"""Per-action fill logging: live terminal lines + a persisted per-job log.

Every fill action (navigation, each field, verification, submit, OTP steps,
AI-recovery lifecycle) emits one structured line:

    [18:42:07 greenhouse:4000000007] fill.field id=school--0 type=dropdown ok=false err='dropdown not found'

Lines go to stdout via runtime_support.safe_print — the Go runner pipes
filler stdout to stderr, so they appear live in the terminal that launched
the app — and are appended to {output_dir}/fill_log.txt for later reading.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

try:
    from job_application_automator.runtime_support import safe_print
except ImportError:
    from runtime_support import safe_print

_MAX_VALUE_CHARS = 160


def _fmt_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "-"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if len(text) > _MAX_VALUE_CHARS:
        text = text[: _MAX_VALUE_CHARS - 1] + "…"
    if any(ch in text for ch in " \t\"'="):
        return repr(text)
    return text or "''"


class FillLog:
    """Structured action logger for one fill run."""

    def __init__(self, platform: str, job_ref: str, output_dir: Path | str | None = None):
        self.prefix = f"{platform}:{job_ref}" if job_ref else platform
        self.log_path = Path(output_dir) / "fill_log.txt" if output_dir else None
        self.started = time.monotonic()

    def __call__(self, event: str, **kv: Any) -> None:
        stamp = time.strftime("%H:%M:%S")
        parts = " ".join(f"{k}={_fmt_value(v)}" for k, v in kv.items())
        line = f"[{stamp} {self.prefix}] {event}" + (f" {parts}" if parts else "")
        safe_print(line, flush=True)
        if self.log_path is not None:
            try:
                with self.log_path.open("a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except Exception:
                pass

    def elapsed_s(self) -> float:
        return round(time.monotonic() - self.started, 1)


def job_ref_from(payload_path: Path | str) -> str:
    """Job reference = the per-job directory name (the job id)."""
    try:
        return Path(payload_path).resolve().parent.name
    except Exception:
        return ""
