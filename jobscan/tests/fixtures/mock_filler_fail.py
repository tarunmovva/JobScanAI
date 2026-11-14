#!/usr/bin/env python3
import argparse, json, sys
from pathlib import Path

FIXTURE = {
    "platform": "mock",
    "apply_url": "",
    "filled_at": "2026-01-01T00:00:00Z",
    "filled": [],
    "skipped": [],
    "errors": ["simulated filler failure"],
    "verification": {"checks": [], "summary": "failed"},
    "submission": {"status": "failed", "reason": "simulated failure"},
}

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--payload-file", required=True)
    p.add_argument("--output-dir", required=True)
    args = p.parse_args()
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    f = out / "fill_result.json"
    f.write_text(json.dumps(FIXTURE))
    sys.exit(1)

if __name__ == "__main__": main()
