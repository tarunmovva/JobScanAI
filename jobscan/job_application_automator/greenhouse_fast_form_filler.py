#!/usr/bin/env python3
"""Fast Greenhouse job application form filler.

Reads a filled payload from ``greenhouse_fast_form_extractor.py`` and fills the
application without submitting unless ``--submit`` is explicitly provided.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import Path
from typing import Any

from playwright.async_api import async_playwright

try:
    from job_application_automator.agent_recovery import attempt_recovery
    from job_application_automator.browser_cdp import open_cdp_page
    from job_application_automator import tab_tag
    from job_application_automator.close_policy import should_keep_tab_open
    from job_application_automator.fill_logging import FillLog, job_ref_from
    from job_application_automator.runtime_support import submit_enabled
    from job_application_automator.answer_values import truthy
    from job_application_automator.cover_letter import inject_cover_letter
    from job_application_automator.submission_signals import accepted_by_network, apply_recovery, attach_response_recorder
    from job_application_automator.submission_signals import settle_submission, UNSETTLED_STATUSES
    from job_application_automator.submission_signals import confirmation_text, confirmation_url
    from job_application_automator.greenhouse_fast_form_extractor import (
        FastGreenhouseFormExtractor,
        _normalize,
        _normalize_key,
        _parse_greenhouse_url,
        with_board,
    )
    from job_application_automator.otp_coordination import MailboxOtpLock, mailbox_lock_key
except ImportError:
    from agent_recovery import attempt_recovery
    from browser_cdp import open_cdp_page
    import tab_tag  # type: ignore
    from close_policy import should_keep_tab_open
    from fill_logging import FillLog, job_ref_from
    from runtime_support import submit_enabled
    from answer_values import truthy
    from cover_letter import inject_cover_letter
    from submission_signals import accepted_by_network, apply_recovery, attach_response_recorder
    from submission_signals import settle_submission, UNSETTLED_STATUSES
    from submission_signals import confirmation_text, confirmation_url
    from greenhouse_fast_form_extractor import (
        FastGreenhouseFormExtractor,
        _normalize,
        _normalize_key,
        _parse_greenhouse_url,
        with_board,
    )
    from otp_coordination import MailboxOtpLock, mailbox_lock_key


try:
    from job_application_automator.imap_otp_reader import ImapOtpReader, load_imap_config
    HAS_IMAP_OTP = True
    IMAP_IMPORT_ERROR = ""
except ImportError as exc:
    HAS_IMAP_OTP = False
    IMAP_IMPORT_ERROR = str(exc)


NAV_TIMEOUT_MS = 25_000
ACTION_TIMEOUT_MS = 2_000
FIELD_DELAY_MS = 120
DEFAULT_DUMMY_RESUME = ""
DEFAULT_IMAP_CONFIG_PATH = Path(".job-automator/secrets/imap_config.json")
OTP_CODE_RE = re.compile(r"(?<![A-Za-z0-9])([A-Z0-9]{6,10})(?![A-Za-z0-9])", re.IGNORECASE)
GREENHOUSE_OTP_SENDER = "no-reply@us.greenhouse-mail.io"
GREENHOUSE_OTP_SUBJECT_RE = re.compile(r"^\s*Security code for your application to\s+.+\s*$", re.IGNORECASE)


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _option_text(option: Any) -> str:
    if isinstance(option, dict):
        return _normalize(str(option.get("text") or option.get("label") or option.get("value") or ""))
    return _normalize(str(option or ""))


# Shared with the lever and ashby fillers -- they had no coercion at all and
# checked the box for a "No" answer. See answer_values.py.
_truthy = truthy


def _placeholderish(value: Any) -> bool:
    key = _normalize_key(str(value or ""))
    if not key:
        return True
    return key in {
        "select",
        "select one",
        "select an option",
        "please select",
        "choose",
        "choose one",
    } or key.startswith("select ")


def _has_word_phrase(haystack_key: str, phrase_key: str) -> bool:
    if not haystack_key or not phrase_key:
        return False
    return f" {phrase_key} " in f" {haystack_key} "


def _implies_yes_no(value_key: str, desired: str) -> bool:
    if desired not in {"yes", "no"}:
        return False
    padded = f" {value_key} "
    if desired == "yes":
        if value_key == "yes" or value_key.startswith("yes "):
            return True
        return any(
            marker in padded
            for marker in (
                " i agree ",
                " agree ",
                " consent ",
                " authorized ",
                " legally authorized ",
                " willing ",
                " able ",
                " eligible ",
                " human being ",
            )
        ) and not _implies_yes_no(value_key, "no")
    if value_key == "no" or value_key.startswith("no "):
        return True
    return any(
        marker in padded
        for marker in (
            " do not ",
            " don t ",
            " not ",
            " without ",
            " no sponsorship ",
            " not require ",
            " do not require ",
            " not need ",
            " not a protected ",
            " do not have ",
            " decline ",
            " prefer not ",
            " don t wish ",
            " do not wish ",
        )
    )


def _field_key(field: dict[str, Any]) -> str:
    return str(field.get("id") or field.get("name") or field.get("label") or "")


def _answer_for_field(field: dict[str, Any], answers: dict[str, Any]) -> Any:
    keys = [
        str(field.get("id") or ""),
        str(field.get("name") or ""),
        str(field.get("label") or ""),
        _normalize_key(str(field.get("label") or "")),
    ]
    for key in keys:
        if key and key in answers:
            return answers[key]
    return None


def extract_answers(payload: dict[str, Any]) -> dict[str, Any]:
    answers: dict[str, Any] = {}
    if isinstance(payload.get("answers"), dict):
        answers.update(payload["answers"])

    for item in payload.get("user_input_template") or []:
        if not isinstance(item, dict):
            continue
        value = item.get("value")
        if value in (None, ""):
            continue
        for key in (item.get("id"), item.get("name"), item.get("question")):
            if key:
                answers[str(key)] = value
        if item.get("question"):
            answers[_normalize_key(str(item["question"]))] = value

    for field in payload.get("fields") or []:
        if not isinstance(field, dict):
            continue
        value = field.get("value", field.get("answer"))
        if value in (None, ""):
            continue
        for key in (field.get("id"), field.get("name"), field.get("label")):
            if key:
                answers[str(key)] = value
        if field.get("label"):
            answers[_normalize_key(str(field["label"]))] = value

    return answers


def build_dummy_answers(fields: list[dict[str, Any]], resume_path: str | None = None) -> dict[str, Any]:
    answers: dict[str, Any] = {}
    for field in fields:
        key = _field_key(field)
        if not key:
            continue
        answers[key] = dummy_answer_for_field(field, resume_path=resume_path)
    return answers


def dummy_answer_for_field(field: dict[str, Any], resume_path: str | None = None) -> Any:
    label = _normalize_key(str(field.get("label") or field.get("id") or ""))
    field_type = str(field.get("type") or "text").lower()
    options = [_option_text(option) for option in field.get("options") or field.get("available_options") or []]
    options = [option for option in options if option and not _placeholderish(option)]

    if field_type == "file":
        return resume_path or DEFAULT_DUMMY_RESUME
    if field_type == "checkbox":
        return bool(field.get("required"))
    if field_type == "checkbox_group":
        return [options[0]] if options else []
    if field_type in {"dropdown", "select", "combobox", "radio"}:
        if options:
            return options[0]
        if field_type == "combobox" or field.get("supports_custom_input"):
            return "New York, NY"
        return ""
    if field_type == "email" or "email" in label:
        return "test.applicant@example.com"
    if field_type == "phone" or "phone" in label:
        return "+14155550100"
    if field_type == "url" or "linkedin" in label:
        if "linkedin" in label:
            return "https://www.linkedin.com/in/test-applicant"
        if "github" in label:
            return "https://github.com/test-applicant"
        return "https://example.com"
    if "first name" in label:
        return "Test"
    if "last name" in label:
        return "Applicant"
    if "full name" in label:
        return "Test Applicant"
    if "city" in label or "location" in label:
        return "New York, NY"
    if "company" in label or "employer" in label:
        return "Example Corp"
    if "title" in label or "role" in label or "position" in label:
        return "Software Engineer"
    if "school" in label or "university" in label or "college" in label:
        return "Example University"
    if "degree" in label:
        return "Bachelor's Degree"
    if "discipline" in label or "major" in label:
        return "Computer Science"
    if "month" in label:
        return "January"
    if "year" in label:
        return "2025"
    if any(term in label for term in ("salary", "compensation")):
        return "100000"
    if "hear about" in label:
        return "Company careers page"
    if "why" in label or "interest" in label:
        return "I am interested in this role because it aligns with my software engineering background and product-focused engineering experience."
    return "Test answer"


def _decode_gmail_data(value: str) -> str:
    if not value:
        return ""
    padded = value + "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8", errors="replace")
    except Exception:
        return ""


def _html_to_text(value: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", value or "")
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _gmail_header(message: dict[str, Any], name: str) -> str:
    headers = ((message.get("payload") or {}).get("headers") or [])
    for header in headers:
        if str(header.get("name") or "").lower() == name.lower():
            return str(header.get("value") or "")
    return ""


def _gmail_message_text(message: dict[str, Any]) -> str:
    chunks: list[str] = [str(message.get("snippet") or "")]

    def visit(part: dict[str, Any]) -> None:
        mime_type = str(part.get("mimeType") or "")
        body_data = (part.get("body") or {}).get("data") or ""
        if body_data and mime_type in {"text/plain", "text/html"}:
            decoded = _decode_gmail_data(str(body_data))
            chunks.append(_html_to_text(decoded) if mime_type == "text/html" else decoded)
        for child in part.get("parts") or []:
            if isinstance(child, dict):
                visit(child)

    payload = message.get("payload") or {}
    if isinstance(payload, dict):
        visit(payload)
    return re.sub(r"\s+", " ", " ".join(chunks)).strip()


def _gmail_internal_datetime(message: dict[str, Any]) -> datetime | None:
    internal_ms = str(message.get("internalDate") or "")
    if internal_ms.isdigit():
        return datetime.fromtimestamp(int(internal_ms) / 1000, tz=timezone.utc)
    date_header = _gmail_header(message, "Date")
    if date_header:
        try:
            parsed = parsedate_to_datetime(date_header)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except Exception:
            return None
    return None


def _email_address(value: str) -> str:
    parsed = parseaddr(str(value or ""))[1]
    return (parsed or str(value or "")).strip().lower()


def is_greenhouse_otp_message(subject: str, sender: str) -> bool:
    return (
        _email_address(sender) == GREENHOUSE_OTP_SENDER
        and bool(GREENHOUSE_OTP_SUBJECT_RE.match(str(subject or "").strip()))
    )


def extract_greenhouse_otp_candidates(text: str, *, subject: str = "", sender: str = "") -> list[dict[str, Any]]:
    if not is_greenhouse_otp_message(subject, sender):
        return []
    return extract_otp_candidates(text, subject=subject, sender=sender)


def _greenhouse_otp_query_terms(hints: dict[str, Any] | None = None) -> list[str]:
    hints = hints or {}
    terms: list[str] = []
    for key in ("company", "company_slug"):
        value = _normalize(str(hints.get(key) or ""))
        if value and value.lower() not in {"greenhouse", "job boards", "job board"} and value not in terms:
            terms.append(value)
    return terms[:2]


def extract_otp_candidates(text: str, *, subject: str = "", sender: str = "") -> list[dict[str, Any]]:
    """Return ranked OTP candidates without assuming a specific sender template."""
    haystack = re.sub(r"\s+", " ", f"{subject} {sender} {text or ''}").strip()
    candidates: dict[str, dict[str, Any]] = {}
    weak_words = {
        "greenhouse",
        "security",
        "verify",
        "confirm",
        "message",
        "support",
        "account",
        "application",
        "candidate",
        "submitted",
        "continue",
        "resubmit",
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
        window = haystack[max(0, match.start() - 100) : match.end() + 100]
        prefix = haystack[max(0, match.start() - 120) : match.start()]
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


class GreenhouseFastFormFiller:
    """Fast DOM-based Greenhouse filler using extractor metadata."""

    def __init__(self, config: dict[str, Any] | None = None):
        config = config or {}
        # JOB_AUTOMATOR_SUBMIT=0 forces fill-and-verify regardless of the flag,
        # so one switch governs all three platforms. The Go CLI hardcodes
        # "--submit" for greenhouse (runner.go), leaving no other way off.
        self.submit = bool(config.get("submit", False)) and submit_enabled()
        self.debug_artifacts = bool(config.get("debug_artifacts", False))
        self.resume_path = str(config.get("resume_path") or "")
        # The Greenhouse board token, for a posting on the company's own domain:
        # the URL cannot carry it, and extraction used it to choose the form.
        self.board = str(config.get("board") or "")
        self.otp_mode = str(config.get("otp_mode") or os.environ.get("JOB_AUTOMATOR_OTP_MODE") or "auto").lower()
        self.imap_config_path = Path(
            str(
                config.get("imap_config_path")
                or os.environ.get("JOB_AUTOMATOR_IMAP_CONFIG")
                or DEFAULT_IMAP_CONFIG_PATH
            )
        )
        self.otp_timeout_seconds = int(
            config.get("otp_timeout_seconds")
            or os.environ.get("JOB_AUTOMATOR_OTP_TIMEOUT_SECONDS")
            or 120
        )
        self.otp_lock_mode = str(
            config.get("otp_lock_mode") or os.environ.get("JOB_AUTOMATOR_OTP_LOCK") or "auto"
        ).lower()
        self.otp_lock_timeout_seconds = int(
            config.get("otp_lock_timeout_seconds")
            or os.environ.get("JOB_AUTOMATOR_OTP_LOCK_TIMEOUT_SECONDS")
            or 3600
        )
        self.otp_lock_stale_seconds = int(
            config.get("otp_lock_stale_seconds")
            or os.environ.get("JOB_AUTOMATOR_OTP_LOCK_STALE_SECONDS")
            or 1800
        )
        otp_lock_dir = str(config.get("otp_lock_dir") or os.environ.get("JOB_AUTOMATOR_OTP_LOCK_DIR") or "")
        # No override → None, so MailboxOtpLock uses its JOB_AUTOMATOR_HOME-aware
        # absolute default (single source of path truth; relative lock dirs
        # broke whenever the cwd wasn't the repo root).
        self.otp_lock_dir = Path(otp_lock_dir).expanduser() if otp_lock_dir else None
        self._otp_hints: dict[str, Any] = {}
        self._log = FillLog("greenhouse", "", None)  # replaced with the per-job logger in fill()
        self._last_submit_started_at: datetime | None = None  # deterministic submit window (grant-less OTP handoff)

    async def fill_payload(self, payload_path: Path, output_dir: Path | None = None) -> dict[str, Any]:
        payload = _read_json(payload_path)
        output_dir = output_dir.resolve() if output_dir else payload_path.parent.resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        return await self.fill(payload, output_dir, payload_path=payload_path)

    async def fill(
        self,
        payload: dict[str, Any],
        output_dir: Path,
        *,
        payload_path: Path | None = None,
    ) -> dict[str, Any]:
        output_dir.mkdir(parents=True, exist_ok=True)
        fields = [field for field in payload.get("fields") or [] if isinstance(field, dict)]
        # Inject BEFORE extract_answers, which copies payload['answers'] into a
        # fresh dict -- inject afterwards and the letter lands somewhere the
        # fill loop never reads.
        self._cover_fields = inject_cover_letter(payload, output_dir)
        answers = extract_answers(payload)
        self._otp_hints = self._otp_hints_from_payload(payload)
        apply_url = str(payload.get("original_url") or payload.get("apply_url") or payload.get("url") or "")
        if not apply_url:
            raise ValueError("Payload must include original_url, apply_url, or url")
        # token= is how an embed URL carries the job id.
        job_id_match = re.search(r"(?:gh_jid=|token=|/jobs/)(\d{5,})", apply_url)
        self._current_job_id = job_id_match.group(1) if job_id_match else ""

        result: dict[str, Any] = {
            "platform": "greenhouse",
            "filler": "greenhouse_fast_form_filler",
            "payload_path": str(payload_path) if payload_path else "",
            "apply_url": apply_url,
            "submit": self.submit,
            "filled_at": _now_iso(),
            "filled": [],
            "skipped": [],
            "errors": [],
        }

        log = FillLog("greenhouse", job_ref_from(payload_path) if payload_path else "", output_dir)
        self._log = log
        async with async_playwright() as playwright:
            session = await open_cdp_page(
                playwright,
                viewport={"width": 1366, "height": 960},
                extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
                tab_stage="fill",
                tab_text=tab_tag.tab_text(
                    (payload.get("job_context") or {}).get("company") or payload.get("company") or "",
                    (payload.get("job_context") or {}).get("title") or "",
                ),
            )
            page = session.page
            # Record the POST that actually files the application. Used as an
            # EXTRA positive signal only (see _classify_submit_state) and
            # written into fill_result.json so the endpoints this board really
            # uses are visible instead of guessed.
            self._network_responses: list[dict[str, Any]] = []
            attach_response_recorder(page, self._network_responses)
            keep_tab_open = False
            try:
                log("nav.start", url=apply_url)
                try:
                    nav_response = await page.goto(apply_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
                except Exception as exc:
                    # The same contract as ashby and lever: no page loaded, so
                    # nothing to finish by hand and the tab closes. This used to
                    # fall through to the generic handler as "error", so the
                    # same failure read differently depending on the platform.
                    log("nav.failed", err=str(exc))
                    result["status"] = "error"
                    result["errors"].append({"id": "_nav", "error": f"navigate: {exc}"})
                    result["submission"] = {"status": "nav_failed", "reason": f"navigate: {exc}"}
                    result["tab_left_open"] = False
                    _write_json(output_dir / "fill_result.json", result)
                    return result
                nav_status = nav_response.status if nav_response else 0
                log("nav.done", status=nav_status, elapsed_s=log.elapsed_s())
                extractor = FastGreenhouseFormExtractor({"debug_artifacts": False})
                await extractor._dismiss_overlays(page)
                target, form_context = await extractor._find_application_context(
                    page, with_board(_parse_greenhouse_url(apply_url), self.board), apply_url
                )
                target, form_context, controls = await self._wait_for_controls(
                    page, target, form_context, extractor, apply_url
                )
                await self._stamp_form_document(target)
                result["form_context"] = form_context
                result["resolved_url"] = page.url
                result["control_count"] = len(controls.get("controls", []))
                log("context.acquired", form_context=form_context,
                    controls=result["control_count"], fields=len(fields))

                # Closed postings redirect to the company board, which still
                # carries a few stray controls (search box, cookie banner) —
                # the extractor's own closed detection plus redirect markers
                # decide, not a bare zero-control check.
                context_says_closed = (
                    str(form_context.get("detection_mode") or "") == "closed_posting_detected"
                    and result["control_count"] <= 5
                )
                if not result["control_count"] or context_says_closed:
                    closed_reason = await self._posting_closed_probe(page, nav_status)
                    if closed_reason:
                        # Dead posting (expired/redirected) — nothing to fill,
                        # nothing for a recovery agent to fix.
                        result["status"] = "posting_closed"
                        result["submission"] = {"status": "posting_closed", "reason": closed_reason}
                        result["tab_left_open"] = False
                        await self._save_artifacts(page, target, output_dir, "posting_closed")
                        _write_json(output_dir / "fill_result.json", result)
                        log("posting.closed", reason=closed_reason, elapsed_s=log.elapsed_s())
                        return result

                await self._save_artifacts(page, target, output_dir, "before_fill")
                await extractor._dismiss_overlays(page)

                deferred: list[dict[str, Any]] = []
                for field in fields:
                    answer = _answer_for_field(field, answers)
                    if answer in (None, ""):
                        result["skipped"].append({"id": _field_key(field), "reason": "empty answer"})
                        log("skip", id=_field_key(field), reason="empty answer")
                        continue
                    if field.get("type") == "file" and not str(answer).strip():
                        result["skipped"].append({"id": _field_key(field), "reason": "missing file path"})
                        log("skip", id=_field_key(field), reason="missing file path")
                        continue
                    ok, detail = await self._fill_one(target, field, answer, controls)
                    if not ok and self._should_reacquire_context(detail):
                        log("field.reacquire", id=_field_key(field), detail=detail)
                        target, form_context, controls = await self._wait_for_controls(
                            page, target, form_context, extractor, apply_url, force_reacquire=True
                        )
                        await self._stamp_form_document(target)
                        result["form_context"] = form_context
                        result["control_count"] = len(controls.get("controls", []))
                        ok, detail = await self._fill_one(target, field, answer, controls)
                    if not ok and "disabled by form state" in str(detail):
                        # The form itself disabled this control (e.g. end date
                        # after 'Current role' is checked) — nothing to fill.
                        result["skipped"].append(
                            {"id": _field_key(field), "reason": "control disabled by form state"}
                        )
                        log("skip", id=_field_key(field), reason="control disabled by form state")
                        continue
                    if not ok and "not found" in str(detail).lower():
                        # Control absent from the DOM — usually conditionally
                        # hidden (Race appears only after Hispanic/Latino).
                        # Retry after the pass, once every reveal has fired.
                        deferred.append(field)
                        log("fill.defer", id=_field_key(field), detail=detail)
                        continue
                    check = await self._verify_one(target, field, answer, controls)
                    log("fill.field", id=_field_key(field), type=field.get("type"),
                        ok=bool(ok and check.get("pass")),
                        detail=detail if ok else None,
                        err=None if ok else detail,
                        verified=check.get("pass"))
                    if ok and check.get("pass"):
                        result["filled"].append(
                            {
                                "id": _field_key(field),
                                "type": field.get("type"),
                                "detail": detail,
                                "verified": True,
                                "actual": check.get("actual"),
                            }
                        )
                    else:
                        result["errors"].append(
                            {
                                "id": _field_key(field),
                                "type": field.get("type"),
                                "error": detail if not ok else "post-fill verification failed",
                                "verification": check,
                            }
                        )
                    await target.wait_for_timeout(FIELD_DELAY_MS)

                if deferred:
                    controls = await self._scan_controls(target)
                    # Core identity fields are never conditionally revealed on
                    # greenhouse — one of them missing after the sweep means
                    # the form itself was never located, and every miss must
                    # stay an error so downstream recovery gets the signal.
                    core_ids = {"first_name", "last_name", "email", "phone", "resume"}
                    context_failed = any(
                        _field_key(field) in core_ids for field in deferred
                    )
                    for field in deferred:
                        answer = _answer_for_field(field, answers)
                        ok, detail = await self._fill_one(target, field, answer, controls)
                        if not ok and "disabled by form state" in str(detail):
                            result["skipped"].append(
                                {"id": _field_key(field), "reason": "control disabled by form state"}
                            )
                            log("skip", id=_field_key(field), reason="control disabled by form state")
                            continue
                        if not ok and "not found" in str(detail).lower() and not context_failed:
                            result["skipped"].append(
                                {
                                    "id": _field_key(field),
                                    "reason": "control not present (conditional)",
                                    "detail": detail,
                                }
                            )
                            log("skip", id=_field_key(field), reason="control not present (conditional)")
                            continue
                        check = await self._verify_one(target, field, answer, controls)
                        log("fill.field", id=_field_key(field), type=field.get("type"),
                            ok=bool(ok and check.get("pass")),
                            detail=f"deferred: {detail}" if ok else None,
                            err=None if ok else detail,
                            verified=check.get("pass"))
                        if ok and check.get("pass"):
                            result["filled"].append(
                                {
                                    "id": _field_key(field),
                                    "type": field.get("type"),
                                    "detail": f"deferred: {detail}",
                                    "verified": True,
                                    "actual": check.get("actual"),
                                }
                            )
                        else:
                            result["errors"].append(
                                {
                                    "id": _field_key(field),
                                    "type": field.get("type"),
                                    "error": detail if not ok else "post-fill verification failed",
                                    "verification": check,
                                }
                            )
                        await target.wait_for_timeout(FIELD_DELAY_MS)

                controls = await self._scan_controls(target)
                dynamic_unanswered = self._find_unanswered_visible_controls(fields, controls)
                result["unanswered_visible_controls"] = dynamic_unanswered

                verification = await self._verify_fields(target, fields, answers, controls)
                result["verification"] = verification
                conditional_ids = {
                    str(entry.get("id"))
                    for entry in result["skipped"]
                    if "conditional" in str(entry.get("reason", ""))
                }
                result["required_unfilled"] = [
                    check
                    for check in verification["checks"]
                    if check.get("required")
                    and not check.get("control_disabled")
                    and not (check.get("control_missing") and str(check.get("id")) in conditional_ids)
                    and not self._check_has_answer(check)
                ]
                result["required_unfilled"].extend(
                    {
                        "id": control.get("id"),
                        "label": control.get("label"),
                        "type": control.get("type"),
                        "required": True,
                        "actual": "<unanswered newly visible control>",
                        "pass": False,
                    }
                    for control in dynamic_unanswered
                    if control.get("required")
                )
                # Required fields the payload never answered. Additive on
                # purpose: verification["checks"] and verification_failed are
                # untouched, and submission is not gated on status, so this
                # changes exactly one thing — the recovery agent now gets told
                # which controls are empty instead of going in blind.
                result["required_unfilled"].extend(
                    self._required_fields_left_blank(fields, answers, controls)
                )
                result["verification_failed"] = [
                    check
                    for check in verification["checks"]
                    if not check.get("pass")
                    and not check.get("control_disabled")
                    and not (check.get("control_missing") and str(check.get("id")) in conditional_ids)
                    # A control that is not in the DOM at verify time cannot be a
                    # fill failure — the form is not asking for it. Greenhouse
                    # hides Race once Hispanic/Latino is answered, which produced
                    # a false failure on 4 of 15 postings and sent recovery after
                    # a field that does not exist. Required controls still surface
                    # through required_unfilled, so nothing real is hidden.
                    and not (check.get("control_missing") and not check.get("required"))
                ]
                result["status"] = (
                    "pass"
                    if not result["verification_failed"] and not result["required_unfilled"]
                    else "verification_failed"
                )
                log("verify.done",
                    checks=len(verification.get("checks") or []),
                    failed=len(result["verification_failed"]),
                    required_unfilled=len(result["required_unfilled"]))
                for check in result["verification_failed"]:
                    log("verify.fail", id=check.get("id"), label=check.get("label"),
                        expected=check.get("expected"), actual=check.get("actual"))

                await self._save_artifacts(page, target, output_dir, "after_fill")

                if self.submit and not await self._form_document_intact(target):
                    # Nothing filled is on screen any more: a click during the
                    # fill navigated the page away. A submit here presses a
                    # button on some other page -- on one custom careers site
                    # that was a job-search form, recorded as posting_closed,
                    # and on others it was read as a submitted application.
                    result["submission"] = {
                        "status": "navigated_away",
                        "reason": f"the form page was left during the fill (now at {page.url})",
                    }
                    log("submit.skip", reason="navigated_away", url=page.url)
                    keep_tab_open = should_keep_tab_open("navigated_away")
                    result["tab_left_open"] = keep_tab_open
                    if keep_tab_open:
                        result["tab_left_open_reason"] = "navigated_away"
                    log("tab.policy", keep_open=keep_tab_open, reason="navigated_away")
                elif self.submit:
                    await extractor._dismiss_overlays(page)
                    log("submit.start")
                    result["submission"] = await self._submit(target, page)
                    if result["submission"].get("status") == "submitted":
                        result["status"] = "pass"
                    log("submit.state", status=result["submission"].get("status"),
                        reason=result["submission"].get("reason"))
                    await self._save_artifacts(page, target, output_dir, "after_submit")
                    # Keep the tab open on any failure so the user can finish
                    # manually; close only on success or when no form controls
                    # were ever found (closed posting / broken page).
                    form_found = int(result.get("control_count") or 0) > 0
                    keep_tab_open = should_keep_tab_open(
                        result["submission"].get("status", ""), form_found=form_found
                    )
                    result["tab_left_open"] = keep_tab_open
                    if keep_tab_open:
                        result["tab_left_open_reason"] = result["submission"].get("status")
                    log("tab.policy", keep_open=keep_tab_open,
                        reason=result["submission"].get("status"))

                    if result["submission"].get("status") != "submitted":
                        # AI recovery: agent fixes the live tab and submits;
                        # only a detector-confirmed submit flips the status.
                        async def _recovery_detect() -> bool:
                            state = await self._submit_state(target)
                            if state.get("error"):
                                # Frame detached after submit — fall back to the page.
                                state = await self._submit_state(page)
                            if self._classify_submit_state({}, state) != "submitted":
                                return False
                            # The classifier is handed an EMPTY before_state here, so its
                            # form_count comparison is dead and the verdict can rest on
                            # nothing but "no submit button on screen". That is trivially
                            # true of any page the agent has navigated to: one run ended on
                            # a company investor-relations page, with the agent reporting a
                            # "Thank you for applying" confirmation that appears nowhere in
                            # the captured HTML, and it was recorded as submitted.
                            #
                            # Absence is not evidence. A recovery-declared submit must show
                            # something POSITIVE: confirmation text, a confirmation URL, or
                            # an accepted submit response. Under-claiming leaves the tab
                            # open for the user; over-claiming invents an application.
                            if self._looks_submitted_state(state):
                                return True
                            if accepted_by_network(getattr(self, "_network_responses", None)):
                                return True
                            return False

                        grant_path = output_dir / "otp_lock_grant.json"
                        recovered = None
                        try:
                            recovered = await attempt_recovery(
                                platform="greenhouse", apply_url=apply_url, payload=payload,
                                result=result, output_dir=output_dir,
                                failure={
                                    "status": result["submission"].get("status"),
                                    "reason": result["submission"].get("reason", ""),
                                    "errors": result["errors"],
                                    "required_unfilled": result.get("required_unfilled"),
                                    "verification_failed": result.get("verification_failed"),
                                    "unanswered_visible_controls": result.get("unanswered_visible_controls"),
                                    # Controls the filler had no value for. A
                                    # required one is what blocks the submit.
                                    "skipped": result.get("skipped"),
                                    # The filler's own OTP trail — lets a diagnose-mode
                                    # agent tell "email never arrived" from "code rejected".
                                    "otp": {
                                        k: v
                                        for k, v in (result["submission"].get("otp") or {}).items()
                                        if k in ("status", "reason", "otp", "otp_fill",
                                                 "otp_submit_clicked", "otp_retry")
                                    },
                                },
                                page=page, detect=_recovery_detect, log=log,
                                otp_lock=self._recovery_otp_lock_spec(grant_path),
                            )
                            if not recovered:
                                # Agent's submit may have landed on the OTP screen —
                                # the script finishes verification with its own
                                # IMAP flow under the lock the agent acquired.
                                recovered = await self._recovery_otp_handoff(
                                    page, target, grant_path, result
                                )
                        finally:
                            self._release_recovery_lock(grant_path)
                        if recovered:
                            # Recovery REPLACES submission, and the block it
                            # replaces is the only record of what the classifier
                            # saw. Without this, diagnosing why a run handed off
                            # means reading a screenshot.
                            apply_recovery(result, recovered)
                            result["status"] = "pass"
                            keep_tab_open = False
                            result["tab_left_open"] = False
                            result.pop("tab_left_open_reason", None)
                else:
                    result["submission"] = {"status": "not_submitted"}
                    result["tab_left_open"] = False

                _write_json(output_dir / "fill_result.json", result)
                log("result.written", status=result.get("status"),
                    submission=(result.get("submission") or {}).get("status"),
                    elapsed_s=log.elapsed_s())
                return result
            except Exception as exc:
                result["status"] = "error"
                result["errors"].append({"id": "_fatal", "error": f"{type(exc).__name__}: {exc}"})
                result["tab_left_open"] = False
                # Keep submission.status populated so Go/Electron always find it.
                result.setdefault("submission", {"status": "error", "reason": f"{type(exc).__name__}: {exc}"})
                _write_json(output_dir / "fill_result.json", result)
                log("fatal", error=f"{type(exc).__name__}: {exc}", elapsed_s=log.elapsed_s())
                return result
            finally:
                if keep_tab_open:
                    # A tab left open is one the user is expected to finish by
                    # hand, so it must stop claiming it is still being filled.
                    # Runs after recovery, so the stage reflects the final
                    # status rather than the one that triggered the repair.
                    await tab_tag.apply_stage(
                        page,
                        tab_tag.stage_for_status(
                            (result.get("submission") or {}).get("status", "")),
                    )
                else:
                    await session.cleanup()

    async def _fill_one(
        self,
        target: Any,
        field: dict[str, Any],
        answer: Any,
        controls: dict[str, Any] | None = None,
    ) -> tuple[bool, str]:
        field_type = str(field.get("type") or "text").lower()
        try:
            if field_type == "file":
                return await self._fill_file(target, field, answer, controls)
            if field_type == "checkbox":
                return await self._fill_checkbox(target, field, answer, controls)
            if field_type in {"checkbox_group", "radio_group"}:
                return await self._fill_choice_group(target, field, answer, controls)
            if field_type in {"dropdown", "select", "combobox"}:
                return await self._fill_dropdown(target, field, str(answer), controls)
            if field_type == "textarea":
                return await self._fill_text(target, field, str(answer), multiline=True, controls=controls)
            return await self._fill_text(target, field, str(answer), multiline=False, controls=controls)
        except Exception as exc:
            return False, f"{type(exc).__name__}: {exc}"

    def _should_reacquire_context(self, detail: str) -> bool:
        detail_key = str(detail or "").lower()
        return any(
            marker in detail_key
            for marker in (
                "not found",
                "target page",
                "context",
                "frame was detached",
                "frame detached",
                "browser has been closed",
            )
        )

    async def _locator_for_field(
        self,
        target: Any,
        field: dict[str, Any],
        controls: dict[str, Any] | None = None,
    ) -> Any | None:
        selectors = [str(field.get("selector") or "")]
        if field.get("id"):
            selectors.append(f"#{self._css_escape(str(field['id']))}")
        matched = self._matched_control(field, controls)
        if matched and matched.get("selector"):
            selectors.append(str(matched["selector"]))
        if field.get("name"):
            name = str(field["name"]).replace('"', '\\"')
            selectors.append(f'[name="{name}"]')
        for selector in selectors:
            if not selector:
                continue
            try:
                locator = target.locator(selector).first
                if await locator.count():
                    return locator
            except Exception:
                continue
        return None

    async def _scan_controls(self, target: Any) -> dict[str, Any]:
        try:
            controls = await target.evaluate(
                """() => {
                    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
                    const key = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                    const visible = (el) => {
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                    };
                    const cssPath = (el) => {
                        if (el.id) return `#${CSS.escape(el.id)}`;
                        const parts = [];
                        let node = el;
                        while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
                            let part = node.tagName.toLowerCase();
                            const parent = node.parentElement;
                            if (parent) {
                                const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
                                if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
                            }
                            parts.unshift(part);
                            node = parent;
                            if (parts.length >= 6) break;
                        }
                        return parts.join(' > ');
                    };
                    const labelFor = (el) => {
                        const id = el.getAttribute('id');
                        const explicit = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
                        if (explicit && clean(explicit.textContent)) return clean(explicit.textContent).replace(/\\*$/, '').trim();
                        const aria = el.getAttribute('aria-label') || '';
                        if (clean(aria)) return clean(aria);
                        const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
                        const labelledText = labelledBy.map((id) => clean(document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
                        if (labelledText) return labelledText.replace(/\\*$/, '').trim();
                        const root = el.closest('.field-wrapper, .select, .input-wrapper, fieldset, label') || el.parentElement;
                        const label = root && root.querySelector('label, legend');
                        return clean(label && label.textContent).replace(/\\*$/, '').trim();
                    };
                    const typeFor = (el) => {
                        const tag = el.tagName.toLowerCase();
                        const inputType = (el.getAttribute('type') || '').toLowerCase();
                        if (tag === 'textarea') return 'textarea';
                        if (tag === 'select') return 'dropdown';
                        if (inputType === 'file') return 'file';
                        if (inputType === 'checkbox') return 'checkbox';
                        if (inputType === 'radio') return 'radio';
                        if (inputType === 'email') return 'email';
                        if (inputType === 'tel') return 'phone';
                        if (inputType === 'url') return 'url';
                        if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return 'dropdown';
                        return 'text';
                    };
                    const nodes = Array.from(document.querySelectorAll('input, textarea, select, [role="combobox"], [aria-haspopup="listbox"]'));
                    const seen = new Set();
                    const controls = [];
                    for (const el of nodes) {
                        if (!visible(el)) continue;
                        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
                        const tag = el.tagName.toLowerCase();
                        const inputType = (el.getAttribute('type') || '').toLowerCase();
                        if (el.getAttribute('aria-hidden') === 'true') continue;
                        if (String(el.className || '').includes('requiredInput')) continue;
                        if (tag === 'input' && ['hidden', 'button', 'submit', 'reset'].includes(inputType)) continue;
                        const selector = cssPath(el);
                        if (!selector || seen.has(selector)) continue;
                        seen.add(selector);
                        controls.push({
                            id: clean(el.getAttribute('id')),
                            name: clean(el.getAttribute('name')),
                            label: labelFor(el),
                            label_key: key(labelFor(el)),
                            type: typeFor(el),
                            selector,
                            visible: true,
                            required: !!(el.required || el.getAttribute('required') !== null || el.getAttribute('aria-required') === 'true')
                        });
                    }
                    return controls;
                }"""
            )
        except Exception:
            controls = []

        by_id = {control.get("id"): control for control in controls if control.get("id")}
        by_name = {control.get("name"): control for control in controls if control.get("name")}
        by_label = {control.get("label_key"): control for control in controls if control.get("label_key")}
        return {"controls": controls, "by_id": by_id, "by_name": by_name, "by_label": by_label}

    def _required_fields_left_blank(
        self,
        fields: list[dict[str, Any]],
        answers: dict[str, Any],
        controls: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        """Required fields the payload agent left empty.

        Nobody reported these before: _verify_fields skips any field whose answer
        is blank (so it produces no check), and _find_unanswered_visible_controls
        only reports controls that are NOT in the extracted field list. A KNOWN
        required field with an empty answer therefore fell through both — the
        form was submitted incomplete, Greenhouse rejected it with
        validation_errors, and the recovery agent went in blind with nothing to
        repair (one posting: four required dropdowns, zero recorded).

        Only controls the live scan still sees are counted. _scan_controls
        already filters to visible and non-disabled, so a conditionally hidden or
        form-disabled field can never be flagged here.
        """
        if not controls:
            return []
        blank: list[dict[str, Any]] = []
        for field in fields:
            if not field.get("required"):
                continue
            if _answer_for_field(field, answers) not in (None, ""):
                continue
            if self._matched_control(field, controls) is None:
                continue
            blank.append(
                {
                    "id": field.get("id"),
                    "label": field.get("label"),
                    "type": field.get("type"),
                    "required": True,
                    "selector": field.get("selector"),
                    "expected": "",
                    "actual": "<no answer generated>",
                    "pass": False,
                }
            )
        return blank

    def _find_unanswered_visible_controls(
        self,
        fields: list[dict[str, Any]],
        controls: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        if not controls:
            return []
        known_ids = {str(field.get("id") or "") for field in fields if field.get("id")}
        known_names = {str(field.get("name") or "") for field in fields if field.get("name")}
        known_selectors = {str(field.get("selector") or "") for field in fields if field.get("selector")}
        known_labels = {
            _normalize_key(str(field.get("label") or ""))
            for field in fields
            if field.get("label")
        }

        unanswered: list[dict[str, Any]] = []
        for control in controls.get("controls", []):
            control_id = str(control.get("id") or "")
            control_name = str(control.get("name") or "")
            control_selector = str(control.get("selector") or "")
            control_label = str(control.get("label") or "")
            control_label_key = str(control.get("label_key") or _normalize_key(control_label))
            if control_id and control_id in known_ids:
                continue
            if control_name and control_name in known_names:
                continue
            if control_selector and control_selector in known_selectors:
                continue
            if control_label_key and control_label_key in known_labels:
                continue
            if not any((control_id, control_name, control_label)):
                continue
            unanswered.append(
                {
                    "id": control_id,
                    "name": control_name,
                    "label": control_label,
                    "type": control.get("type"),
                    "required": bool(control.get("required")),
                    "selector": control_selector,
                }
            )
        return unanswered

    def _matched_control(self, field: dict[str, Any], controls: dict[str, Any] | None) -> dict[str, Any] | None:
        if not controls:
            return None
        field_id = str(field.get("id") or "")
        field_name = str(field.get("name") or "")
        label_key = _normalize_key(str(field.get("label") or ""))
        if field_id and field_id in controls.get("by_id", {}):
            return controls["by_id"][field_id]
        if field_name and field_name in controls.get("by_name", {}):
            return controls["by_name"][field_name]
        if label_key and label_key in controls.get("by_label", {}):
            return controls["by_label"][label_key]
        for control in controls.get("controls", []):
            control_label = str(control.get("label_key") or "")
            if not (label_key and control_label):
                continue
            if control_label == label_key:
                return control
            # Substring matching on a SHORT label grabs an unrelated control:
            # greenhouse hides "Race" once Hispanic/Latino is answered, and
            # "race" is a substring of "how do you identify race ethnicity", so a
            # field that had vanished from the page resolved onto a DIFFERENT
            # question's dropdown and reported its value. Require the shorter
            # label to be substantial and to line up on word boundaries.
            shorter, longer = sorted((label_key, control_label), key=len)
            if len(shorter.split()) < 2 or len(shorter) < 8:
                continue
            if f" {shorter} " in f" {longer} ":
                return control
        return None

    async def _wait_for_controls(
        self,
        page: Any,
        target: Any,
        form_context: dict[str, Any],
        extractor: FastGreenhouseFormExtractor,
        apply_url: str,
        force_reacquire: bool = False,
    ) -> tuple[Any, dict[str, Any], dict[str, Any]]:
        metadata = with_board(_parse_greenhouse_url(apply_url), self.board)
        controls = {"controls": []}
        if not force_reacquire:
            controls = await self._scan_controls(target)
            if controls.get("controls"):
                return target, form_context, controls

        deadline = datetime.now().timestamp() + 8
        last_target = target
        last_context = form_context
        while datetime.now().timestamp() < deadline:
            await page.wait_for_timeout(500)
            try:
                refreshed_target, refreshed_context = await extractor._find_application_context(page, metadata, apply_url)
                last_target = refreshed_target
                last_context = refreshed_context
            except Exception:
                refreshed_target = last_target
            controls = await self._scan_controls(refreshed_target)
            if controls.get("controls"):
                return refreshed_target, last_context, controls
        return last_target, last_context, controls

    async def _posting_closed_probe(self, page: Any, nav_status: int) -> str:
        """Only consulted when zero form controls were found — decides whether
        the page is a dead posting rather than a slow or unusual form."""
        if nav_status in (404, 410):
            return f"http {nav_status}"
        if "error=true" in str(page.url).lower():
            return "board redirect (error=true)"
        try:
            text = await page.evaluate(
                "() => ((document.body && document.body.innerText) || '').slice(0, 5000)"
            )
        except Exception:
            return ""
        key = " ".join(str(text).lower().split())
        markers = (
            "current openings",
            "current job openings",
            "page not found",
            "something went wrong",
            "job is no longer",
            "no longer accepting applications",
            "position has been filled",
            "posting not found",
            "job you are looking for",
            "this job is not available",
            "job posting has closed",
        )
        for marker in markers:
            if marker in key:
                return f"marker: {marker}"
        return ""

    async def _safe_scroll_into_view(self, locator: Any) -> None:
        try:
            await locator.scroll_into_view_if_needed(timeout=ACTION_TIMEOUT_MS)
            return
        except Exception:
            pass
        try:
            await locator.evaluate("(el) => el.scrollIntoView({block: 'center', inline: 'nearest'})")
        except Exception:
            pass

    async def _fill_text(
        self,
        target: Any,
        field: dict[str, Any],
        value: str,
        *,
        multiline: bool,
        controls: dict[str, Any] | None = None,
    ) -> tuple[bool, str]:
        locator = await self._locator_for_field(target, field, controls)
        if locator is None:
            return False, "text control not found"
        if await self._element_is_disabled(locator):
            return False, "control disabled by form state"
        await self._safe_scroll_into_view(locator)
        try:
            await locator.fill(value, timeout=ACTION_TIMEOUT_MS)
            await locator.dispatch_event("input")
            await locator.dispatch_event("change")
        except Exception:
            await locator.click(timeout=ACTION_TIMEOUT_MS, force=True)
            await locator.press("Control+A", timeout=ACTION_TIMEOUT_MS)
            await locator.type(value, delay=5, timeout=ACTION_TIMEOUT_MS * 5)
            await locator.dispatch_event("input")
            await locator.dispatch_event("change")
        return True, "text_filled"

    async def _fill_file(
        self,
        target: Any,
        field: dict[str, Any],
        answer: Any,
        controls: dict[str, Any] | None = None,
    ) -> tuple[bool, str]:
        file_path = Path(str(answer)).expanduser()
        if not file_path.exists():
            return False, f"file not found: {file_path}"
        locator = await self._locator_for_field(target, field, controls)
        if locator is None:
            return False, "file control not found"
        upload_attempted = False
        # The resume is the one field worth retrying. set_input_files fails
        # intermittently with a CDP-side "Cannot read properties of undefined
        # (reading 'uploadFile')" when the owner frame is replaced mid-upload —
        # observed on 2 of 15 greenhouse postings in one run and 0 of 15 in the
        # next. Re-resolving the locator is what recovers it; retrying the same
        # stale handle would not.
        for attempt in range(2):
            if attempt:
                await target.wait_for_timeout(700)
                locator = await self._locator_for_field(target, field, controls)
                if locator is None:
                    break
            try:
                if await locator.evaluate("(el) => el.matches && el.matches('input[type=file]')"):
                    await locator.set_input_files(str(file_path), timeout=ACTION_TIMEOUT_MS)
                    upload_attempted = True
                    if await self._wait_for_file_upload_confirmation(target, file_path.name):
                        return True, "file_uploaded" if not attempt else "file_uploaded_retry"
            except Exception:
                pass
            try:
                nested = locator.locator("input[type=file]").first
                if await nested.count():
                    await nested.set_input_files(str(file_path), timeout=ACTION_TIMEOUT_MS)
                    upload_attempted = True
                    if await self._wait_for_file_upload_confirmation(target, file_path.name):
                        return True, "file_uploaded_nested" if not attempt else "file_uploaded_nested_retry"
            except Exception:
                pass
        if upload_attempted and await self._fill_file_as_manual_text(target, field, file_path):
            return True, "file_entered_manually"
        return False, "file upload not confirmed"

    async def _wait_for_file_upload_confirmation(self, target: Any, filename: str) -> bool:
        if not filename:
            return False
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if await self._file_name_visible(target, filename):
                return True
            await target.wait_for_timeout(500)
        return False

    async def _fill_file_as_manual_text(self, target: Any, field: dict[str, Any], file_path: Path) -> bool:
        text = self._extract_file_text(file_path)
        if not text:
            return False
        field_id = str(field.get("id") or field.get("name") or "").strip()
        label_key = _normalize_key(str(field.get("label") or ""))
        candidates: list[str] = []
        if field_id:
            safe_id = self._css_escape(field_id)
            candidates.extend(
                [
                    f'[data-testid="{field_id}-text"]',
                    f'label[for="{safe_id}_text"]',
                    f'#{safe_id}_text',
                ]
            )
        if "resume" in label_key or "cv" in label_key:
            candidates.extend(
                [
                    '[data-testid="resume-text"]',
                    'label[for="resume_text"]',
                    '#resume_text',
                    'button:has-text("Enter manually")',
                ]
            )
        elif "cover letter" in label_key:
            candidates.extend(
                [
                    '[data-testid="cover_letter-text"]',
                    'label[for="cover_letter_text"]',
                    '#cover_letter_text',
                    'button:has-text("Enter manually")',
                ]
            )
        else:
            candidates.append('button:has-text("Enter manually")')

        for selector in candidates:
            try:
                trigger = target.locator(selector).first
                if await trigger.count() and await trigger.is_visible(timeout=500):
                    await self._safe_scroll_into_view(trigger)
                    await trigger.click(timeout=ACTION_TIMEOUT_MS, force=True)
                    await target.wait_for_timeout(500)
                    break
            except Exception:
                continue

        text_selectors = []
        if field_id:
            safe_id = self._css_escape(field_id)
            text_selectors.extend([f"#{safe_id}_text", f'[name="{field_id}_text"]'])
        if "resume" in label_key or "cv" in label_key:
            text_selectors.extend(["#resume_text", '[name="resume_text"]'])
        elif "cover letter" in label_key:
            text_selectors.extend(["#cover_letter_text", '[name="cover_letter_text"]'])
        text_selectors.extend(["textarea", '[contenteditable="true"]'])

        for selector in text_selectors:
            try:
                text_input = target.locator(selector).first
                if not await text_input.count():
                    continue
                if not await text_input.is_visible(timeout=500):
                    continue
                await self._safe_scroll_into_view(text_input)
                if await text_input.evaluate("(el) => el.isContentEditable"):
                    await text_input.fill(text[:15000], timeout=ACTION_TIMEOUT_MS)
                else:
                    await text_input.fill(text[:15000], timeout=ACTION_TIMEOUT_MS)
                await text_input.dispatch_event("input")
                await text_input.dispatch_event("change")
                return True
            except Exception:
                continue
        return False

    def _extract_file_text(self, file_path: Path) -> str:
        suffix = file_path.suffix.lower()
        try:
            if suffix == ".pdf":
                try:
                    import PyPDF2  # type: ignore
                except Exception:
                    return ""
                reader = PyPDF2.PdfReader(str(file_path))
                return "\n".join(page.extract_text() or "" for page in reader.pages).strip()
            if suffix in {".txt", ".rtf"}:
                return file_path.read_text(encoding="utf-8", errors="ignore").strip()
        except Exception:
            return ""
        return ""

    async def _fill_checkbox(
        self,
        target: Any,
        field: dict[str, Any],
        answer: Any,
        controls: dict[str, Any] | None = None,
    ) -> tuple[bool, str]:
        locator = await self._locator_for_field(target, field, controls)
        if locator is None:
            return False, "checkbox not found"
        desired = _truthy(answer)
        if await self._checkbox_is_desired(locator, desired):
            return True, "checkbox_already_set"
        try:
            await locator.set_checked(desired, timeout=ACTION_TIMEOUT_MS, force=True)
            await target.wait_for_timeout(100)
            if await self._checkbox_is_desired(locator, desired):
                return True, "checkbox_set"
        except Exception:
            pass

        try:
            if await self._checkbox_checked(locator) != desired:
                await locator.click(timeout=ACTION_TIMEOUT_MS, force=True)
                await target.wait_for_timeout(100)
                if await self._checkbox_is_desired(locator, desired):
                    return True, "checkbox_clicked"
        except Exception:
            pass

        if await self._click_checkbox_label_or_wrapper(locator, desired):
            await target.wait_for_timeout(100)
            if await self._checkbox_is_desired(locator, desired):
                return True, "checkbox_label_clicked"

        actual = await self._checkbox_checked(locator)
        return False, f"checkbox not set: expected={desired} actual={actual}"

    async def _checkbox_checked(self, locator: Any) -> bool:
        try:
            return bool(await locator.is_checked(timeout=ACTION_TIMEOUT_MS))
        except Exception:
            try:
                return bool(
                    await locator.evaluate(
                        """(el) => {
                            const input = el.matches && el.matches('input[type="checkbox"]')
                                ? el
                                : el.querySelector && el.querySelector('input[type="checkbox"]');
                            return !!(input && input.checked);
                        }"""
                    )
                )
            except Exception:
                return False

    async def _checkbox_is_desired(self, locator: Any, desired: bool) -> bool:
        return await self._checkbox_checked(locator) == desired

    async def _click_checkbox_label_or_wrapper(self, locator: Any, desired: bool) -> bool:
        try:
            return bool(
                await locator.evaluate(
                    """(el, desired) => {
                        const input = el.matches && el.matches('input[type="checkbox"]')
                            ? el
                            : el.querySelector && el.querySelector('input[type="checkbox"]');
                        if (!input) return false;
                        const candidates = [];
                        if (input.id) {
                            const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
                            if (label) candidates.push(label);
                        }
                        const enclosingLabel = input.closest('label');
                        if (enclosingLabel) candidates.push(enclosingLabel);
                        const wrapper = input.closest('.checkbox, .checkbox__wrapper, .field-wrapper, [role="checkbox"]');
                        if (wrapper) {
                            const wrapperLabel = wrapper.querySelector('label');
                            if (wrapperLabel) candidates.push(wrapperLabel);
                            candidates.push(wrapper);
                        }
                        candidates.push(input);
                        const seen = new Set();
                        for (const candidate of candidates) {
                            if (!candidate || seen.has(candidate)) continue;
                            seen.add(candidate);
                            if (input.checked !== desired) candidate.click();
                            if (input.checked === desired) return true;
                        }
                        if (input.checked !== desired) {
                            input.checked = desired;
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            input.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        return input.checked === desired;
                    }""",
                    desired,
                )
            )
        except Exception:
            return False

    async def _fill_choice_group(
        self,
        target: Any,
        field: dict[str, Any],
        answer: Any,
        controls: dict[str, Any] | None = None,
    ) -> tuple[bool, str]:
        values = answer if isinstance(answer, list) else [answer]
        values = [str(value) for value in values if str(value).strip()]
        if not values:
            return False, "empty choice answer"
        locator = await self._locator_for_field(target, field, controls)
        name = ""
        if locator is not None:
            try:
                name = await locator.get_attribute("name", timeout=500) or ""
            except Exception:
                pass
        for value in values:
            clicked = await self._click_choice_by_value(target, name, value)
            if not clicked:
                clicked = await self._click_choice_by_label_near(target, field, value)
            if not clicked:
                return False, f"choice not found: {value}"
        return True, "choice_selected"

    async def _click_choice_by_value(self, target: Any, name: str, value: str) -> bool:
        if not name:
            return False
        normalized = _normalize_key(value)
        escaped_name = name.replace('"', '\\"')
        controls = target.locator(f'input[name="{escaped_name}"]')
        count = min(await controls.count(), 80)
        for index in range(count):
            control = controls.nth(index)
            try:
                option_text = await control.evaluate(
                    """(el) => {
                        const id = el.id;
                        const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
                        const wrapping = el.closest('label');
                        return ((label && label.textContent) || (wrapping && wrapping.textContent) || el.value || '').trim();
                    }"""
                )
                if normalized and normalized in _normalize_key(option_text):
                    if await control.is_checked(timeout=ACTION_TIMEOUT_MS):
                        return True
                    await self._safe_scroll_into_view(control)
                    await control.click(timeout=ACTION_TIMEOUT_MS, force=True)
                    if await control.is_checked(timeout=ACTION_TIMEOUT_MS):
                        return True
                    await control.set_checked(True, timeout=ACTION_TIMEOUT_MS, force=True)
                    return await control.is_checked(timeout=ACTION_TIMEOUT_MS)
            except Exception:
                continue
        return False

    async def _click_choice_by_label_near(self, target: Any, field: dict[str, Any], value: str) -> bool:
        option = _normalize_key(value)
        if not option:
            return False
        clicked = await target.evaluate(
            """(args) => {
                const option = args.option;
                function key(value) {
                    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                }
                const inputs = Array.from(document.querySelectorAll('input[type=radio], input[type=checkbox]'));
                for (const input of inputs) {
                    const id = input.id;
                    const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : input.closest('label');
                    const text = key((label && label.textContent) || input.value || '');
                    if (text.includes(option) || option.includes(text)) {
                        input.click();
                        return true;
                    }
                }
                return false;
            }""",
            {"option": option, "label": _normalize_key(field.get("label"))},
        )
        return bool(clicked)

    async def _fill_dropdown(
        self,
        target: Any,
        field: dict[str, Any],
        answer: str,
        controls: dict[str, Any] | None = None,
    ) -> tuple[bool, str]:
        if not answer.strip():
            return False, "empty dropdown answer"
        options = self._field_options(field)

        locator = await self._locator_for_field(target, field, controls)
        if locator is None:
            return False, "dropdown not found"
        if await self._element_is_disabled(locator):
            # 'Current role' checked disables employment end-date; the form's
            # own state decides — retrying a dead control burned 31s per job.
            return False, "control disabled by form state"
        if await self._element_is_choice_input(locator):
            # Styled radio groups get extracted as dropdowns (seen live): a
            # radio's value attribute never reflects checked state, so every
            # dropdown read/write on it lies — selection goes through the
            # group path.
            return await self._fill_choice_group(target, field, answer, controls)
        runtime_custom_input = (
            bool(field.get("supports_custom_input"))
            # Truncated option lists are typeaheads — the answer may be valid
            # even though it wasn't among the sampled options; type to search.
            or bool(field.get("options_truncated"))
            or str(field.get("type") or "").lower() == "combobox"
            or await self._is_searchable_combobox(locator)
        )
        if options and not any(self._option_matches(answer, option) for option in options):
            if not runtime_custom_input:
                return False, f"answer not present in extracted options: {answer!r}"
        if not options and not runtime_custom_input:
            return False, "dropdown has no extracted options"

        await self._safe_scroll_into_view(locator)
        # A react-select MULTI control ADDS a chip per click, it never replaces.
        # Every retry therefore stacked another selection: a race/ethnicity field
        # answered "Decline To Self Identify" ended up committing "White" AND
        # "Two or More Races" — demographic answers the candidate never
        # gave. Clear stale chips before selecting anything.
        await self._clear_multi_select(locator, answer)
        if await self._dropdown_committed_match(locator, answer, field):
            # Some widgets arrive pre-selected (one form defaults its hidden
            # input to the 'Yes' value) — the answer is already on the form.
            # Committed evidence only: the loose innerText read declared empty
            # work-auth dropdowns already_set because the QUESTION text
            # implied 'yes'.
            return True, "already_set"
        if await self._select_native(locator, answer) and await self._dropdown_matches(locator, answer, field):
            return True, "native_select"

        # Committed evidence, the same check verification applies. This path
        # alone used to accept the loose read, which on an empty react-select
        # returns the QUESTION text -- and "Are you currently eligible to work
        # ...?" implies yes. So an option click that did not commit under load
        # reported success, the filler moved on, and verification failed the
        # field after the fact, when only a recovery run could fix it. Caught
        # here, a second open-and-click is still possible.
        for attempt in range(2):
            await self._open_dropdown(target, locator)
            if not await self._click_visible_option(target, answer):
                break
            if await self._dropdown_settled_match(target, locator, answer, field):
                return True, "visible_option" if attempt == 0 else "visible_option_retry"

        if runtime_custom_input:
            # Location-style services match SHORT queries: the full
            # 'Birmingham, Alabama, United States' string returns zero
            # results (menu opens, no options — live-traced). Type the
            # leading segment as the query; the full answer still drives
            # option scoring and verification below.
            query = answer.split(",")[0].strip() if "," in answer else answer
            # The async option fetch listens to real KEY events — fill()'s
            # synthetic input event never loads any options (live-traced).
            try:
                await locator.click(timeout=ACTION_TIMEOUT_MS)
                await locator.fill("", timeout=ACTION_TIMEOUT_MS)
                await locator.press_sequentially(query, delay=40, timeout=ACTION_TIMEOUT_MS * 5)
            except Exception:
                try:
                    await locator.fill(query, timeout=ACTION_TIMEOUT_MS)
                except Exception:
                    pass
            # React comboboxes can swallow leading keystrokes while the menu
            # mounts ('Birmingham' -> 'irmingham') — retype once when the control holds
            # something other than the query.
            try:
                current = _normalize_key(await locator.input_value(timeout=1_000))
            except Exception:
                current = ""
            if current and current != _normalize_key(query):
                try:
                    await locator.fill("", timeout=ACTION_TIMEOUT_MS)
                    await locator.press_sequentially(query, delay=60, timeout=ACTION_TIMEOUT_MS * 5)
                except Exception:
                    pass
            await self._wait_for_visible_options(target, timeout_ms=4_000)
            if not await self._has_visible_options(target):
                # Parallel fills run in BACKGROUND tabs where Chrome throttles
                # the typeahead's debounced option fetch past the first wait.
                # ArrowDown forces the menu open and re-triggers loading.
                try:
                    await locator.press("ArrowDown", timeout=ACTION_TIMEOUT_MS)
                except Exception:
                    pass
                await self._wait_for_visible_options(target, timeout_ms=8_000)
            picked = await self._click_best_visible_option(target, answer)
            if picked:
                # Strict: typed text sits in input.value whether or not an
                # option committed — only committed evidence may pass here.
                if await self._dropdown_settled_match(target, locator, answer, field):
                    return True, f"typed_scored: {picked}"
            # One full retry. This path fails intermittently — the SAME field with
            # the SAME answer committed on one posting and came back
            # <uncommitted> on another in the same run, and a different posting
            # each time. A big list (greenhouse's school typeahead is 3000+) can
            # still be loading when the first wait expires, so the menu is either
            # empty or shows a placeholder row that scores nothing. Retyping
            # re-triggers the fetch against a now-warm list.
            # Two retries, not one. discipline--0 still came back
            # <uncommitted> after the single retry and cost a 93.5s recovery
            # run; a second retype is ~2s against that.
            for _ in range(2):
                try:
                    await locator.click(timeout=ACTION_TIMEOUT_MS)
                    await locator.fill("", timeout=ACTION_TIMEOUT_MS)
                    await locator.press_sequentially(query, delay=60, timeout=ACTION_TIMEOUT_MS * 5)
                except Exception:
                    break
                if not await self._wait_for_visible_options(target, timeout_ms=6_000):
                    try:
                        await locator.press("ArrowDown", timeout=ACTION_TIMEOUT_MS)
                    except Exception:
                        pass
                    await self._wait_for_visible_options(target, timeout_ms=8_000)
                retry_pick = await self._click_best_visible_option(target, answer)
                if retry_pick and await self._dropdown_settled_match(target, locator, answer, field):
                    return True, f"typed_scored_retry: {retry_pick}"
            if not await self._has_visible_options(target):
                # No menu rendered at all — keyboard fallback for native-ish
                # comboboxes. Never used when options are visible: picking the
                # highlighted entry blind is how 'Birmingham' became
                # 'Birmingham, West Midlands, United Kingdom'.
                try:
                    await locator.press("ArrowDown", timeout=ACTION_TIMEOUT_MS)
                    await locator.press("Enter", timeout=ACTION_TIMEOUT_MS)
                    if await self._dropdown_settled_match(target, locator, answer, field):
                        return True, "typed_enter"
                except Exception:
                    pass

        # Interaction paths may all miss while the widget still committed the
        # value asynchronously — settle on committed evidence before failing.
        if await self._dropdown_settled_match(target, locator, answer, field):
            return True, "settled_match"
        # Report what the form would submit, not what the input box shows: the
        # loose read returns typed text, which gave errors like
        # expected='Ridgeview Institute of Technology' actual='Ridgeview Institute
        # of Technology' -- a failure that reads as a success.
        # Committed only: at this point raw_value is the typeahead's own search
        # text, which is exactly the misleading read this replaces.
        state = await self._dropdown_committed_state(locator)
        actual = state["committed"] or "<uncommitted>"
        detail = f"dropdown option not selected: expected={answer!r} actual={actual!r}"
        try:
            typed = _normalize(await locator.input_value(timeout=1_000))
        except Exception:
            typed = ""
        if typed and actual == "<uncommitted>":
            detail += f"; typed={typed!r}"
        # The REAL rendered menu can differ from the extracted option list
        # (seen on a discipline dropdown) — surface it so downstream recovery reasons
        # from the form's actual choices.
        runtime_options = await self._visible_option_texts(target)
        if runtime_options:
            detail += f"; runtime_options={runtime_options[:25]!r}"
        return False, detail

    async def _visible_option_texts(self, target: Any) -> list[str]:
        try:
            texts = await target.evaluate(
                """() => Array.from(document.querySelectorAll('[role="option"], .select__option'))
                    .filter((el) => {
                        const rect = el.getBoundingClientRect();
                        const style = getComputedStyle(el);
                        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                    })
                    .map((el) => String(el.innerText || '').replace(/\\s+/g, ' ').trim())
                    .filter(Boolean)
                    .slice(0, 40)"""
            )
            return [str(t) for t in (texts or [])]
        except Exception:
            return []

    async def _element_is_disabled(self, locator: Any) -> bool:
        try:
            return bool(
                await locator.evaluate(
                    """el => {
                        if (el.disabled || el.readOnly) return true;
                        if ((el.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return true;
                        return !!el.closest('[class*="--is-disabled"], [aria-disabled="true"], fieldset:disabled');
                    }"""
                )
            )
        except Exception:
            return False

    async def _element_is_choice_input(self, locator: Any) -> bool:
        try:
            return str(
                await locator.evaluate("el => (el.type || '').toLowerCase()")
            ) in {"radio", "checkbox"}
        except Exception:
            return False

    async def _is_searchable_combobox(self, locator: Any) -> bool:
        try:
            return bool(
                await locator.evaluate(
                    """el => {
                        const input = el.matches('input, textarea') ? el : el.querySelector('input, textarea');
                        const target = input || el;
                        const role = (target.getAttribute('role') || '').toLowerCase();
                        const autocomplete = (target.getAttribute('aria-autocomplete') || '').toLowerCase();
                        const hasPopup = (target.getAttribute('aria-haspopup') || '').toLowerCase();
                        return role === 'combobox' || autocomplete === 'list' || hasPopup === 'listbox' || hasPopup === 'true';
                    }"""
                )
            )
        except Exception:
            return False

    async def _wait_for_visible_options(self, target: Any, *, timeout_ms: int = 2_000) -> bool:
        deadline = time.monotonic() + max(timeout_ms, 0) / 1000
        while time.monotonic() < deadline:
            if await self._has_visible_options(target):
                return True
            await target.wait_for_timeout(150)
        return await self._has_visible_options(target)

    async def _open_dropdown(self, target: Any, locator: Any) -> None:
        candidates = [locator]
        for selector in (
            'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " select ")][1]//*[contains(@class, "select__control")][1]',
            'xpath=ancestor::*[contains(@class, "select-shell")][1]//*[contains(@class, "select__control")][1]',
            'xpath=ancestor::*[contains(@class, "select__container")][1]//button[@aria-label="Toggle flyout"][1]',
            '[aria-haspopup="listbox"], input[role="combobox"], input[aria-autocomplete], button',
        ):
            try:
                candidate = locator.locator(selector).first
                if await candidate.count():
                    candidates.append(candidate)
            except Exception:
                continue

        for candidate in candidates:
            try:
                await candidate.click(timeout=ACTION_TIMEOUT_MS)
            except Exception:
                try:
                    await candidate.click(timeout=ACTION_TIMEOUT_MS, force=True)
                except Exception:
                    continue
            await target.wait_for_timeout(300)
            if await self._has_visible_options(target):
                return

    async def _has_visible_options(self, target: Any) -> bool:
        try:
            return bool(
                await target.evaluate(
                    """() => Array.from(document.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitemcheckbox"], .select__option, [class*="option"]'))
                        .some((el) => {
                            const text = (el.innerText || el.textContent || '').trim();
                            const rect = el.getBoundingClientRect();
                            const style = getComputedStyle(el);
                            return text && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                        })"""
                )
            )
        except Exception:
            return False

    async def _select_native(self, locator: Any, answer: str) -> bool:
        try:
            tag = await locator.evaluate("(el) => el.tagName.toLowerCase()")
            if tag != "select":
                return False
            for kwargs in ({"label": answer}, {"value": answer}):
                try:
                    await locator.select_option(**kwargs, timeout=ACTION_TIMEOUT_MS)
                    return True
                except Exception:
                    continue
            matched = await locator.evaluate(
                """(el, answer) => {
                    const key = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                    const hasPhrase = (haystack, phrase) => (` ${haystack} `).includes(` ${phrase} `);
                    const implies = (value, desired) => {
                        const padded = ` ${value} `;
                        if (desired === 'yes') {
                            if (value === 'yes' || value.startsWith('yes ')) return true;
                            return [' i agree ', ' agree ', ' consent ', ' authorized ', ' legally authorized ', ' willing ', ' able ', ' eligible ', ' human being ']
                                .some((marker) => padded.includes(marker)) && !implies(value, 'no');
                        }
                        if (desired === 'no') {
                            if (value === 'no' || value.startsWith('no ')) return true;
                            return [' do not ', ' don t ', ' not ', ' without ', ' no sponsorship ', ' not require ', ' do not require ', ' not need ', ' not a protected ', ' do not have ', ' decline ', ' prefer not ', ' don t wish ', ' do not wish ']
                                .some((marker) => padded.includes(marker));
                        }
                        return false;
                    };
                    const matches = (wanted, candidate) => {
                        if (!wanted || !candidate) return false;
                        if (wanted === candidate) return true;
                        if ((wanted === 'yes' || wanted === 'no') && implies(candidate, wanted)) return true;
                        if ((candidate === 'yes' || candidate === 'no') && implies(wanted, candidate)) return true;
                        if (wanted.length < 4 || candidate.length < 4) return false;
                        const wantedWords = wanted.split(' ').filter(Boolean).length;
                        const candidateWords = candidate.split(' ').filter(Boolean).length;
                        return (candidateWords >= 2 && hasPhrase(wanted, candidate)) || (wantedWords >= 2 && hasPhrase(candidate, wanted));
                    };
                    const desired = key(answer);
                    for (const option of Array.from(el.options || [])) {
                        const text = key(option.textContent);
                        const value = key(option.value);
                        if (matches(desired, text) || matches(desired, value)) {
                            el.value = option.value;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            return true;
                        }
                    }
                    return false;
                }""",
                answer,
            )
            return bool(matched)
        except Exception:
            return False
        return False

    async def _click_visible_option(self, target: Any, answer: str) -> bool:
        desired = _normalize_key(answer)
        try:
            exact = target.get_by_role("option", name=re.compile(r"^\s*" + re.escape(str(answer)) + r"\s*$", re.I)).first
            if await exact.count() and await exact.is_visible(timeout=300):
                await exact.click(timeout=ACTION_TIMEOUT_MS)
                return True
        except Exception:
            pass
        try:
            clicked = await target.evaluate(
                """(desired) => {
                    const key = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                    const wanted = key(desired);
                    const hasPhrase = (haystack, phrase) => (` ${haystack} `).includes(` ${phrase} `);
                    const implies = (value, desiredBool) => {
                        const padded = ` ${value} `;
                        if (desiredBool === 'yes') {
                            if (value === 'yes' || value.startsWith('yes ')) return true;
                            return [' i agree ', ' agree ', ' consent ', ' authorized ', ' legally authorized ', ' willing ', ' able ', ' eligible ', ' human being ']
                                .some((marker) => padded.includes(marker)) && !implies(value, 'no');
                        }
                        if (desiredBool === 'no') {
                            if (value === 'no' || value.startsWith('no ')) return true;
                            return [' do not ', ' don t ', ' not ', ' without ', ' no sponsorship ', ' not require ', ' do not require ', ' not need ', ' not a protected ', ' do not have ', ' decline ', ' prefer not ', ' don t wish ', ' do not wish ']
                                .some((marker) => padded.includes(marker));
                        }
                        return false;
                    };
                    const matches = (candidate) => {
                        if (!wanted || !candidate) return false;
                        if (wanted === candidate) return true;
                        if ((wanted === 'yes' || wanted === 'no') && implies(candidate, wanted)) return true;
                        if ((candidate === 'yes' || candidate === 'no') && implies(wanted, candidate)) return true;
                        if (wanted.length < 4 || candidate.length < 4) return false;
                        const wantedWords = wanted.split(' ').filter(Boolean).length;
                        const candidateWords = candidate.split(' ').filter(Boolean).length;
                        return (candidateWords >= 2 && hasPhrase(wanted, candidate)) || (wantedWords >= 2 && hasPhrase(candidate, wanted));
                    };
                    const visible = (el) => {
                        const text = (el.innerText || el.textContent || '').trim();
                        const rect = el.getBoundingClientRect();
                        const style = getComputedStyle(el);
                        return text && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                    };
                    const candidates = Array.from(document.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitemcheckbox"], .select__option, [class*="option"]'))
                        .filter(visible)
                        .map((el) => ({ el, text: (el.innerText || el.textContent || '').trim(), textKey: key(el.innerText || el.textContent || '') }))
                        .filter((item) => item.textKey && !item.textKey.startsWith('select '))
                        // A link is never an option. '[class*="option"]' matches
                        // site navigation too, and clicking it leaves the form.
                        .filter((item) => !item.el.closest('a[href]'));
                    for (const item of candidates) {
                        if (matches(item.textKey)) {
                            item.el.click();
                            return true;
                        }
                    }
                    return false;
                }""",
                answer,
            )
            if clicked:
                return True
        except Exception:
            pass
        options = target.locator(
            '[role="option"], [role="menuitemradio"], [role="menuitemcheckbox"], .select__option, [class*="option"]'
        )
        count = min(await options.count(), 120)
        for index in range(count):
            option = options.nth(index)
            try:
                if not await option.is_visible(timeout=200):
                    continue
                text = _normalize(await option.inner_text(timeout=300))
                if _placeholderish(text):
                    continue
                if await option.evaluate("(el) => !!el.closest('a[href]')"):
                    continue  # a link is never an option
                if self._option_matches(answer, text):
                    await option.click(timeout=ACTION_TIMEOUT_MS, force=True)
                    return True
            except Exception:
                continue
        return False

    async def _click_best_visible_option(self, target: Any, answer: str) -> str:
        """Click the visible option that best matches the answer — never a
        blind first-click. Exact text wins; otherwise every answer token must
        appear in the option (or the option be a subset of the answer), with
        the fewest extra tokens breaking ties: for answer 'Birmingham',
        'Birmingham, Alabama, United States' (3 extras) beats
        'Birmingham, West Midlands, United Kingdom' (4 extras).
        Returns the clicked option's text, or '' when nothing qualifies."""
        expected_key = _normalize_key(answer)
        if not expected_key:
            return ""
        try:
            # Single in-page pass: '[class*="option"]' matches hundreds of
            # unrelated nodes on some boards and the menu portal renders at
            # the END of the document — a capped element-by-element walk
            # never reaches the real options.
            picked = await target.evaluate(
                """(expectedKey) => {
                    const key = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                    const expectedTokens = expectedKey.split(' ').filter(Boolean);
                    if (!expectedTokens.length) return '';
                    const expectedSet = new Set(expectedTokens);
                    const placeholder = (t) => {
                        const k = key(t);
                        return !k || k === 'select' || k.startsWith('select ') || k === 'choose' || k === 'choose one';
                    };
                    const candidates = Array.from(document.querySelectorAll(
                        '[role="option"], [role="menuitemradio"], [role="menuitemcheckbox"], .select__option, [class*="option"]'));
                    let best = null;
                    candidates.forEach((el, index) => {
                        const rect = el.getBoundingClientRect();
                        const style = getComputedStyle(el);
                        if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return;
                        // A link is never an option: a careers site's "Birmingham"
                        // office link scores as a match for "Birmingham,
                        // Alabama, United States", and the click leaves
                        // the form for the site's locations page.
                        if (el.closest('a[href]')) return;
                        const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
                        if (!text || placeholder(text)) return;
                        const k = key(text);
                        const tokens = new Set(k.split(' ').filter(Boolean));
                        let score;
                        if (k === expectedKey) score = 3;
                        else if (expectedTokens.every((t) => tokens.has(t))
                                 || (tokens.size && [...tokens].every((t) => expectedSet.has(t)))) score = 2;
                        else return;
                        const extras = [...tokens].filter((t) => !expectedSet.has(t)).length;
                        const rank = [score, -extras, -index];
                        const better = best === null
                            || rank[0] > best.rank[0]
                            || (rank[0] === best.rank[0] && rank[1] > best.rank[1])
                            || (rank[0] === best.rank[0] && rank[1] === best.rank[1] && rank[2] > best.rank[2]);
                        if (better) best = { rank, el, text };
                    });
                    if (!best) return '';
                    best.el.click();
                    return best.text;
                }""",
                expected_key,
            )
            return str(picked or "")
        except Exception:
            return ""

    def _field_options(self, field: dict[str, Any]) -> list[str]:
        return [
            option
            for option in (_option_text(option) for option in field.get("options") or field.get("available_options") or [])
            if option and not _placeholderish(option)
        ]

    def _option_matches(self, expected: Any, actual: Any) -> bool:
        expected_raw = str(expected or "")
        actual_raw = str(actual or "")
        expected_key = _normalize_key(expected_raw)
        actual_key = _normalize_key(actual_raw)
        if not expected_key or not actual_key:
            return False
        if expected_key == actual_key:
            return True
        if len(expected_key) >= 4 and actual_key.startswith(expected_key + " "):
            # Place-style guard: a bare answer must not bless a long comma
            # location that merely shares the city token — 'Birmingham' picked
            # 'Birmingham, West Midlands, United Kingdom' and verified
            # green. Short tails ('Birmingham, AL' / 'Birmingham, Alabama,
            # United States') stay accepted.
            if "," in actual_raw and "," not in expected_raw:
                tail_tokens = [t for t in actual_key.split() if t not in set(expected_key.split())]
                if len(tail_tokens) >= 4:
                    return False
            return True
        if expected_key in {"yes", "no"} and _implies_yes_no(actual_key, expected_key):
            return True
        if actual_key in {"yes", "no"} and _implies_yes_no(expected_key, actual_key):
            return True
        expected_digits = re.sub(r"\D+", "", expected_raw)
        actual_digits = re.sub(r"\D+", "", actual_raw)
        if actual_raw.strip().startswith("+") and actual_digits and expected_digits.endswith(actual_digits):
            return True
        if len(expected_key) < 4 or len(actual_key) < 4:
            return False
        expected_words = expected_key.split()
        actual_words = actual_key.split()
        return (
            len(actual_words) >= 2
            and _has_word_phrase(expected_key, actual_key)
        ) or (
            len(expected_words) >= 2
            and _has_word_phrase(actual_key, expected_key)
        )

    async def _dropdown_settled_match(
        self,
        target: Any,
        locator: Any,
        expected: Any,
        field: dict[str, Any] | None = None,
        timeout_ms: int = 1_500,
    ) -> bool:
        """React widgets commit the selected value asynchronously — a single
        150ms check reads the pre-click state and reports a false mismatch.
        Poll until the value settles or the window closes. Committed-selection
        evidence only (see _dropdown_committed_match): there is no loose mode,
        because the loose read passes empty yes/no questions on their label."""
        deadline = time.monotonic() + max(timeout_ms, 0) / 1000
        while True:
            if await self._dropdown_committed_match(locator, expected, field):
                return True
            if time.monotonic() >= deadline:
                return False
            await target.wait_for_timeout(150)

    async def _clear_multi_select(self, locator: Any, answer: Any) -> int:
        """Remove already-selected chips from a multi-value react-select.

        Returns the number removed. A single-value control has no chips and is
        untouched, so this is a no-op everywhere except the multi case.
        Chips that already match the answer are kept — re-picking them would be
        wasted work and could toggle them back off.
        """
        try:
            keep = _normalize_key(str(answer or ""))
            return int(await locator.evaluate(
                r"""(el, keep) => {
                    const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
                    const key = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                    const root = el.closest('.select__control')
                        || el.closest('[class*="select-shell"]')
                        || el.closest('.select__container');
                    if (!root) return 0;
                    const chips = Array.from(root.querySelectorAll(
                        '.select__multi-value, [class*="multiValue"], [class*="multi-value"]'))
                        .filter((chip) => chip.querySelector('[class*="remove"]'));
                    let removed = 0;
                    for (const chip of chips) {
                        const label = chip.querySelector('[class*="label"]');
                        if (label && keep && key(label.textContent) === keep) continue;
                        const remove = chip.querySelector('[class*="remove"] button, [class*="remove"]');
                        if (remove) { remove.click(); removed += 1; }
                    }
                    return removed;
                }""",
                keep,
            ) or 0)
        except Exception:
            return 0

    async def _dropdown_committed_state(self, locator: Any) -> dict[str, str]:
        """Committed-selection signals only — never the container-innerText
        fallback (it returns the QUESTION text on empty react-selects) and
        never bare typed input text."""
        try:
            state = await locator.evaluate(
                """(el) => {
                    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
                    if (el.tagName && el.tagName.toLowerCase() === 'select') {
                        const opt = el.selectedOptions && el.selectedOptions[0];
                        return {committed: clean(opt ? opt.textContent : ''), raw_value: ''};
                    }
                    // Tightest root FIRST. '.select' is generic enough to wrap
                    // several demographic questions at once, and climbing to it
                    // made two different dropdowns report the same value.
                    const roots = [
                        el.closest('.select__control'),
                        el.closest('[class*="select-shell"]'),
                        el.closest('.select__container'),
                        el.closest('.select'),
                        el.closest('[role="group"]'),
                        el.parentElement,
                    ].filter(Boolean);
                    const placeholder = (value) => {
                        const key = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                        return !key || key === 'select' || key.startsWith('select ') || key === 'choose' || key === 'choose one';
                    };
                    for (const root of roots) {
                        const selected = root.querySelector('.select__single-value, [class*="singleValue"], [class*="single-value"]');
                        const selectedText = clean(selected && selected.textContent);
                        if (selectedText && !placeholder(selectedText)) return {committed: selectedText, raw_value: clean(el.value)};
                        // A MULTI select renders one chip per selection, so the
                        // container's textContent glues them together: "White"
                        // + "Two or More Races" came back as
                        // "WhiteTwo or More Races", which matches
                        // nothing and reads like corruption. Collect the chips.
                        const chips = Array.from(root.querySelectorAll(
                            '.select__multi-value__label, [class*="multi-value__label"], [class*="multiValue"] [class*="label"]'))
                            .map((node) => clean(node.textContent))
                            .filter((text) => text && !placeholder(text));
                        if (chips.length) {
                            return {committed: chips.join(', '), raw_value: clean(el.value), multi: true};
                        }
                        const valueContainer = root.querySelector('.select__value-container--has-value, [class*="value-container--has-value"]');
                        const valueText = clean(valueContainer && valueContainer.textContent);
                        if (valueText && !placeholder(valueText)) return {committed: valueText, raw_value: clean(el.value)};
                        const selectedOption = root.querySelector('[aria-selected="true"], [data-selected="true"]');
                        const optionText = clean(selectedOption && selectedOption.textContent);
                        if (optionText && !placeholder(optionText)) return {committed: optionText, raw_value: clean(el.value)};
                    }
                    return {committed: '', raw_value: clean(el.value)};
                }"""
            )
            return {
                "committed": str((state or {}).get("committed") or ""),
                "raw_value": str((state or {}).get("raw_value") or ""),
            }
        except Exception:
            return {"committed": "", "raw_value": ""}

    async def _dropdown_committed_match(
        self, locator: Any, expected: Any, field: dict[str, Any] | None = None
    ) -> bool:
        """Accept only states a form submit would actually carry: a rendered
        committed selection, or a backing-input value that maps to an
        extractor option (hidden backing inputs). Typed-but-uncommitted
        typeahead text and question-text reads never match."""
        state = await self._dropdown_committed_state(locator)
        committed = state["committed"]
        if committed and (
            self._value_matches("dropdown", expected, committed)
            or self._matches_option_value(field, expected, committed)
        ):
            return True
        raw_value = state["raw_value"]
        return bool(raw_value) and self._matches_option_value(field, expected, raw_value)

    async def _dropdown_matches(
        self, locator: Any, expected: Any, field: dict[str, Any] | None = None
    ) -> bool:
        actual = await self._dropdown_text(locator)
        if self._value_matches("dropdown", expected, actual):
            return True
        return self._matches_option_value(field, expected, actual)

    def _matches_option_value(
        self, field: dict[str, Any] | None, expected: Any, actual: Any
    ) -> bool:
        """Custom widgets often expose only the option VALUE (e.g. '1') while
        the answer names the TEXT ('Yes'); the extractor's {text, value} pairs
        translate between the two."""
        if not field:
            return False
        actual_key = _normalize_key(str(actual or ""))
        if not actual_key:
            return False
        for option in field.get("options") or field.get("available_options") or []:
            if not isinstance(option, dict):
                continue
            value_key = _normalize_key(str(option.get("value") or ""))
            text = str(option.get("text") or option.get("label") or "")
            if value_key and value_key == actual_key and self._option_matches(expected, text):
                return True
        return False

    def _value_matches(self, field_type: str, expected: Any, actual: Any) -> bool:
        if actual is None:
            return False
        if field_type == "checkbox":
            return bool(actual) == _truthy(expected)
        if field_type in {"checkbox_group", "radio_group"}:
            if isinstance(expected, list):
                actual_key = _normalize_key(str(actual or ""))
                return all(_normalize_key(str(item)) in actual_key for item in expected if str(item).strip())
            return self._option_matches(expected, actual)
        actual_text = _normalize(str(actual or ""))
        if not actual_text or _placeholderish(actual_text):
            return False
        if field_type in {"dropdown", "select", "combobox"}:
            return self._option_matches(expected, actual_text)
        if field_type == "phone":
            expected_digits = re.sub(r"\D+", "", str(expected or ""))
            actual_digits = re.sub(r"\D+", "", actual_text)
            return bool(expected_digits and actual_digits and (expected_digits == actual_digits or actual_digits.endswith(expected_digits[-10:])))
        return actual_text == _normalize(str(expected or ""))

    async def _verify_fields(
        self,
        target: Any,
        fields: list[dict[str, Any]],
        answers: dict[str, Any],
        controls: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        checks: list[dict[str, Any]] = []
        for field in fields:
            answer = _answer_for_field(field, answers)
            if answer in (None, ""):
                continue
            check = await self._verify_one(target, field, answer, controls)
            checks.append(check)
        return {
            "checked": len(checks),
            "passed": len([check for check in checks if check.get("pass")]),
            "failed": len([check for check in checks if not check.get("pass")]),
            "checks": checks,
        }

    async def _verify_one(
        self,
        target: Any,
        field: dict[str, Any],
        answer: Any,
        controls: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        field_type = str(field.get("type") or "text").lower()
        required = bool(field.get("required"))
        check = {
            "id": _field_key(field),
            "label": field.get("label", ""),
            "type": field_type,
            "required": required,
            "expected": answer,
            "actual": "",
            "pass": False,
        }
        locator = await self._locator_for_field(target, field, controls)
        if locator is None:
            if field_type == "file":
                uploaded = await self._confirmed_uploaded_file_text(target, answer)
                check["actual"] = uploaded or "<not found>"
                check["pass"] = bool(uploaded)
            else:
                check["actual"] = "<not found>"
                # Conditionally-hidden controls (Race disappears when
                # Hispanic/Latino is answered 'Decline') aren't fill failures —
                # the form genuinely has no such field in this state.
                check["control_missing"] = True
            return check
        if field_type != "file" and await self._element_is_disabled(locator):
            check["actual"] = "<disabled>"
            check["control_disabled"] = True
            return check
        try:
            if field_type == "file":
                uploaded = await self._confirmed_uploaded_file_text(target, answer)
                manual = await self._manual_file_text_present(target, field)
                upload_error = await self._file_upload_error_text(target, field)
                actual_parts = [part for part in (uploaded, manual, upload_error) if part]
                check["actual"] = " | ".join(actual_parts) if actual_parts else "<not confirmed>"
                check["pass"] = bool(uploaded or manual) and not upload_error
            elif field_type == "checkbox":
                checked = await locator.is_checked(timeout=ACTION_TIMEOUT_MS)
                check["actual"] = checked
                check["pass"] = self._value_matches("checkbox", answer, checked)
            elif field_type in {"checkbox_group", "radio_group"}:
                check["actual"] = await self._selected_group_text(target, locator)
                check["pass"] = self._value_matches(field_type, answer, check["actual"])
            elif field_type in {"dropdown", "select", "combobox"}:
                if await self._element_is_choice_input(locator):
                    check["actual"] = await self._selected_group_text(target, locator)
                    check["pass"] = self._value_matches("radio_group", answer, check["actual"]) or (
                        self._matches_option_value(field, answer, check["actual"])
                    )
                else:
                    # Committed evidence only — the loose innerText read is what
                    # verified empty dropdowns (question text implying 'yes')
                    # and wrong typeahead picks as green.
                    state = await self._dropdown_committed_state(locator)
                    check["actual"] = state["committed"] or state["raw_value"] or "<uncommitted>"
                    check["pass"] = await self._dropdown_committed_match(locator, answer, field)
            else:
                value = await locator.input_value(timeout=ACTION_TIMEOUT_MS)
                check["actual"] = value
                expected = await self._expected_text_for_locator(locator, answer)
                check["expected"] = expected
                check["pass"] = self._value_matches(field_type, expected, value)
        except Exception as exc:
            check["actual"] = f"{type(exc).__name__}: {exc}"
        return check

    async def _expected_text_for_locator(self, locator: Any, answer: Any) -> str:
        expected = str(answer or "")
        try:
            max_length = await locator.evaluate(
                """(el) => {
                    const direct = Number(el.maxLength || el.getAttribute('maxlength') || 0);
                    if (direct > 0) return direct;
                    const input = el.querySelector && el.querySelector('input, textarea');
                    return input ? Number(input.maxLength || input.getAttribute('maxlength') || 0) : 0;
                }"""
            )
            if max_length and max_length > 0 and len(expected) > max_length:
                return expected[:max_length]
        except Exception:
            pass
        return expected

    def _check_has_answer(self, check: dict[str, Any]) -> bool:
        actual = check.get("actual")
        if isinstance(actual, bool):
            return actual
        text = _normalize(str(actual or ""))
        return bool(text and text != "<not found>" and not _placeholderish(text))

    async def _file_name_visible(self, target: Any, filename: str) -> bool:
        try:
            return bool(
                await target.evaluate(
                    """(filename) => {
                        const text = (document.body && document.body.innerText) || '';
                        return !!(filename && text.includes(filename));
                    }""",
                    filename,
                )
            )
        except Exception:
            return False

    async def _confirmed_uploaded_file_text(self, target: Any, answer: Any) -> str:
        filename = Path(str(answer or "")).name
        try:
            return await target.evaluate(
                """(filename) => {
                    const text = (document.body && document.body.innerText) || '';
                    if (filename && text.includes(filename)) return filename;
                    const uploadText = Array.from(document.querySelectorAll('[class*="upload"], [class*="file"], [data-testid*="upload"]'))
                        .map((node) => (node.innerText || node.textContent || '').trim())
                        .filter(Boolean)
                        .join(' | ');
                    return uploadText.includes(filename) ? filename : '';
                }""",
                filename,
            )
        except Exception:
            return ""

    async def _manual_file_text_present(self, target: Any, field: dict[str, Any]) -> str:
        field_id = str(field.get("id") or field.get("name") or "").strip()
        label_key = _normalize_key(str(field.get("label") or ""))
        selectors = []
        if field_id:
            safe_id = self._css_escape(field_id)
            selectors.extend([f"#{safe_id}_text", f'[name="{field_id}_text"]'])
        if "resume" in label_key or "cv" in label_key:
            selectors.extend(["#resume_text", '[name="resume_text"]'])
        elif "cover letter" in label_key:
            selectors.extend(["#cover_letter_text", '[name="cover_letter_text"]'])
        selectors.append("textarea")
        for selector in selectors:
            try:
                locator = target.locator(selector).first
                if not await locator.count():
                    continue
                value = await locator.input_value(timeout=500)
                if len(_normalize(value)) >= 50:
                    return "manual_text"
            except Exception:
                continue
        return ""

    async def _file_upload_error_text(self, target: Any, field: dict[str, Any]) -> str:
        field_id = str(field.get("id") or field.get("name") or "").strip()
        label_key = _normalize_key(str(field.get("label") or ""))
        try:
            return await target.evaluate(
                """(args) => {
                    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
                    const key = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                    const visible = (el) => {
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                    };
                    const fieldId = args.fieldId || '';
                    const labelKey = args.labelKey || '';
                    const roots = [];
                    if (fieldId) {
                        const input = document.getElementById(fieldId);
                        if (input) roots.push(input.closest('.file-upload, .field-wrapper, [role="group"]') || input.parentElement);
                    }
                    for (const root of Array.from(document.querySelectorAll('.file-upload, .field-wrapper, [role="group"]'))) {
                        const textKey = key(root.innerText || root.textContent || '');
                        if (labelKey && textKey.includes(labelKey)) roots.push(root);
                    }
                    const seen = new Set();
                    for (const root of roots) {
                        if (!root || seen.has(root)) continue;
                        seen.add(root);
                        const errors = Array.from(root.querySelectorAll('[aria-invalid="true"], [role="alert"], [id$="-error"], .helper-text--error, .error, .field-error'))
                            .filter((el) => visible(el))
                            .map((el) => clean(el.innerText || el.textContent || el.getAttribute('aria-label') || ''))
                            .filter(Boolean)
                            .filter((text) => !/^accepted file types/i.test(text));
                        if (errors.length) return errors.join(' | ');
                    }
                    return '';
                }""",
                {"fieldId": field_id, "labelKey": label_key},
            )
        except Exception:
            return ""

    async def _selected_group_text(self, target: Any, locator: Any) -> str:
        name = await locator.get_attribute("name", timeout=500) or ""
        if not name:
            return "checked" if await locator.is_checked(timeout=ACTION_TIMEOUT_MS) else ""
        escaped_name = name.replace('"', '\\"')
        return await target.evaluate(
            """(selector) => Array.from(document.querySelectorAll(selector))
                .filter((input) => input.checked)
                .map((input) => {
                    const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
                    const wrapping = input.closest('label');
                    return ((label && label.textContent) || (wrapping && wrapping.textContent) || input.value || '').trim();
                })
                .join(', ')""",
            f'input[name="{escaped_name}"]',
        )

    async def _dropdown_text(self, locator: Any) -> str:
        try:
            return await locator.evaluate(
                """(el) => {
                    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
                    if (el.tagName && el.tagName.toLowerCase() === 'select') {
                        return clean(el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent : el.value);
                    }
                    if ('value' in el && clean(el.value)) return clean(el.value);
                    // Tightest root FIRST. '.select' is generic enough to wrap
                    // several demographic questions at once, and climbing to it
                    // made two different dropdowns report the same value.
                    const roots = [
                        el.closest('.select__control'),
                        el.closest('[class*="select-shell"]'),
                        el.closest('.select__container'),
                        el.closest('.select'),
                        el.closest('[role="group"]'),
                        el.parentElement,
                    ].filter(Boolean);
                    const placeholder = (value) => {
                        const key = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                        return !key || key === 'select' || key === 'select one' || key === 'select an option' || key === 'choose' || key === 'choose one' || key.startsWith('select ');
                    };
                    for (const root of roots) {
                        const selected = root.querySelector('.select__single-value, [class*="singleValue"], [class*="single-value"]');
                        const selectedText = clean(selected && selected.textContent);
                        if (selectedText) return selectedText;
                        const valueContainer = root.querySelector('.select__value-container--has-value, [class*="value-container--has-value"]');
                        const valueText = clean(valueContainer && valueContainer.textContent);
                        if (valueText) return valueText;
                        const selectedOption = root.querySelector('[aria-selected="true"], [data-selected="true"]');
                        const optionText = clean(selectedOption && selectedOption.textContent);
                        if (optionText && !placeholder(optionText)) return optionText;
                        const rootText = clean(root.innerText || root.textContent);
                        if (rootText && rootText.length < 300 && !placeholder(rootText)) return rootText;
                    }
                    return '';
                }"""
            )
        except Exception:
            try:
                return await locator.input_value(timeout=ACTION_TIMEOUT_MS)
            except Exception:
                return ""

    def _should_use_otp_lock(self) -> bool:
        if self.otp_lock_mode in {"off", "false", "0", "none"}:
            return False
        if self.otp_mode in {"off", "false", "0", "none", "manual"}:
            return False
        return self.imap_config_path.exists()

    def _build_imap_reader(self) -> ImapOtpReader:
        if not HAS_IMAP_OTP:
            raise RuntimeError(f"IMAP OTP reader unavailable: {IMAP_IMPORT_ERROR}")
        cfg = load_imap_config(self.imap_config_path)
        return ImapOtpReader(
            host=cfg["host"],
            port=int(cfg.get("port", 993)),
            username=cfg["username"],
            password=cfg["password"],
            timeout_seconds=self.otp_timeout_seconds,
        )

    def _otp_mailbox_key(self) -> str:
        account = str(self.imap_config_path.resolve())
        return mailbox_lock_key("imap", account)

    def _otp_hints_from_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        form_context = payload.get("form_context") if isinstance(payload.get("form_context"), dict) else {}
        url = str(payload.get("original_url") or payload.get("apply_url") or payload.get("url") or "")
        iframe_url = str(form_context.get("iframe_url") or "")
        parsed = _parse_greenhouse_url(iframe_url or url)
        company = str(payload.get("company") or parsed.get("board_token") or "")
        return {
            "company": company,
            "company_slug": str(payload.get("company_slug") or parsed.get("board_token") or ""),
            "job_id": str(payload.get("job_id") or parsed.get("job_id") or ""),
            "job_title": str(payload.get("job_title") or ""),
            "url": url,
        }

    def _redact_otp_lock_result(self, payload: dict[str, Any]) -> dict[str, Any]:
        redacted = json.loads(json.dumps(payload, default=str))
        mailbox = str(redacted.get("mailbox_key") or "")
        if mailbox:
            redacted["mailbox_key"] = mailbox.split(":", 1)[0] + ":<redacted>"
        acquire = redacted.get("acquire") if isinstance(redacted.get("acquire"), dict) else {}
        if acquire.get("mailbox_key"):
            acquire["mailbox_key"] = str(acquire["mailbox_key"]).split(":", 1)[0] + ":<redacted>"
        if acquire.get("account"):
            acquire["account"] = "<redacted>"
        snapshot = redacted.get("snapshot") if isinstance(redacted.get("snapshot"), dict) else {}
        if "message_ids" in snapshot:
            snapshot["message_ids"] = [f"<{len(snapshot.get('message_ids') or [])} message ids redacted>"]
        return redacted

    def _recovery_otp_lock_spec(self, grant_path: Path) -> dict[str, Any] | None:
        """Spec handed to attempt_recovery so the fix-mode agent gets the
        acquire_otp_lock tool (called right before its Submit click)."""
        if not self._should_use_otp_lock():
            return None
        return {
            "mailbox_key": self._otp_mailbox_key(),
            "lock_dir": str(self.otp_lock_dir) if self.otp_lock_dir else "",
            "imap_config": str(self.imap_config_path),
            "timeout_s": min(self.otp_lock_timeout_seconds, 300),
            "stale_s": self.otp_lock_stale_seconds,
            "grant_path": str(grant_path),
            "job_id": str(self._otp_hints.get("job_id", "")),
            "pkg_root": str(Path(__file__).resolve().parent.parent),
        }

    async def _recovery_otp_handoff(
        self, page: Any, target: Any, grant_path: Path, result: dict[str, Any]
    ) -> dict[str, Any] | None:
        """After a fix-mode recovery: if the page now shows the OTP challenge,
        run the script's own IMAP flow. Two entry shapes:
        - grant file exists: the agent submitted under the lock tool — adopt
          its inbox snapshot (agent-era emails only); lock is already held.
        - no grant (fix mode only): the challenge was reached without the
          agent taking the lock (e.g. the deterministic click actually fired
          but was mislabeled) — take a FRESH lock and scope emails by the
          deterministic submit-start time."""
        grant: dict[str, Any] | None = None
        try:
            grant = json.loads(grant_path.read_text(encoding="utf-8"))
        except Exception:
            grant = None
        if grant is None and (result.get("recovery") or {}).get("mode") != "fix":
            return None
        state = await self._submit_state(target)
        if state.get("error"):
            state = await self._submit_state(page)
        if not state.get("otp_required"):
            return None

        fresh_lock: MailboxOtpLock | None = None
        if grant is not None:
            self._log("otp.handoff", grant=True, note="agent submit triggered OTP; script takes over")
            submitted_at = datetime.now(timezone.utc)
            try:
                epoch = float(grant.get("acquired_epoch") or 0)
                if epoch:
                    submitted_at = datetime.fromtimestamp(epoch, tz=timezone.utc)
            except Exception:
                pass
            snapshot = grant.get("snapshot") if isinstance(grant.get("snapshot"), dict) else None
            if snapshot and snapshot.get("status") != "ok":
                snapshot = None
        else:
            self._log("otp.handoff", grant=False,
                      note="OTP challenge present without a lock grant; taking a fresh lock")
            submitted_at = self._last_submit_started_at or (
                datetime.now(timezone.utc) - timedelta(minutes=15)
            )
            snapshot = None
            try:
                fresh_lock = MailboxOtpLock(
                    self._otp_mailbox_key(),
                    lock_dir=self.otp_lock_dir,
                    timeout_seconds=min(self.otp_lock_timeout_seconds, 300),
                    stale_seconds=self.otp_lock_stale_seconds,
                    metadata={"held_for": "otp_handoff_no_grant",
                              "job_id": str(self._otp_hints.get("job_id", ""))},
                )
                await asyncio.to_thread(fresh_lock.acquire)
            except Exception as exc:
                self._log("otp.handoff.error", error=f"lock: {type(exc).__name__}: {exc}")
                return None

        try:
            otp_submission = await self._handle_otp_challenge(
                target, submitted_at, state,
                reader=self._build_imap_reader(),
                snapshot=snapshot,
            )
        except Exception as exc:
            self._log("otp.handoff.error", error=f"{type(exc).__name__}: {exc}")
            return None
        finally:
            if fresh_lock is not None:
                try:
                    await asyncio.to_thread(fresh_lock.release)
                except Exception:
                    pass
        recovery = result.setdefault("recovery", {})
        recovery["otp_handoff"] = self._redact_otp_result(otp_submission)
        if otp_submission.get("status") == "submitted":
            self._log("otp.handoff.confirmed")
            return {"status": "submitted", "reason": "recovered by AI agent + OTP"}
        self._log("otp.handoff.failed", status=otp_submission.get("status"))
        return None

    def _release_recovery_lock(self, grant_path: Path) -> None:
        """Adopt the agent-acquired mailbox lock via the grant file and release
        it. Runs in a finally — no orphaned locks whatever the agent did."""
        if not grant_path.exists():
            return
        try:
            grant = json.loads(grant_path.read_text(encoding="utf-8"))
            lock = MailboxOtpLock(
                str(grant.get("mailbox_key") or self._otp_mailbox_key()),
                lock_dir=(grant.get("lock_dir") or None) or self.otp_lock_dir,
            )
            lock.owner_token = str(grant.get("owner_token") or "")
            lock.acquired = True
            released = lock.release()
            self._log("otp.lock.released", released=released.get("released"),
                      reason=released.get("reason"))
        except Exception as exc:
            self._log("otp.lock.release_error", error=f"{type(exc).__name__}: {exc}")
        finally:
            try:
                grant_path.unlink(missing_ok=True)
            except Exception:
                pass

    async def _stamp_form_document(self, target: Any) -> None:
        """Mark the document the form was found in, so submit can tell it is
        still the same one. A URL comparison cannot: SPAs rewrite the URL in
        place, and a navigation can land on a URL that still carries the job
        id. A property on the document's window dies with the document."""
        self._form_doc_token = uuid.uuid4().hex
        try:
            await target.evaluate("(t) => { window.__jobscan_form_doc__ = t; }", self._form_doc_token)
        except Exception:
            self._form_doc_token = ""

    async def _form_document_intact(self, target: Any) -> bool:
        token = getattr(self, "_form_doc_token", "")
        if not token:
            return True  # never stamped -- no evidence either way
        try:
            got = await target.evaluate("() => window.__jobscan_form_doc__ || ''")
        except Exception:
            return False  # the frame itself is gone
        return got == token

    async def _submit(self, target: Any, page: Any = None) -> dict[str, Any]:
        if self._should_use_otp_lock():
            return await self._submit_with_otp_lock(target, page)
        return await self._submit_without_otp_lock(target, page)

    async def _submit_with_otp_lock(self, target: Any, page: Any = None) -> dict[str, Any]:
        reader = self._build_imap_reader()
        lock = MailboxOtpLock(
            self._otp_mailbox_key(),
            lock_dir=self.otp_lock_dir,
            timeout_seconds=self.otp_lock_timeout_seconds,
            stale_seconds=self.otp_lock_stale_seconds,
            metadata={
                "provider": "imap",
                "account": str(self.imap_config_path),
                "job_title": self._otp_hints.get("job_title", ""),
                "company": self._otp_hints.get("company", ""),
                "job_id": self._otp_hints.get("job_id", ""),
                "url": self._otp_hints.get("url", ""),
            },
        )
        lock_metadata = await asyncio.to_thread(lock.acquire)
        self._log("otp.lock", waited_s=lock_metadata.get("waited_seconds"),
                  attempts=lock_metadata.get("attempts"))
        snapshot = await asyncio.to_thread(
            reader.snapshot_message_ids,
            after=datetime.now(timezone.utc),
            hints=self._otp_hints,
        )
        submission: dict[str, Any] = {}
        release_result: dict[str, Any] = {}
        try:
            submission = await self._submit_without_otp_lock(
                target,
                page,
                otp_reader=reader,
                otp_snapshot=snapshot,
            )
            return submission
        finally:
            try:
                release_result = await asyncio.to_thread(lock.release)
            except Exception as exc:  # release is total, but a submitted
                # result must never be destructible by cleanup — belt+braces.
                release_result = {"released": False, "reason": f"{type(exc).__name__}: {exc}"}
                self._log("otp.lock.release_error", error=release_result["reason"])
            if submission is not None:
                submission["otp_lock"] = self._redact_otp_lock_result(
                    {
                        "enabled": True,
                        "mode": self.otp_lock_mode,
                        "mailbox_key": self._otp_mailbox_key(),
                        "acquire": lock_metadata,
                        "release": release_result,
                        "snapshot": snapshot,
                    }
                )

    async def _state_after_click(self, target: Any, page: Any) -> tuple[dict[str, Any], Any]:
        """Post-click state read that survives a detaching frame: try the form
        target first; when it errors (page re-rendered into the OTP view),
        fall back to the main page and continue operating there."""
        state = await self._submit_state(target)
        if state.get("error") and page is not None and page is not target:
            page_state = await self._submit_state(page)
            if not page_state.get("error"):
                return page_state, page
        return state, target

    async def _submit_without_otp_lock(
        self,
        target: Any,
        page: Any = None,
        *,
        otp_reader: ImapOtpReader | None = None,
        otp_snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        selectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            'button:has-text("Submit Application")',
            'button:has-text("Submit")',
        ]
        submitted_at = datetime.now(timezone.utc)
        self._last_submit_started_at = submitted_at
        before_state = await self._submit_state(target)
        if self._looks_submitted_state(before_state):
            return {
                "status": "submitted",
                "reason": "already_on_confirmation_state",
                "before": before_state,
            }
        if before_state.get("otp_required"):
            if otp_snapshot is not None:
                return {
                    "status": "otp_required",
                    "reason": "OTP challenge was already visible before this submit; no fresh Greenhouse OTP was requested",
                    "after": before_state,
                }
            return await self._handle_otp_challenge(
                target,
                submitted_at,
                before_state,
                reader=otp_reader,
                snapshot=None,
            )
        # Phase 1 — achieve exactly ONE click. A selector whose click throws
        # means the click did not fire (same semantics as before); stopping at
        # the first success also removes the old cross-selector double-click
        # hazard.
        clicked_selector = None
        for selector in selectors:
            try:
                locator = target.locator(selector).first
                if await locator.count() and await locator.is_visible(timeout=500):
                    await locator.click(timeout=ACTION_TIMEOUT_MS)
                    clicked_selector = selector
                    break
            except Exception:
                continue
        if clicked_selector is None:
            status = "submitted" if self._looks_submitted_state(before_state) else "submit_not_found"
            return {"status": status, "before": before_state}

        # Phase 2 — a fired click NEVER falls through to submit_not_found.
        # The page may re-render into the OTP view mid-transition and detach
        # the form frame (root cause of one OTP application mislabelled: the state read
        # threw, the old except-continue swallowed the click, and the OTP
        # email went unread). Every step degrades to the page-level fallback.
        try:
            await target.wait_for_timeout(4_000)
        except Exception:
            await asyncio.sleep(4)
        after_state, live = await self._state_after_click(target, page)
        retried = False
        try:
            if self._submit_should_retry(before_state, after_state):
                retried = await self._retry_submit_click(live)
                if retried:
                    try:
                        await live.wait_for_timeout(20_000)
                    except Exception:
                        await asyncio.sleep(20)
                    after_state, live = await self._state_after_click(live, page)
        except Exception:
            pass
        # A "clicked" verdict means the submit landed but no confirmation has
        # appeared YET. Greenhouse had no re-check at all, so that went straight
        # to a recovery agent -- 27s of agent time for an answer that usually
        # arrives on its own within a second or two.
        async def _reclassify():
            nonlocal after_state, live
            after_state, live = await self._state_after_click(live, page)
            return {"status": self._classify_submit_state(before_state, after_state)}

        status = self._classify_submit_state(before_state, after_state)
        if status in UNSETTLED_STATUSES:
            settled = await settle_submission(_reclassify, attempts=4, delay_s=1.5)
            status = (settled or {}).get("status") or status
        submission = {
            "status": status,
            "selector": clicked_selector,
            "retried": retried,
            "before": before_state,
            "after": after_state,
        }
        network = getattr(self, "_network_responses", None)
        if network:
            submission["network"] = network
        accepted = getattr(self, "_network_accepted", None)
        if accepted:
            submission["reason"] = f"board accepted: HTTP {accepted.get('status')} {accepted.get('url')}"
        if status == "otp_required":
            otp_submission = await self._handle_otp_challenge(
                live,
                submitted_at,
                after_state,
                reader=otp_reader,
                snapshot=otp_snapshot,
            )
            submission["otp"] = self._redact_otp_result(otp_submission)
            submission["status"] = otp_submission.get("status", status)
            submission["after_otp"] = otp_submission.get("after")
        return submission

    def _classify_submit_state(self, before_state: dict[str, Any], after_state: dict[str, Any]) -> str:
        if self._looks_submitted_state(after_state):
            return "submitted"
        if after_state.get("otp_required"):
            return "otp_required"
        if after_state.get("captcha_visible"):
            return "blocked_captcha"
        if after_state.get("submit_button_count", 0) == 0 or after_state.get("form_count", 0) < before_state.get("form_count", 0):
            # Submit controls being gone is only meaningful while we are still
            # on the job's own page. Closed postings redirect to the company
            # job BOARD (no submit buttons there either) — that page was being
            # classified submitted, recording applications that never happened.
            if self._looks_board_redirect_state(after_state):
                return "posting_closed"
            return "submitted"
        if after_state.get("validation_error_count", 0) > 0:
            return "validation_errors"
        # Nothing on the page says it worked. Before handing this to recovery --
        # which is instructed to complete and SUBMIT -- check whether the board
        # already told us it accepted the application. Strictly a tiebreaker:
        # it can only turn "clicked" into "submitted", never the reverse.
        accepted = accepted_by_network(getattr(self, "_network_responses", None))
        if accepted:
            self._network_accepted = accepted
            return "submitted"
        return "clicked"

    def _looks_board_redirect_state(self, state: dict[str, Any]) -> bool:
        url = str(state.get("url") or "").lower()
        if "error=true" in url:
            return True
        job_id = str(getattr(self, "_current_job_id", "") or "")
        if job_id and job_id not in url and "confirmation" not in url and "thank" not in url:
            text = str(state.get("body_text_sample") or "").lower()
            if not any(marker in text for marker in (
                "received your application",
                "application has been submitted",
                "thank you for applying",
                "thanks for applying",
            )):
                return True
        return False

    def _looks_submitted_state(self, state: dict[str, Any]) -> bool:
        """A confirmation URL or past-tense confirmation wording is decisive.

        This used to be gated behind "the form and the submit button are both
        gone", checked FIRST, so a page that says it succeeded was rejected
        before its URL or text was ever read. A Greenhouse confirmation page
        fails that gate: it carries a "Sign in to MyGreenhouse" panel.

        One greenhouse application sat at
        .../jobs/<id>/confirmation reading "Thank you for applying. Your
        application has been received." and was still classified `clicked`,
        then spent a 22s / 125k-token AI recovery run rediscovering that it had
        already submitted. The old substring list would not have matched that
        page anyway -- it had "received your application" while Greenhouse
        writes "your application has been received".
        """
        if self._looks_board_redirect_state(state):
            return False
        if confirmation_url(state.get("url")):
            return True
        if confirmation_text(state.get("body_text_sample")):
            return True
        # No confirmation wording anywhere: the form being gone is not by itself
        # evidence of success, and _classify_submit_state handles that case.
        return False

    def _submit_should_retry(self, before_state: dict[str, Any], after_state: dict[str, Any]) -> bool:
        return (
            after_state.get("validation_error_count", 0) == 0
            and after_state.get("submit_button_count", 0) > 0
            and after_state.get("form_count", 0) >= before_state.get("form_count", 0)
            and not after_state.get("captcha_visible")
            and not after_state.get("otp_required")
        )

    async def _retry_submit_click(self, target: Any) -> bool:
        retry_selectors = [
            # Standard Greenhouse form submit
            'button:has-text("Submit application")',
            'button:has-text("Submit Application")',
            'button:has-text("Submit")',
            'input[type="submit"]',
            'button[type="submit"]',
            # OTP / verification screen confirm buttons
            'button:has-text("Verify")',
            'button:has-text("Verify code")',
            'button:has-text("Confirm")',
            'button:has-text("Continue")',
            'button:has-text("Done")',
        ]
        deadline = time.monotonic() + 15  # extra 5s — disabled buttons may take time to enable
        while time.monotonic() < deadline:
            for selector in retry_selectors:
                try:
                    locator = target.locator(selector).last
                    if not await locator.count():
                        continue
                    await locator.wait_for(state="visible", timeout=750)
                    disabled = await locator.evaluate(
                        """(el) => Boolean(
                            el.disabled
                            || el.getAttribute('aria-disabled') === 'true'
                            || el.closest('[aria-disabled="true"]')
                        )"""
                    )
                    if disabled:
                        continue
                    await self._safe_scroll_into_view(locator)
                    await locator.click(timeout=ACTION_TIMEOUT_MS, force=True)
                    return True
                except Exception:
                    continue
            await target.wait_for_timeout(800)  # slightly longer pause so async validation completes
        return False

    async def _handle_otp_challenge(
        self,
        target: Any,
        submitted_at: datetime,
        state: dict[str, Any],
        *,
        reader: ImapOtpReader | None = None,
        snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if self.otp_mode in {"off", "false", "0", "none"}:
            return {
                "status": "otp_required",
                "reason": "OTP challenge detected and OTP handling is disabled",
                "after": state,
            }
        if self.otp_mode == "manual":
            return {
                "status": "otp_required",
                "reason": "OTP challenge detected; manual mode leaves tab open",
                "after": state,
            }

        reader = reader or self._build_imap_reader()
        self._log("otp.wait", timeout_s=self.otp_timeout_seconds)
        if snapshot is not None:
            otp_result = await asyncio.to_thread(
                reader.wait_for_code_after_snapshot,
                after=submitted_at,
                snapshot=snapshot,
                page_text=str(state.get("body_text_sample") or ""),
                hints=self._otp_hints,
            )
        else:
            otp_result = await asyncio.to_thread(
                reader.wait_for_code,
                after=submitted_at,
                page_text=str(state.get("body_text_sample") or ""),
                hints=self._otp_hints,
            )
        self._log("otp.email", status=otp_result.get("status"),
                  subject=otp_result.get("subject"), received_at=otp_result.get("received_at"))
        if otp_result.get("status") not in {"found", "found_recent"}:
            status = "otp_timeout" if otp_result.get("status") == "timeout" else "otp_unavailable"
            self._log("otp.outcome", status=status, reason=otp_result.get("reason"))
            return {
                "status": status,
                "reason": otp_result.get("reason") or otp_result.get("status"),
                "otp": self._redact_otp_result(otp_result),
                "after": state,
            }

        code = str(otp_result.get("code") or "").strip()
        filled = await self._fill_otp_code(target, code)
        self._log("otp.fill", ok=filled.get("ok"), strategy=filled.get("strategy"),
                  inputs=filled.get("input_count"))
        if not filled.get("ok"):
            self._log("otp.outcome", status="otp_failed", reason=filled.get("reason"))
            return {
                "status": "otp_failed",
                "reason": filled.get("reason", "OTP inputs could not be filled"),
                "otp": self._redact_otp_result(otp_result),
                "after": state,
            }

        await target.wait_for_timeout(500)
        clicked = await self._retry_submit_click(target)
        if clicked:
            await target.wait_for_timeout(6_000)
        final_state = await self._submit_state(target)
        status = self._classify_submit_state(state, final_state)
        retry_result: dict[str, Any] | None = None
        if status == "otp_required" and self._otp_rejected(final_state):
            retry_result = await self._retry_otp_after_rejection(
                target,
                reader,
                submitted_at,
                otp_result,
                final_state,
            )
            if retry_result.get("status") == "submitted":
                return retry_result
            final_state = retry_result.get("after") or final_state
            status = "otp_rejected"
        if status == "otp_required":
            status = "otp_rejected" if self._otp_rejected(final_state) else "otp_failed"
        self._log("otp.outcome", status=status, retried=retry_result is not None)
        return {
            "status": status,
            "reason": "OTP filled via IMAP" if status == "submitted" else "OTP step did not transition to submitted",
            "otp": self._redact_otp_result(otp_result),
            "otp_fill": filled,
            "otp_submit_clicked": clicked,
            "otp_retry": self._redact_otp_result(retry_result) if retry_result else None,
            "before": state,
            "after": final_state,
        }

    async def _retry_otp_after_rejection(
        self,
        target: Any,
        reader: ImapOtpReader,
        submitted_at: datetime,
        previous_otp: dict[str, Any],
        rejection_state: dict[str, Any],
    ) -> dict[str, Any]:
        retry_after = submitted_at
        received_at = str(previous_otp.get("received_at") or "")
        if received_at:
            try:
                parsed = datetime.fromisoformat(received_at.replace("Z", "+00:00"))
                retry_after = max(submitted_at, parsed)
            except Exception:
                retry_after = submitted_at
        cfg = load_imap_config(self.imap_config_path)
        retry_reader = ImapOtpReader(
            host=cfg["host"],
            port=int(cfg.get("port", 993)),
            username=cfg["username"],
            password=cfg["password"],
            timeout_seconds=min(max(30, self.otp_timeout_seconds), 90),
            poll_seconds=2,
        )
        retry_otp = await asyncio.to_thread(
            retry_reader.wait_for_code,
            after=retry_after,
            page_text=str(rejection_state.get("body_text_sample") or ""),
            exclude_message_ids={str(previous_otp.get("message_id") or "")},
            hints=self._otp_hints,
        )
        if retry_otp.get("status") != "found":
            return {
                "status": "otp_rejected",
                "reason": "Greenhouse rejected the first OTP and no newer OTP email was found",
                "otp": self._redact_otp_result(retry_otp),
                "after": rejection_state,
            }
        code = str(retry_otp.get("code") or "").strip()
        filled = await self._fill_otp_code(target, code)
        if not filled.get("ok"):
            return {
                "status": "otp_failed",
                "reason": filled.get("reason", "Retry OTP inputs could not be filled"),
                "otp": self._redact_otp_result(retry_otp),
                "after": rejection_state,
            }
        clicked = await self._retry_submit_click(target)
        if clicked:
            await target.wait_for_timeout(6_000)
        final_state = await self._submit_state(target)
        status = self._classify_submit_state(rejection_state, final_state)
        if status == "otp_required":
            status = "otp_rejected" if self._otp_rejected(final_state) else "otp_failed"
        return {
            "status": status,
            "reason": "OTP retry filled from IMAP" if status == "submitted" else "OTP retry did not transition to submitted",
            "otp": self._redact_otp_result(retry_otp),
            "otp_fill": filled,
            "otp_submit_clicked": clicked,
            "after": final_state,
        }

    def _otp_rejected(self, state: dict[str, Any]) -> bool:
        if state.get("otp_error_visible"):
            return True
        text = " ".join(str(item) for item in state.get("validation_errors") or [])
        return bool(re.search(r"invalid.*code|incorrect.*code|expired.*code|try again|code did not match", text, re.I))

    def _redact_otp_result(self, payload: dict[str, Any]) -> dict[str, Any]:
        redacted = dict(payload or {})
        code = str(redacted.pop("code", "") or "")
        if code:
            redacted["code_length"] = len(code)
        if redacted.get("context"):
            redacted["context"] = "<redacted>"
        return redacted

    async def _fill_otp_code(self, target: Any, code: str) -> dict[str, Any]:
        if not re.fullmatch(r"[A-Za-z0-9]{4,12}", code or ""):
            return {"ok": False, "reason": "OTP code shape was not fillable"}
        try:
            return await target.evaluate(
                """(code) => {
                    const visible = (el) => {
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                    };
                    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
                    const scoreInput = (el) => {
                        const attrs = [
                            el.id,
                            el.name,
                            el.getAttribute('aria-label'),
                            el.getAttribute('autocomplete'),
                            el.getAttribute('placeholder'),
                            el.closest('label') && el.closest('label').innerText,
                            el.closest('form') && el.closest('form').innerText,
                            el.parentElement && el.parentElement.innerText,
                        ].map(clean).join(' ').toLowerCase();
                        let score = 0;
                        if (/one[-\\s]?time|otp|verification|security|code|token/.test(attrs)) score += 8;
                        if (/security-input-\\d+/.test(el.id || '')) score += 8;
                        const maxLength = Number(el.maxLength || el.getAttribute('maxlength') || 0);
                        if (maxLength === 1) score += 4;
                        if (maxLength >= 4 && maxLength <= 12) score += 3;
                        if (['text', 'tel', 'number', 'password', ''].includes((el.type || '').toLowerCase())) score += 1;
                        return score;
                    };
                    const setValue = (el, value) => {
                        const prototype = Object.getPrototypeOf(el);
                        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
                            || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
                            || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
                        if (descriptor && descriptor.set) descriptor.set.call(el, value);
                        else el.value = value;
                        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                    };
                    const allInputs = Array.from(document.querySelectorAll('input, textarea'))
                        .filter((el) => visible(el) && !el.disabled && el.getAttribute('aria-hidden') !== 'true')
                        .filter((el) => !['hidden', 'button', 'submit', 'reset', 'file', 'checkbox', 'radio'].includes((el.type || '').toLowerCase()));
                    const scored = allInputs
                        .map((el, index) => ({ el, index, score: scoreInput(el), maxLength: Number(el.maxLength || el.getAttribute('maxlength') || 0) }))
                        .filter((item) => item.score > 0)
                        .sort((a, b) => b.score - a.score || a.index - b.index);
                    const split = scored
                        .filter((item) => item.maxLength === 1 || /security-input-\\d+/.test(item.el.id || ''))
                        .sort((a, b) => a.index - b.index);
                    if (split.length >= code.length) {
                        for (let i = 0; i < code.length; i += 1) setValue(split[i].el, code[i]);
                        const lastSplit = split[Math.min(code.length - 1, split.length - 1)].el;
                        // Fire Enter on last digit — triggers Greenhouse React onKeyDown advance logic
                        lastSplit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                        lastSplit.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                        lastSplit.blur();
                        return { ok: true, strategy: 'split_inputs', input_count: split.length };
                    }
                    const single = scored.find((item) => item.maxLength === 0 || item.maxLength >= code.length) || scored[0];
                    if (!single) return { ok: false, reason: 'no OTP-like input found', input_count: allInputs.length };
                    setValue(single.el, code);
                    // Fire Enter on single input to trigger submit if form listens for it
                    single.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                    single.el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                    single.el.blur();
                    return { ok: true, strategy: 'single_input', input_count: scored.length };
                }""",
                code,
            )
        except Exception as exc:
            return {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}

    async def _submit_state(self, target: Any) -> dict[str, Any]:
        try:
            return await target.evaluate(
                """() => {
                    const visible = (el) => {
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                    };
                    const submitButtons = Array.from(document.querySelectorAll('button, input[type="submit"]'))
                        .filter((el) => visible(el) && /submit|apply/i.test((el.innerText || el.value || el.getAttribute('aria-label') || '')));
                    const errors = Array.from(document.querySelectorAll('[aria-invalid="true"], [role="alert"], [id$="-error"], .error, .field-error'))
                        .filter((el) => visible(el) && String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim());
                    const captcha = Array.from(document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [class*="recaptcha"], [class*="hcaptcha"], .g-recaptcha'))
                        .some((el) => {
                            if (!visible(el)) return false;
                            if (el.closest && el.closest('.grecaptcha-badge')) return false;
                            const src = String(el.getAttribute('src') || '').toLowerCase();
                            const className = String(el.className || '').toLowerCase();
                            const text = String(el.innerText || el.textContent || '').toLowerCase();
                            const rect = el.getBoundingClientRect();
                            if (className.includes('grecaptcha-badge')) return false;
                            if (src.includes('hcaptcha') || src.includes('recaptcha')) return rect.width >= 120 && rect.height >= 40;
                            return /captcha|verify you are human|not a robot|security challenge/.test(`${className} ${text}`);
                        });
                    const bodyText = String(document.body.innerText || '').replace(/\\s+/g, ' ').trim();
                    const otpTextVisible = /verification code|security code|one[-\\s]?time code|\\botp\\b|enter (the )?(code|verification)|code (was )?sent|check your email/i.test(bodyText);
                    const otpInputs = Array.from(document.querySelectorAll('input, textarea')).filter((el) => {
                        if (!visible(el) || el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
                        const type = (el.getAttribute('type') || '').toLowerCase();
                        if (['hidden', 'button', 'submit', 'reset', 'file', 'checkbox', 'radio'].includes(type)) return false;
                        const attrs = [
                            el.id,
                            el.name,
                            el.getAttribute('aria-label'),
                            el.getAttribute('autocomplete'),
                            el.getAttribute('placeholder'),
                            el.parentElement && el.parentElement.innerText,
                        ].join(' ').toLowerCase();
                        const maxLength = Number(el.maxLength || el.getAttribute('maxlength') || 0);
                        return /one[-\\s]?time|otp|verification|security|token|security-input-\\d+/.test(attrs)
                            || (otpTextVisible && (/code/.test(attrs) || (maxLength >= 1 && maxLength <= 12)));
                    });
                    const splitOtpInputs = otpInputs.filter((el) => Number(el.maxLength || el.getAttribute('maxlength') || 0) === 1 || /security-input-\\d+/.test(el.id || ''));
                    const otpErrors = errors.filter((el) => /invalid.*code|incorrect.*code|expired.*code|try again|code did not match/i.test(String(el.innerText || el.textContent || '')));
                    return {
                        url: location.href,
                        form_count: document.querySelectorAll('form').length,
                        submit_button_count: submitButtons.length,
                        validation_error_count: errors.length,
                        validation_errors: errors.slice(0, 8).map((el) => String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim()).filter(Boolean),
                        captcha_visible: captcha,
                        otp_required: otpTextVisible || otpInputs.length > 0 || splitOtpInputs.length >= 4,
                        otp_input_count: otpInputs.length,
                        otp_split_input_count: splitOtpInputs.length,
                        otp_error_visible: otpErrors.length > 0,
                        body_text_sample: bodyText.slice(0, 1000)
                    };
                }"""
            )
        except Exception as exc:
            return {"error": f"{type(exc).__name__}: {exc}"}

    async def _save_artifacts(self, page: Any, target: Any, output_dir: Path, prefix: str) -> None:
        try:
            await page.screenshot(path=str(output_dir / f"{prefix}.png"), full_page=True)
        except Exception:
            pass
        if self.debug_artifacts:
            try:
                (output_dir / f"{prefix}.page.html").write_text(await page.content(), encoding="utf-8")
            except Exception:
                pass
            if target is not page:
                try:
                    (output_dir / f"{prefix}.target.html").write_text(await target.content(), encoding="utf-8")
                except Exception:
                    pass

    def _css_escape(self, value: str) -> str:
        return re.sub(r'([ !"#$%&\'()*+,./:;<=>?@\\[\\]^`{|}~])', r"\\\1", value)


async def fill(
    payload_path: Path,
    output_dir: Path,
    *,
    submit: bool = False,
    resume_path: str = "",
    debug: bool = False,
    otp_mode: str = "auto",
    imap_config_path: str = "",
    otp_timeout_seconds: int = 120,
    otp_lock_mode: str = "auto",
    otp_lock_timeout_seconds: int = 3600,
    otp_lock_stale_seconds: int = 1800,
    otp_lock_dir: str = "",
    board: str = "",
) -> dict[str, Any]:
    filler = GreenhouseFastFormFiller(
        {
            "submit": submit,
            "board": board,
            "resume_path": resume_path,
            "debug_artifacts": debug,
            "otp_mode": otp_mode,
            "imap_config_path": imap_config_path,
            "otp_timeout_seconds": otp_timeout_seconds,
            "otp_lock_mode": otp_lock_mode,
            "otp_lock_timeout_seconds": otp_lock_timeout_seconds,
            "otp_lock_stale_seconds": otp_lock_stale_seconds,
            "otp_lock_dir": otp_lock_dir,
        }
    )
    return await filler.fill_payload(payload_path, output_dir)


def main() -> None:
    parser = argparse.ArgumentParser(description="Fast Greenhouse form filler")
    parser.add_argument("payload", type=Path, help="filled Greenhouse payload JSON")
    parser.add_argument("output_dir", type=Path, nargs="?", default=None)
    parser.add_argument("--resume", default="", help="resume path used when payload contains file fields")
    parser.add_argument("--submit", action="store_true", help="submit after successful fill verification")
    parser.add_argument("--debug", action="store_true", help="write HTML artifacts in addition to screenshots")
    parser.add_argument("--board", default="", help="Greenhouse board token, for postings on a company's own domain")
    parser.add_argument(
        "--otp",
        choices=["auto", "manual", "off"],
        default="auto",
        help="handle Greenhouse email OTP after submit using IMAP",
    )
    parser.add_argument(
        "--imap-config",
        default=str(DEFAULT_IMAP_CONFIG_PATH),
        help="Path to imap_config.json (host/port/username/password)",
    )
    parser.add_argument("--otp-timeout", type=int, default=120, help="seconds to wait for an OTP email")
    parser.add_argument(
        "--otp-lock",
        choices=["auto", "off"],
        default="auto",
        help="serialize submit/OTP per mailbox so parallel fillers do not consume the wrong code",
    )
    parser.add_argument(
        "--otp-lock-timeout",
        type=int,
        default=3600,
        help="seconds a filler may wait for the mailbox OTP lock",
    )
    parser.add_argument(
        "--otp-lock-stale",
        type=int,
        default=1800,
        help="seconds before a dead-process OTP lock can be reclaimed",
    )
    parser.add_argument(
        "--otp-lock-dir",
        default="",
        help="directory for cross-process OTP mailbox locks",
    )
    args = parser.parse_args()

    output_dir = args.output_dir or args.payload.parent / "greenhouse_fast_filler"
    result = asyncio.run(
        fill(
            args.payload,
            output_dir,
            submit=args.submit,
            resume_path=args.resume,
            debug=args.debug,
            otp_mode=args.otp,
            imap_config_path=args.imap_config,
            otp_timeout_seconds=args.otp_timeout,
            otp_lock_mode=args.otp_lock,
            otp_lock_timeout_seconds=args.otp_lock_timeout,
            otp_lock_stale_seconds=args.otp_lock_stale,
            otp_lock_dir=args.otp_lock_dir,
            board=args.board,
        )
    )
    print(
        f"{result.get('status')} filled={len(result.get('filled') or [])} "
        f"errors={len(result.get('errors') or [])} "
        f"required_unfilled={len(result.get('required_unfilled') or [])} -> {output_dir / 'fill_result.json'}"
    )
    if result.get("status") not in {"pass"}:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
