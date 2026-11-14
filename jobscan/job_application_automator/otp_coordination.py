#!/usr/bin/env python3
"""Cross-process coordination for mailbox-backed OTP flows."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from .runtime_support import get_runtime_subdir
except ImportError:
    from runtime_support import get_runtime_subdir


def mailbox_lock_key(provider: str, account_or_token: str) -> str:
    provider_key = re.sub(r"[^a-z0-9]+", "-", (provider or "mailbox").lower()).strip("-")
    account_key = (account_or_token or "default").strip().lower()
    return f"{provider_key}:{account_key}"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()


def _pid_alive(pid: Any) -> bool:
    try:
        pid_int = int(pid)
    except Exception:
        return False
    if pid_int <= 0:
        return False
    try:
        os.kill(pid_int, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


class MailboxOtpLock:
    """Atomic directory lock scoped to one mailbox identity."""

    def __init__(
        self,
        mailbox_key: str,
        *,
        lock_dir: Path | str | None = None,
        timeout_seconds: int = 3600,
        stale_seconds: int = 1800,
        poll_seconds: float = 0.5,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.mailbox_key = mailbox_key
        self.lock_hash = _safe_hash(mailbox_key)
        self.lock_root = Path(lock_dir).expanduser() if lock_dir else get_runtime_subdir("locks", "otp")
        self.lock_path = self.lock_root / f"{self.lock_hash}.lock"
        self.metadata_path = self.lock_path / "metadata.json"
        self.timeout_seconds = max(1, int(timeout_seconds or 3600))
        self.stale_seconds = max(30, int(stale_seconds or 1800))
        self.poll_seconds = max(0.1, float(poll_seconds or 0.5))
        self.extra_metadata = metadata or {}
        self.owner_token = uuid.uuid4().hex
        self.acquired = False
        self.acquired_metadata: dict[str, Any] = {}

    def acquire(self) -> dict[str, Any]:
        """Take the lock atomically.

        The lock's mutual exclusion AND its metadata must become visible in a
        single filesystem operation, or pollers can observe a directory with
        no metadata and mistake a live lock for a stale one (that race stole
        live locks under contention and crashed holders at release). So the
        metadata is fully staged in a sibling directory first, and the staged
        directory is os.rename()d into place — rename onto an existing name
        fails, which IS the mutual exclusion.
        """
        self.lock_root.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        deadline = started + self.timeout_seconds
        attempts = 0
        stale_removed = 0
        last_holder: dict[str, Any] = {}

        while True:
            attempts += 1
            metadata = self._build_metadata(started, attempts, stale_removed)
            staging = self.lock_root / f"{self.lock_hash}.staging-{self.owner_token}"
            try:
                staging.mkdir()
                (staging / "metadata.json").write_text(
                    json.dumps(metadata, indent=2), encoding="utf-8"
                )
                os.rename(staging, self.lock_path)
                self.acquired = True
                self.acquired_metadata = metadata
                return metadata
            except (FileExistsError, PermissionError, OSError):
                shutil.rmtree(staging, ignore_errors=True)
                if self.acquired:
                    raise
                last_holder = self._read_holder_metadata()
                if self._holder_is_stale(last_holder):
                    if self._remove_stale_lock():
                        stale_removed += 1
                        continue
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        "Timed out waiting for OTP mailbox lock "
                        f"{self.lock_hash} held_by={last_holder.get('pid', 'unknown')}"
                    )
                time.sleep(self.poll_seconds)

    def release(self) -> dict[str, Any]:
        """Release the lock. Total: NEVER raises — cleanup must not be able to
        destroy the outcome of the work it protected (a submitted application
        was once recorded as failed because release threw on a stolen lock)."""
        released_at = _utc_now_iso()
        result = {
            "released": False,
            "released_at": released_at,
            "lock_hash": self.lock_hash,
            "lock_path": str(self.lock_path),
        }
        if not self.acquired:
            return result
        try:
            if not self.lock_path.exists():
                result["reason"] = "lock_missing"
                return result
            holder = self._read_holder_metadata()
            if holder.get("owner_token") and holder.get("owner_token") != self.owner_token:
                result["reason"] = "lock_owner_changed"
                return result
            # Atomic detach, then best-effort delete of the inert tomb.
            tomb = self.lock_root / f"{self.lock_hash}.tomb-{uuid.uuid4().hex}"
            os.rename(self.lock_path, tomb)
            shutil.rmtree(tomb, ignore_errors=True)
            result["released"] = True
            return result
        except Exception as exc:
            result["reason"] = f"release_error: {type(exc).__name__}: {exc}"
            return result
        finally:
            self.acquired = False

    def __enter__(self) -> "MailboxOtpLock":
        self.acquire()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.release()

    def _build_metadata(self, started_monotonic: float, attempts: int, stale_removed: int) -> dict[str, Any]:
        acquired_epoch = time.time()
        metadata = {
            "mailbox_key": self.mailbox_key,
            "lock_hash": self.lock_hash,
            "owner_token": self.owner_token,
            "pid": os.getpid(),
            "hostname": socket.gethostname(),
            "created_at_epoch": acquired_epoch,
            "acquired_at": datetime.fromtimestamp(acquired_epoch, tz=timezone.utc).isoformat(),
            "waited_seconds": round(time.monotonic() - started_monotonic, 3),
            "attempts": attempts,
            "stale_locks_removed": stale_removed,
            "lock_path": str(self.lock_path),
        }
        metadata.update(self.extra_metadata)
        return metadata

    def _read_holder_metadata(self) -> dict[str, Any]:
        try:
            return json.loads(self.metadata_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _holder_is_stale(self, metadata: dict[str, Any]) -> bool:
        created = metadata.get("created_at_epoch")
        if created is None:
            # Metadata unreadable/absent. Transitions are atomic now, so this
            # only means a legacy or corrupted lock — trust the directory's
            # own mtime, never assume stale (assuming stale here is what let
            # pollers steal LIVE locks mid-transition).
            try:
                age = time.time() - self.lock_path.stat().st_mtime
            except OSError:
                return False  # dir vanished — nothing to steal
            return age >= self.stale_seconds
        try:
            age = time.time() - float(created)
        except Exception:
            return False
        if age < self.stale_seconds:
            return False
        pid = metadata.get("pid")
        return not _pid_alive(pid)

    def _remove_stale_lock(self) -> bool:
        """Steal a stale lock atomically: detach by rename first (only one
        concurrent stealer can win), then delete the inert tomb."""
        try:
            root = self.lock_root.resolve()
            target = self.lock_path.resolve()
            if target == root or root not in target.parents:
                return False
            tomb = self.lock_root / f"{self.lock_hash}.tomb-{uuid.uuid4().hex}"
            os.rename(self.lock_path, tomb)
            shutil.rmtree(tomb, ignore_errors=True)
            return True
        except Exception:
            return False
