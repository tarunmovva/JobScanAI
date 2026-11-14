#!/usr/bin/env python3
import argparse, json, sys, time
from pathlib import Path

FIXTURE = {
    "platform": "mock",
    "apply_url": "",
    "filled_at": "2026-01-01T00:00:00Z",
    "filled": ["name"],
    "skipped": [],
    "errors": [],
    "verification": {"checks": [], "summary": "mock mode slow"},
    "submission": {"status": "submitted", "reason": "mock fixture slow"},
}

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--payload-file", required=True)
    p.add_argument("--output-dir", required=True)
    args = p.parse_args()
    time.sleep(3)
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    f = out / "fill_result.json"
    f.write_text(json.dumps(FIXTURE))
    sys.exit(0)

if __name__ == "__main__": main()
