#!/usr/bin/env python3
import argparse, json, os, sys
from pathlib import Path

FIXTURE = {
    "platform": "mock", "apply_url": "", "company_slug": "mock", "job_id": "test123",
    "job_title": "Mock Engineer", "extracted_at": "2026-01-01T00:00:00Z",
    "fields": [{"id": "name", "label": "Name", "type": "text", "required": True, "selector": "#name"}],
    "errors": []
}

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--apply-url", required=True)
    p.add_argument("--output-dir", required=True)
    args = p.parse_args()
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    f = out / "extracted_fields.json"
    FIXTURE["apply_url"] = args.apply_url
    f.write_text(json.dumps(FIXTURE))
    sys.exit(0)

if __name__ == "__main__": main()
