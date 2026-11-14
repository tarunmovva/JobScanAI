"""CLI tool for testing IMAP credentials from Electron setup UI.

Usage:
    python -m job_application_automator.imap_setup_check \
        --host imap.gmail.com --port 993 \
        --user user@gmail.com --password "xxxx xxxx xxxx xxxx"

Prints JSON to stdout:
    {"ok": true}   or   {"ok": false, "error": "Login failed: ..."}
Exits: 0 on success, 1 on failure.
"""
from __future__ import annotations

import argparse
import imaplib
import json
import ssl
import sys


def test_connection(host: str, port: int, username: str, password: str) -> dict:
    try:
        ctx = ssl.create_default_context()
        imap = imaplib.IMAP4_SSL(host, int(port), ssl_context=ctx)
        imap.login(username, password)
        imap.select("INBOX")
    except imaplib.IMAP4.error as exc:
        return {"ok": False, "error": f"IMAP auth failed: {exc}"}
    except OSError as exc:
        return {"ok": False, "error": f"Connection failed: {exc}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    try:
        imap.logout()
    except Exception:
        pass
    return {"ok": True}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, default=993)
    parser.add_argument("--user", required=True)
    parser.add_argument("--password", required=True)
    args = parser.parse_args()

    result = test_connection(args.host, args.port, args.user, args.password)
    print(json.dumps(result))
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
