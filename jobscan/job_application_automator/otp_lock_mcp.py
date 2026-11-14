#!/usr/bin/env python3
"""Tiny stdio MCP server exposing one tool: acquire_otp_lock.

Given to fix-mode recovery agents on Greenhouse jobs. The agent MUST call the
tool immediately before clicking Submit: it blocks until the shared mailbox
OTP lock is acquired, snapshots the inbox (so only emails triggered by the
agent's submit count), and writes a grant file the filler later adopts for
the OTP handoff (_handle_otp_challenge) and the guaranteed release.

Stdlib-only JSON-RPC loop — no MCP SDK dependency.

Usage (spawned by codex from config, cwd = python package root):
    python -m job_application_automator.otp_lock_mcp \
        --mailbox-key imap:... --grant-out PATH --imap-config PATH \
        [--lock-dir DIR] [--timeout 300] [--stale 1800] [--job-id ID]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from job_application_automator.imap_otp_reader import ImapOtpReader, load_imap_config
    from job_application_automator.otp_coordination import MailboxOtpLock
except ImportError:
    from imap_otp_reader import ImapOtpReader, load_imap_config
    from otp_coordination import MailboxOtpLock

PROTOCOL_VERSION = "2024-11-05"

TOOL_DEF = {
    "name": "acquire_otp_lock",
    "description": (
        "Acquire the shared mailbox OTP lock for this job application. MUST be called "
        "immediately before clicking Submit on a Greenhouse form. Blocks until the lock "
        "is available. If it returns an error, DO NOT submit."
    ),
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
}


class LockService:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.lock: MailboxOtpLock | None = None

    def acquire(self) -> dict[str, Any]:
        if self.lock is not None and self.lock.acquired:
            return {"ok": True, "note": "lock already held"}
        lock = MailboxOtpLock(
            self.args.mailbox_key,
            lock_dir=self.args.lock_dir or None,
            timeout_seconds=self.args.timeout,
            stale_seconds=self.args.stale,
            metadata={"held_for": "ai_recovery", "job_id": self.args.job_id},
        )
        metadata = lock.acquire()  # blocks; raises TimeoutError when unavailable
        self.lock = lock

        snapshot: dict[str, Any] = {}
        try:
            cfg = load_imap_config(self.args.imap_config)
            reader = ImapOtpReader(
                host=cfg["host"],
                port=int(cfg.get("port", 993)),
                username=cfg["username"],
                password=cfg["password"],
                timeout_seconds=60,
            )
            snapshot = reader.snapshot_message_ids(after=datetime.now(timezone.utc))
        except Exception as exc:
            snapshot = {"status": "snapshot_failed", "error": f"{type(exc).__name__}: {exc}"}

        grant = {
            "mailbox_key": self.args.mailbox_key,
            "lock_dir": self.args.lock_dir or "",
            "lock_path": str(lock.lock_path),
            "owner_token": lock.owner_token,
            "acquired_at": metadata.get("acquired_at"),
            "acquired_epoch": metadata.get("created_at_epoch"),
            "waited_seconds": metadata.get("waited_seconds"),
            "job_id": self.args.job_id,
            "snapshot": snapshot,
        }
        grant_path = Path(self.args.grant_out)
        grant_path.parent.mkdir(parents=True, exist_ok=True)
        grant_path.write_text(json.dumps(grant, indent=2), encoding="utf-8")
        return {"ok": True, "waited_seconds": metadata.get("waited_seconds")}


def _reply(msg_id: Any, result: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": result}) + "\n")
    sys.stdout.flush()


def _reply_error(msg_id: Any, code: int, message: str) -> None:
    sys.stdout.write(json.dumps(
        {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}
    ) + "\n")
    sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mailbox-key", required=True)
    parser.add_argument("--grant-out", required=True)
    parser.add_argument("--imap-config", required=True)
    parser.add_argument("--lock-dir", default="")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--stale", type=int, default=1800)
    parser.add_argument("--job-id", default="")
    service = LockService(parser.parse_args())

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        method = msg.get("method")
        msg_id = msg.get("id")
        if method == "initialize":
            _reply(msg_id, {
                "protocolVersion": (msg.get("params") or {}).get("protocolVersion", PROTOCOL_VERSION),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "otp-lock", "version": "1.0"},
            })
        elif method == "tools/list":
            _reply(msg_id, {"tools": [TOOL_DEF]})
        elif method == "tools/call":
            name = (msg.get("params") or {}).get("name")
            if name != "acquire_otp_lock":
                _reply_error(msg_id, -32602, f"unknown tool {name!r}")
                continue
            try:
                outcome = service.acquire()
                _reply(msg_id, {"content": [{"type": "text", "text": json.dumps(outcome)}]})
            except TimeoutError as exc:
                _reply(msg_id, {"content": [{"type": "text",
                                             "text": f"ERROR: mailbox lock unavailable — do not submit ({exc})"}],
                                "isError": True})
            except Exception as exc:
                _reply(msg_id, {"content": [{"type": "text",
                                             "text": f"ERROR: {type(exc).__name__}: {exc} — do not submit"}],
                                "isError": True})
        elif msg_id is not None:
            # Unknown request — respond so the client doesn't hang.
            _reply(msg_id, {})
        # Notifications (no id) are ignored.


if __name__ == "__main__":
    main()
