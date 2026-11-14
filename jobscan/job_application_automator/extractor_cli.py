#!/usr/bin/env python3
"""Thin CLI dispatcher for platform-specific form extractors.

Usage:
    python -m job_application_automator.extractor_cli \
        --platform [ashby|lever|greenhouse] \
        --apply-url URL \
        --output-dir DIR

Environment:
    JOB_AUTOMATOR_MOCK=1  Write a hardcoded fixture and exit 0 (no browser needed).
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
    "company_slug": "mock",
    "job_id": "123",
    "job_title": "Mock Software Engineer",
    "extracted_at": "2026-01-01T00:00:00Z",
    "fields": [
        {"id": "name", "label": "Full Name", "type": "text", "required": True, "selector": "#name"},
        {"id": "email", "label": "Email", "type": "email", "required": True, "selector": "#email"},
        {"id": "resume", "label": "Resume", "type": "file", "required": True, "selector": "#resume", "accept": ".pdf,.doc,.docx"},
        {"id": "cover_letter", "label": "Cover Letter", "type": "textarea", "required": False, "selector": "#cover_letter"},
        {"id": "linkedin", "label": "LinkedIn URL", "type": "url", "required": False, "selector": "#linkedin"},
    ],
    "errors": [],
}


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Form extractor dispatcher")
    parser.add_argument("--platform", required=True, choices=["ashby", "lever", "greenhouse"],
                        help="Job platform to extract from")
    parser.add_argument("--apply-url", required=True, dest="apply_url",
                        help="URL of the job application form")
    parser.add_argument("--output-dir", required=True, dest="output_dir",
                        help="Directory to write extracted_fields.json into")
    parser.add_argument("--board", default="",
                        help="Greenhouse board token, for postings on a company's own domain")
    return parser.parse_args()


def _run_mock(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    out_file = output_dir / "extracted_fields.json"
    out_file.write_text(json.dumps(MOCK_FIXTURE, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[mock] wrote {out_file}")


def _run_real(platform: str, apply_url: str, output_dir: Path, board: str = "") -> None:
    import asyncio

    output_dir.mkdir(parents=True, exist_ok=True)

    if platform == "ashby":
        from job_application_automator.ashby_form_extractor import extract
        asyncio.run(extract(apply_url, output_dir))

    elif platform == "lever":
        from job_application_automator.lever_form_extractor import extract
        asyncio.run(extract(apply_url, output_dir))

    elif platform == "greenhouse":
        from job_application_automator.greenhouse_fast_form_extractor import extract
        asyncio.run(extract(apply_url, output_dir, board=board))

    else:
        raise ValueError(f"Unknown platform: {platform!r}")


def main() -> None:
    args = _parse_args()
    output_dir = Path(args.output_dir)

    if os.environ.get("JOB_AUTOMATOR_MOCK") == "1":
        _run_mock(output_dir)
        sys.exit(0)

    try:
        _run_real(args.platform, args.apply_url, output_dir, args.board)
    except Exception as exc:
        print(f"extractor_cli error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
