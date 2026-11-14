"""IMAP-based OTP reader — replaces GmailOtpReader with stdlib imaplib.

Preserves all OTP-reading semantics from the original GmailOtpReader:
- Subject + sender validation (GREENHOUSE_OTP_SUBJECT_RE)
- Scored candidate extraction (extract_otp_candidates)
- Per-message hint scoring (company / job_id / job_title weighting)
- recent_fallback: emails that arrived slightly before submit are held as
  fallback candidates and returned after recent_fallback_wait_seconds
- Best-score selection when multiple OTP emails are in the inbox simultaneously
- seen-set deduplication across poll cycles
"""
from __future__ import annotations

import email
import imaplib
import json
import re
import ssl
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ── Constants ─────────────────────────────────────────────────────────────────

GREENHOUSE_OTP_SENDER = "no-reply@us.greenhouse-mail.io"

GREENHOUSE_OTP_SUBJECT_RE = re.compile(
    r"^\s*Security code for your application to\s+.+\s*$", re.IGNORECASE
)

# Matches alphanumeric codes 6-10 chars with word boundaries
OTP_CODE_RE = re.compile(r"(?<![A-Za-z0-9])([A-Z0-9]{6,10})(?![A-Za-z0-9])", re.IGNORECASE)

DEFAULT_IMAP_CONFIG = Path(".job-automator/secrets/imap_config.json")

PROVIDER_PRESETS = {
    "gmail":   {"host": "imap.gmail.com",          "port": 993},
    "outlook": {"host": "imap-mail.outlook.com",   "port": 993},
    "yahoo":   {"host": "imap.mail.yahoo.com",      "port": 993},
    "icloud":  {"host": "imap.mail.me.com",         "port": 993},
}

# ── Module-level helpers (ported verbatim from greenhouse_fast_form_filler.py) ─


