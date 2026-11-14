#!/usr/bin/env python3
"""Thin CLI dispatcher for platform-specific form fillers.

Usage:
    python -m job_application_automator.filler_cli \
        --platform [ashby|lever|greenhouse] \
        --payload-file PATH \
        --output-dir DIR \
        [--otp-mailbox gmail:ADDRESS]

Environment:
    JOB_AUTOMATOR_MOCK=1  Write a hardcoded fixture and exit 0 (no browser needed).

NOTE (real mode): The Ashby and Lever fillers pause interactively for CAPTCHA
via input().  When invoked as a Go subprocess with no stdin attached, the real
path will hang.  The Go runner must either attach a PTY or provide stdin.
Mock mode is not affected.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

MOCK_FIXTURE = {
    "platform": "ashby",
    "apply_url": "https://jobs.ashbyhq.com/mock/123/application",
    "filled_at": "2026-01-01T00:00:00Z",
    "filled": ["name", "email", "cover_letter"],
    "skipped": [{"id": "resume", "reason": "mock mode"}],
    "errors": [],
    "verification": {"checks": [], "summary": "mock mode"},
    "submission": {"status": "submitted", "reason": "mock mode - no real submission"},
}


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Form filler dispatcher")
    parser.add_argument("--platform", required=True, choices=["ashby", "lever", "greenhouse"],
                        help="Job platform to fill for")
    parser.add_argument("--payload-file", required=True, dest="payload_file",
                        help="Path to fill_payload.json produced by the extractor")
    parser.add_argument("--output-dir", required=True, dest="output_dir",
                        help="Directory to write fill_result.json into")
    parser.add_argument("--otp-mailbox", default="", dest="otp_mailbox",
                        help="Mailbox spec for OTP, e.g. gmail:user@example.com (greenhouse only)")
    return parser.parse_args()


def _parse_otp_mailbox(otp_mailbox: str) -> tuple[str, str]:
    """Parse 'gmail:user@example.com' -> ('gmail', 'user@example.com').

    Returns ('', '') if otp_mailbox is empty.
    Raises ValueError for unknown providers.
    """
    if not otp_mailbox:
        return "", ""
    if ":" not in otp_mailbox:
        raise ValueError(f"--otp-mailbox must be in provider:address format, got: {otp_mailbox!r}")
    provider, _, address = otp_mailbox.partition(":")
    provider = provider.lower().strip()
    address = address.strip()
    if provider != "gmail":
        raise ValueError(f"Unsupported OTP provider {provider!r}; only 'gmail' is supported")
    return provider, address


def _run_mock(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    out_file = output_dir / "fill_result.json"
    out_file.write_text(json.dumps(MOCK_FIXTURE, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[mock] wrote {out_file}")


def _run_real(platform: str, payload_file: Path, output_dir: Path, otp_mailbox: str) -> None:
    import asyncio

    if not payload_file.exists():
        raise FileNotFoundError(f"Payload file not found: {payload_file}")

    output_dir.mkdir(parents=True, exist_ok=True)

    if platform == "ashby":
        from job_application_automator.ashby_form_filler import fill
        asyncio.run(fill(payload_file, output_dir))

    elif platform == "lever":
        from job_application_automator.lever_form_filler import fill
        asyncio.run(fill(payload_file, output_dir))

    elif platform == "greenhouse":
        _provider, gmail_account = _parse_otp_mailbox(otp_mailbox)
        # Resolve secrets relative to JOB_AUTOMATOR_HOME (or CWD fallback) so
        # the path is correct regardless of which directory invokes the script.
        _home = Path(os.environ.get("JOB_AUTOMATOR_HOME", ".job-automator"))
        _secrets = _home / "secrets"
        from job_application_automator.greenhouse_fast_form_filler import fill
        asyncio.run(fill(
            payload_file,
            output_dir,
            submit=True,
            otp_mode="auto",
            gmail_account=gmail_account,
            gmail_client_secret=str(_secrets / "google_oauth_client.json"),
            gmail_token_path=str(_secrets / "gmail_token.json"),
        ))

    else:
        raise ValueError(f"Unknown platform: {platform!r}")


def main() -> None:
    args = _parse_args()
    output_dir = Path(args.output_dir)
    payload_file = Path(args.payload_file)

    if os.environ.get("JOB_AUTOMATOR_MOCK") == "1":
        _run_mock(output_dir)
        sys.exit(0)

    try:
        _run_real(args.platform, payload_file, output_dir, args.otp_mailbox)
    except Exception as exc:
        print(f"filler_cli error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