def _normalize_key(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def _has_word_phrase(haystack_key: str, phrase_key: str) -> bool:
    if not haystack_key or not phrase_key:
        return False
    return f" {phrase_key} " in f" {haystack_key} "


def _email_address(value: str) -> str:
    from email.utils import parseaddr
    parsed = parseaddr(str(value or ""))[1]
    return (parsed or str(value or "")).strip().lower()


def is_greenhouse_otp_message(subject: str, sender: str) -> bool:
    """True iff sender is the Greenhouse no-reply address AND subject matches
    the 'Security code for your application to ...' pattern."""
    return (
        _email_address(sender) == GREENHOUSE_OTP_SENDER
        and bool(GREENHOUSE_OTP_SUBJECT_RE.match(str(subject or "").strip()))
    )


def extract_otp_candidates(
    text: str, *, subject: str = "", sender: str = ""
) -> list[dict[str, Any]]:
    """Return ranked OTP code candidates from email text.

    Ported verbatim from the original greenhouse_fast_form_filler.py.
    Each candidate: {"code": str, "score": int, "context": str}
    Sorted by score descending.
    """
    haystack = re.sub(r"\s+", " ", f"{subject} {sender} {text or ''}").strip()
    candidates: dict[str, dict[str, Any]] = {}

    weak_words = {
        "greenhouse", "security", "verify", "confirm", "message",
        "support", "account", "application", "candidate", "submitted",
        "continue", "resubmit",
    }
    signal_re = re.compile(
        r"code|verification|verify|security|confirm|authenticate|one[-\s]?time|otp",
        re.IGNORECASE,
    )
    instruction_context_re = re.compile(
        r"copy and paste this code|enter (?:this|the) code|security code field|"
        r"verification code|security code|one[-\s]?time code|otp",
        re.IGNORECASE,
    )
    direct_code_prefix_re = re.compile(
        r"(?:copy and paste this code|security code field|verification code|security code|"
        r"one[-\s]?time code|otp|code(?:\s+is)?)\b.{0,100}(?::|is)\s*$",
        re.IGNORECASE,
    )

    for match in OTP_CODE_RE.finditer(haystack):
        code = match.group(1).strip()
        key = code.upper()
        if key.lower() in weak_words:
            continue
        if code.isalpha() and code.lower() in weak_words:
            continue
        if len(code) > 8 and code.isdigit():
            continue

        window = haystack[max(0, match.start() - 100): match.end() + 100]
        prefix = haystack[max(0, match.start() - 120): match.start()]
        instruction_context = bool(instruction_context_re.search(prefix))
        direct_context = bool(direct_code_prefix_re.search(prefix))

        if code.isalpha() and code != code.upper() and not direct_context:
            continue

        score = 0
        if len(code) == 8:
            score += 4
        elif 6 <= len(code) <= 7:
            score += 2
        if any(ch.isdigit() for ch in code):
            score += 1
        if any(ch.isalpha() for ch in code):
            score += 1
        if signal_re.search(window):
            score += 6
        if instruction_context:
            score += 4
        if direct_context:
            score += 10
        if "greenhouse" in haystack.lower():
            score += 2
        if score < 5:
            continue

        existing = candidates.get(key)
        if existing is None or score > existing["score"]:
            candidates[key] = {"code": code, "score": score, "context": window[:180]}

    return sorted(candidates.values(), key=lambda item: item["score"], reverse=True)


# ── Config loader ─────────────────────────────────────────────────────────────

def load_imap_config(config_path: Path | str | None = None) -> dict[str, Any]:
    """Load IMAP credentials from JSON file."""
    path = Path(config_path or DEFAULT_IMAP_CONFIG)
    if not path.exists():
        raise FileNotFoundError(f"IMAP config not found: {path}")
    with path.open(encoding="utf-8") as f:
        return json.load(f)


# ── ImapOtpReader ─────────────────────────────────────────────────────────────

class ImapOtpReader:
    """Poll an IMAP inbox for Greenhouse OTP emails using stdlib imaplib.

    Preserves all semantics of the original GmailOtpReader:
    - Subject+sender validation before accepting a message
    - extract_otp_candidates scoring for reliable code extraction
    - Hint-based scoring so the right OTP is picked for the right job
      when multiple applications submit simultaneously
    - recent_fallback for emails that arrived slightly before submit
    """

    def __init__(
        self,
        *,
        host: str,
        port: int = 993,
        username: str,
        password: str,
        timeout_seconds: int = 120,
        poll_seconds: int = 5,
        recent_lookback_seconds: int = 90,
        recent_fallback_wait_seconds: int = 45,
    ) -> None:
        self.host = host
        self.port = int(port)
        self.username = username
        self.password = password
        self.timeout_seconds = max(10, int(timeout_seconds or 120))
        self.poll_seconds = max(2, int(poll_seconds or 5))
        self.recent_lookback_seconds = max(0, int(recent_lookback_seconds or 0))
        self.recent_fallback_wait_seconds = max(0, int(recent_fallback_wait_seconds or 0))

    # ── Public API (mirrors GmailOtpReader) ───────────────────────────────────

    def wait_for_code(
        self,
        *,
        after: datetime,
        page_text: str = "",
        exclude_message_ids: set[str] | list[str] | None = None,
        hints: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        excluded = set(exclude_message_ids or [])
        return self._poll(after=after, excluded=excluded, hints=hints or {})

    def wait_for_code_after_snapshot(
        self,
        *,
        after: datetime,
        snapshot: dict[str, Any] | None = None,
        page_text: str = "",
        hints: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        excluded = set((snapshot or {}).get("message_ids") or [])
        result = self._poll(after=after, excluded=excluded, hints=hints or {})
        result["snapshot_message_count"] = len(excluded)
        return result

    def snapshot_message_ids(
        self,
        *,
        after: datetime | None = None,
        max_results: int = 50,
        hints: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        try:
            imap = self._connect()
            try:
                ids = self._search(imap, after or datetime.now(timezone.utc))
                return {"status": "ok", "message_ids": list(ids[:max_results])}
            finally:
                try:
                    imap.logout()
                except Exception:
                    pass
        except Exception as exc:
            return {"status": "error", "reason": str(exc), "message_ids": []}

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _connect(self) -> imaplib.IMAP4_SSL:
        ctx = ssl.create_default_context()
        socket_timeout = min(30, self.timeout_seconds)
        imap = imaplib.IMAP4_SSL(self.host, self.port, ssl_context=ctx, timeout=socket_timeout)
        imap.login(self.username, self.password)
        imap.select("INBOX")
        return imap

    def _search(self, imap: imaplib.IMAP4_SSL, after: datetime) -> list[str]:
        """Return IMAP UIDs from Greenhouse OTP sender since after's date.
        IMAP SEARCH SINCE is day-level only — fine-grained filtering happens
        in _poll using the parsed Date header.
        """
        local = after.astimezone()
        date_str = local.strftime("%d-%b-%Y")
        search_criterion = f'FROM "{GREENHOUSE_OTP_SENDER}" SINCE "{date_str}"'
        _, data = imap.search(None, search_criterion)
        raw = (data[0] or b"").split()
        return [uid.decode() for uid in raw]

    def _fetch_email(
        self, imap: imaplib.IMAP4_SSL, uid: str
    ) -> tuple[str, str, str, datetime | None]:
        """Fetch full message. Returns (subject, sender, body, sent_at)."""
        _, data = imap.fetch(uid, "(RFC822)")
        raw = data[0]
        if not isinstance(raw, tuple):
            return "", "", "", None

        msg = email.message_from_bytes(raw[1])
        subject = msg.get("Subject", "")
        sender = msg.get("From", "")
        date_str = msg.get("Date", "")

        sent_at: datetime | None = None
        try:
            from email.utils import parsedate_to_datetime
            sent_at = parsedate_to_datetime(date_str).astimezone(timezone.utc)
        except Exception:
            pass

        def _html_to_text(html: str) -> str:
            """Strip HTML tags — mirrors old _html_to_text from the Gmail reader."""
            text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", html)
            text = re.sub(r"(?s)<[^>]+>", " ", text)
            return re.sub(r"\s+", " ", text).strip()

        body = ""
        if msg.is_multipart():
            # Prefer text/plain; fall back to text/html (Greenhouse OTP emails
            # are multipart/related with HTML-only body — no text/plain part)
            html_fallback = ""
            for part in msg.walk():
                ct = part.get_content_type()
                if ct == "text/plain":
                    try:
                        body += part.get_payload(decode=True).decode("utf-8", errors="replace")
                    except Exception:
                        pass
                elif ct == "text/html" and not html_fallback:
                    try:
                        raw_html = part.get_payload(decode=True).decode("utf-8", errors="replace")
                        html_fallback = _html_to_text(raw_html)
                    except Exception:
                        pass
            if not body and html_fallback:
                body = html_fallback
        else:
            ct = msg.get_content_type()
            try:
                raw = msg.get_payload(decode=True).decode("utf-8", errors="replace")
                body = _html_to_text(raw) if ct == "text/html" else raw
            except Exception:
                pass

        return subject, sender, body, sent_at

    def _message_hint_score(
        self,
        *,
        subject: str,
        sender: str,
        body: str,
        hints: dict[str, Any],
    ) -> int:
        """Score this email against job hints so the right OTP is picked when
        multiple Greenhouse applications submit simultaneously.
        Weights: company=10, company_slug=8, job_id=8, job_title=4.
        Ported verbatim from GmailOtpReader._message_hint_score.
        """
        text_key = _normalize_key(" ".join([subject or "", sender or "", body or ""]))
        score = 0
        for key, weight in (
            ("company", 10),
            ("company_slug", 8),
            ("job_id", 8),
            ("job_title", 4),
        ):
            value = str(hints.get(key) or "").strip()
            value_key = _normalize_key(value)
            if not value_key:
                continue
            if key == "job_title":
                words = [word for word in value_key.split() if len(word) >= 4]
                if words:
                    matches = sum(1 for word in words if _has_word_phrase(text_key, word))
                    if matches:
                        score += min(weight, matches)
            elif _has_word_phrase(text_key, value_key) or value_key in text_key:
                score += weight
        return score

    def _poll(
        self,
        *,
        after: datetime,
        excluded: set[str],
        hints: dict[str, Any],
    ) -> dict[str, Any]:
        """Poll IMAP for a Greenhouse OTP email.

        Mirrors GmailOtpReader._wait_for_code exactly:
        - seen set prevents re-fetching already-scanned UIDs
        - subject+sender validation via is_greenhouse_otp_message
        - extract_otp_candidates + hint scoring for best-match selection
        - recent_fallback: emails received slightly before submit are held
          and returned after recent_fallback_wait_seconds if nothing newer arrives
        - per-cycle poll_candidates sorted by total_score descending
        """
        deadline = time.monotonic() + self.timeout_seconds
        last_exc: Exception | None = None
        successful_connects = 0
        seen: set[str] = set()          # UIDs already fetched — skip on next poll cycle
        scanned_message_count = 0
        started = time.monotonic()
        recent_fallback: dict[str, Any] | None = None

        while time.monotonic() < deadline:
            try:
                imap = self._connect()
                successful_connects += 1
                try:
                    uid_list = self._search(imap, after)
                    poll_candidates: list[dict[str, Any]] = []

                    for uid in uid_list:
                        if uid in excluded or uid in seen:
                            continue
                        seen.add(uid)

                        subject, sender, body, sent_at = self._fetch_email(imap, uid)
                        scanned_message_count += 1

                        # Validate subject + sender — reject non-OTP emails from sender
                        if not is_greenhouse_otp_message(subject, sender):
                            continue

                        # Extract ranked OTP candidates
                        candidates = extract_otp_candidates(body, subject=subject, sender=sender)
                        if not candidates:
                            continue
                        best = candidates[0]

                        # Score against job hints for parallel-submit disambiguation
                        hint_score = self._message_hint_score(
                            subject=subject, sender=sender, body=body, hints=hints
                        )
                        total_score = int(best["score"]) + hint_score

                        if sent_at and sent_at < after:
                            # Email arrived before submit — keep as fallback if within lookback window
                            age_before_submit = (after - sent_at).total_seconds()
                            if 0 <= age_before_submit <= self.recent_lookback_seconds:
                                candidate = {
                                    "status": "found_recent",
                                    "code": best["code"],
                                    "message_id": uid,
                                    "subject": subject,
                                    "received_at": sent_at.isoformat(),
                                    "candidate_score": best["score"],
                                    "hint_score": hint_score,
                                    "total_score": total_score,
                                    "scanned_message_count": scanned_message_count,
                                    "received_before_submit_seconds": round(age_before_submit, 3),
                                }
                                # Keep most recent pre-submit email as fallback
                                if recent_fallback is None or (
                                    str(candidate.get("received_at") or "")
                                    > str(recent_fallback.get("received_at") or "")
                                ):
                                    recent_fallback = candidate
                            continue

                        # Email arrived after submit — add to this cycle's candidates
                        poll_candidates.append({
                            "status": "found",
                            "code": best["code"],
                            "message_id": uid,
                            "subject": subject,
                            "received_at": sent_at.isoformat() if sent_at else "",
                            "candidate_score": best["score"],
                            "hint_score": hint_score,
                            "total_score": total_score,
                            "scanned_message_count": scanned_message_count,
                        })

                    # Return highest-scoring candidate from this cycle
                    if poll_candidates:
                        return sorted(
                            poll_candidates,
                            key=lambda item: (
                                int(item.get("total_score") or 0),
                                str(item.get("received_at") or ""),
                            ),
                            reverse=True,
                        )[0]

                finally:
                    try:
                        imap.logout()
                    except Exception:
                        pass

            except Exception as exc:
                last_exc = exc

            # Return recent_fallback once we've waited long enough
            if recent_fallback and (time.monotonic() - started) >= self.recent_fallback_wait_seconds:
                return recent_fallback

            remaining = deadline - time.monotonic()
            if remaining > 0:
                time.sleep(min(self.poll_seconds, remaining))

        # Deadline reached — return best available result
        if recent_fallback:
            return recent_fallback

        if last_exc is not None and successful_connects == 0:
            return {
                "status": "error",
                "reason": str(last_exc),
                "scanned_message_count": scanned_message_count,
            }

        return {
            "status": "timeout",
            "reason": f"No OTP email found within {self.timeout_seconds}s",
            "scanned_message_count": scanned_message_count,
        }
