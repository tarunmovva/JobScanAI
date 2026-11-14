#!/usr/bin/env python3
"""Fast Greenhouse job application form extractor.

This module is intentionally additive. The existing ``form_extractor.py`` remains
the compatibility fallback while this extractor builds the faster one-pass path.
"""

from __future__ import annotations

import argparse
import asyncio
import html
import json
import logging
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlparse
import urllib.error
import urllib.request

from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

try:
    from job_application_automator.browser_cdp import open_cdp_page
    from job_application_automator import tab_tag
except ImportError:
    from browser_cdp import open_cdp_page
    import tab_tag  # type: ignore


NAV_TIMEOUT_MS = 25_000
READY_TIMEOUT_MS = 8_000
OPTION_PROBE_TIMEOUT_MS = 700
DEFAULT_OPTION_LIMIT = 80
DEFAULT_OPTION_PROBE_BUDGET_MS = 12_000
CORE_LABELS = ("first name", "last name", "email", "resume", "cv", "phone")


def _stable_apply_url(original: str, current: str, job_id: str) -> str:
    """The URL an application can actually be made on."""
    # page.url is the POST-redirect location. One posting redirected to the
    # company investor-relations page; the extractor stored that as apply_url,
    # the filler navigated there, found no form, filled 0 of 24 fields, and the
    # run was recorded as a submitted application. A URL that no longer
    # identifies THIS job is not an apply URL, however current it is.
    cur = str(current or "")
    if not cur:
        return original
    low = cur.lower()
    if "greenhouse.io" in low or "gh_jid=" in low:
        return cur
    if job_id and str(job_id) in cur:
        return cur
    return original or cur


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _normalize(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())


def _normalize_key(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def _clean_field_label(value: str | None) -> str:
    label = _normalize(value)
    label = re.sub(r"\s+[a-f0-9]{7,12}$", "", label, flags=re.I)
    label = re.sub(r"\s*\(required\)\s*$", "", label, flags=re.I)
    label = re.sub(r"\s+required\s*$", "", label, flags=re.I)
    return _normalize(label)


def _clean_api_label(value: Any) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    return _clean_field_label(text)


def _option_text(option: Any) -> str:
    if isinstance(option, dict):
        return _normalize(str(option.get("text") or option.get("label") or option.get("value") or ""))
    return _normalize(str(option or ""))


def _parse_greenhouse_url(url: str) -> dict[str, str]:
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    path_parts = [part for part in parsed.path.strip("/").split("/") if part]
    query = parse_qs(parsed.query)

    board = ""
    job_id = ""
    mode = "unknown"

    if "gh_jid" in query and query["gh_jid"]:
        job_id = query["gh_jid"][-1]
    if "token" in query and query["token"]:
        job_id = query["token"][-1]

    if any(token in host for token in ("greenhouse.io", "greenhouse.io")):
        if len(path_parts) >= 3 and path_parts[-2] == "jobs":
            board = path_parts[0]
            job_id = path_parts[-1]
            mode = "greenhouse_job_page"
        elif len(path_parts) >= 2 and path_parts[0] == "embed":
            board = (query.get("for") or [""])[-1]
            mode = "greenhouse_embed"

    return {
        "host": host,
        "board": _normalize(board),
        "job_id": _normalize(job_id),
        "mode": mode,
    }


def with_board(metadata: dict[str, str], board: str) -> dict[str, str]:
    """Fill in the Greenhouse board token when the URL cannot carry it.

    A posting on a company's own careers domain (careers.example.com/jobs/1234567)
    names the job but not the board, so neither the questions API nor the
    board's own embedded application form could be reached. The job record
    upstream knows the board; this is where it joins the URL's metadata.
    """
    if board and not metadata.get("board"):
        metadata = {**metadata, "board": _normalize(board)}
    return metadata


# Every control's id and name, hidden ones included: a react-select keeps its
# Greenhouse name on a hidden input.
_CONTROL_IDENTS_JS = """() => Array.from(document.querySelectorAll('input, select, textarea'))
    .flatMap((el) => [el.id, el.getAttribute('name')])
    .filter(Boolean)"""

_QUESTION_NAME = re.compile(r"question_(\d+)")
# first_name as a whole token: first_name, input_first_name, field-first_name,
# job_application[first_name] -- but not a vendor's form_first_name_2_1_0.
_STANDARD_FIRST_NAME = re.compile(r"(?:^|[_\-\[])first_name\]?$")


def greenhouse_field_names(payload: dict[str, Any] | None) -> set[str]:
    """The field names the questions API says this posting's form has."""
    names: set[str] = set()
    for question in (payload or {}).get("questions") or []:
        for field in (question or {}).get("fields") or []:
            name = str((field or {}).get("name") or "").removesuffix("[]")
            if name:
                names.add(name)
    return names


def renders_greenhouse_form(idents: list[str], api_names: set[str]) -> bool:
    """Whether a page's controls are the Greenhouse form the API describes.

    A custom question's id is the strong signal -- question_11111101 exists on
    exactly one posting's form. Without custom questions, fall back to a
    standard field named the Greenhouse way.
    """
    question_ids = {m.group(1) for n in api_names if (m := _QUESTION_NAME.fullmatch(n))}
    for ident in idents or []:
        ident = str(ident)
        for m in _QUESTION_NAME.finditer(ident):
            if m.group(1) in question_ids:
                return True
        if _STANDARD_FIRST_NAME.search(ident):
            return True
    return False


def _embed_serves_form(embed_url: str) -> bool:
    """Whether the board's embed renders an application (and not an error page)."""
    try:
        request = urllib.request.Request(embed_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=8) as response:
            if response.status != 200 or "error=true" in (response.geturl() or ""):
                return False
            return "first_name" in response.read(400_000).decode("utf-8", errors="replace")
    except Exception:
        return False


def _build_embed_url(board: str, job_id: str) -> str:
    return "https://job-boards.greenhouse.io/embed/job_app?" + urlencode(
        {"for": board, "token": job_id}
    )


def _has_core_contact(fields: list[dict[str, Any]]) -> bool:
    labels = " ".join(str(field.get("label") or "") for field in fields).lower()
    return any(label in labels for label in ("first name", "last name", "email"))


def _confidence(fields: list[dict[str, Any]], form_context: dict[str, Any]) -> str:
    field_types = {field.get("type") for field in fields}
    has_upload = "file" in field_types
    has_core = _has_core_contact(fields)
    if len(fields) >= 8 and has_upload and has_core:
        return "high"
    if len(fields) >= 4 and (has_upload or has_core):
        return "medium"
    if form_context.get("detection_mode") == "constructed_embed_fallback" and len(fields) >= 4:
        return "medium"
    return "low"


class FormNotReadable(RuntimeError):
    """The application form was not read reliably enough to fill."""


def _readable_or_raise(
    fields: list[dict[str, Any]], form_context: dict[str, Any], *, closed_posting: bool, allow_low: bool
) -> str:
    """The extraction's confidence; raises FormNotReadable when it is too low to fill.

    Every real Greenhouse application has the name/email fields and a resume
    upload, so a low-confidence read means the real form was not found. That
    job must not be filled from a partial read -- it fails, with the reason.
    (It used to fall back to a legacy extractor whose module is not in the
    repo, so it failed with ModuleNotFoundError instead.) A closed posting is
    reported as closed by the caller, not as unreadable.
    """
    confidence = _confidence(fields, form_context)
    if confidence == "low" and not closed_posting and not allow_low:
        types = {field.get("type") for field in fields}
        missing = [m for m, absent in (
            ("no resume upload", "file" not in types),
            ("no name/email fields", not _has_core_contact(fields)),
        ) if absent]
        raise FormNotReadable(
            f"the application form could not be read reliably: {len(fields)} field(s) found"
            + (f", {', '.join(missing)}" if missing else "")
            + " -- not filled"
        )
    return confidence


def _dedupe_fields(fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clean: list[dict[str, Any]] = []
    seen_index: dict[tuple[str, str, str], int] = {}

    def dedupe_key(field: dict[str, Any]) -> tuple[str, str, str]:
        label_key = _normalize_key(field.get("label"))
        field_type = str(field.get("type") or "text")
        if field_type in {"dropdown", "combobox", "select"}:
            field_key = _normalize_key(field.get("id") or field.get("name"))
            if field_key and field_key != label_key:
                return (field_key, label_key, "choice")
            return ("", label_key, "choice")
        if field_type in {"checkbox_group", "file"}:
            return ("", label_key, field_type)
        return (_normalize_key(field.get("id") or field.get("name")), label_key, field_type)

    def field_score(field: dict[str, Any]) -> int:
        score = len(field.get("options") or []) * 3
        fid = str(field.get("id") or "")
        selector = str(field.get("selector") or "")
        if fid and fid != field.get("label"):
            score += 3
        if fid.startswith(("question_", "demographic_answers")):
            score += 4
        if selector.startswith("#"):
            score += 2
        if field.get("required"):
            score += 1
        return score

    for field in fields:
        label = _clean_field_label(field.get("label"))
        field_type = _normalize(str(field.get("type") or "text")).lower()
        fid = _normalize(str(field.get("id") or field.get("name") or label))
        semantic_text = _normalize_key(f"{fid} {field.get('name') or ''} {label}")
        semantic_tokens = set(semantic_text.split())
        if field_type == "text":
            if "email" in semantic_tokens:
                field_type = "email"
            elif (
                any(term in semantic_tokens for term in ("linkedin", "website", "portfolio", "github", "url"))
                or "linked in" in semantic_text
            ):
                field_type = "url"
        if field_type == "file":
            if any(term in semantic_text for term in ("resume", "cv")):
                label = "Resume/CV"
            elif "cover letter" in semantic_text or "cover_letter" in semantic_text:
                label = "Cover Letter"
        if not label and not fid:
            continue
        if not field_type:
            field_type = "text"

        options = field.get("options") or []
        normalized_options = []
        seen_options = set()
        for option in options:
            text = _option_text(option)
            if not text or text.lower() in seen_options:
                continue
            seen_options.add(text.lower())
            if isinstance(option, dict):
                normalized_options.append(
                    {"text": text, "value": _normalize(str(option.get("value") or text))}
                )
            else:
                normalized_options.append({"text": text, "value": text})

        cleaned = {
            "id": fid or re.sub(r"[^a-zA-Z0-9_]+", "_", label).strip("_").lower(),
            "name": _normalize(field.get("name")),
            "label": label or fid,
            "type": field_type,
            "required": bool(field.get("required")),
            "selector": field.get("selector") or "",
        }
        if normalized_options:
            cleaned["options"] = normalized_options
            if field_type in {"select", "combobox"}:
                cleaned["type"] = "dropdown"
        if field.get("accepted_types"):
            cleaned["accepted_types"] = field["accepted_types"]
        if field.get("original_type"):
            cleaned["original_type"] = field["original_type"]
        if field.get("supports_custom_input") is not None:
            cleaned["supports_custom_input"] = bool(field["supports_custom_input"])
        if field.get("options_note"):
            cleaned["options_note"] = field["options_note"]
        # Whitelisted explicitly: this dict is rebuilt from known keys, and an
        # unlisted one is silently dropped. options_source records that a list
        # came from the questions API and is complete; losing it here is what
        # let a 103-option list be flagged truncated after all.
        if field.get("options_source"):
            cleaned["options_source"] = field["options_source"]

        label_key = _normalize_key(cleaned["label"])
        if cleaned["type"] == "text":
            richer_types = {"dropdown", "combobox", "select", "checkbox_group", "file"}
            if any(("", label_key, rich_type) in seen_index for rich_type in richer_types):
                continue
            if ("", label_key, "choice") in seen_index:
                continue
        key = dedupe_key(cleaned)
        if key in seen_index:
            existing = clean[seen_index[key]]
            if cleaned.get("required"):
                existing["required"] = True
            if len(cleaned.get("options") or []) > len(existing.get("options") or []):
                existing["options"] = cleaned["options"]
                existing["supports_custom_input"] = cleaned.get("supports_custom_input", False)
                if cleaned.get("options_note"):
                    existing["options_note"] = cleaned["options_note"]
                # The source travels with the list it describes.
                if cleaned.get("options_source"):
                    existing["options_source"] = cleaned["options_source"]
                else:
                    existing.pop("options_source", None)
            if field_score(cleaned) > field_score(existing):
                merged = dict(cleaned)
                if len(existing.get("options") or []) > len(merged.get("options") or []):
                    merged["options"] = existing["options"]
                    if existing.get("options_source"):
                        merged["options_source"] = existing["options_source"]
                    else:
                        merged.pop("options_source", None)
                merged["required"] = bool(existing.get("required") or merged.get("required"))
                clean[seen_index[key]] = merged
            continue

        if cleaned["type"] in {"dropdown", "combobox", "select", "checkbox_group", "file"}:
            text_key = (_normalize_key(cleaned.get("id") or cleaned.get("name")), label_key, "text")
            if text_key in seen_index:
                old_index = seen_index.pop(text_key)
                clean[old_index] = cleaned
                seen_index[key] = old_index
                continue
            label_text_key = ("", label_key, "text")
            if label_text_key in seen_index:
                old_index = seen_index.pop(label_text_key)
                clean[old_index] = cleaned
                seen_index[key] = old_index
                continue

        clean.append(cleaned)
        seen_index[key] = len(clean) - 1

    return clean


def _generate_user_input_template(fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    template: list[dict[str, Any]] = []
    for field in fields:
        item: dict[str, Any] = {
            "id": field.get("id", ""),
            "question": field.get("label", ""),
            "value": "",
            "required": bool(field.get("required")),
            "type": field.get("type", "text"),
        }
        if field.get("name"):
            item["name"] = field["name"]
        if field.get("original_type"):
            item["original_type"] = field["original_type"]
        if field.get("type") == "dropdown":
            options = [_option_text(option) for option in field.get("options", [])]
            options = [option for option in options if option]
            if options:
                item["available_options"] = options
            item["supports_custom_input"] = bool(field.get("supports_custom_input", not options))
            if field.get("options_note"):
                item["note"] = field["options_note"]
            elif not options:
                item["note"] = "Type the value that matches the question if no fixed option is shown."
        if field.get("type") == "file":
            if field.get("accepted_types"):
                item["accepted_file_types"] = field["accepted_types"]
            item["upload_methods"] = ["file_upload"]
        template.append(item)
    return template


class FastGreenhouseFormExtractor:
    """Extract Greenhouse application fields with a single DOM scan plus small option probes."""

    def __init__(self, config: dict[str, Any] | None = None):
        config = config or {}
        self.debug_artifacts = bool(config.get("debug_artifacts", False))
        # The standalone tool can ask for a partial read; the app never does.
        self.allow_low_confidence = bool(config.get("allow_low_confidence", False))
        self.ready_timeout_ms = int(config.get("ready_timeout_ms", READY_TIMEOUT_MS))
        self.option_limit = int(config.get("option_limit", DEFAULT_OPTION_LIMIT))
        self.option_probe_budget_ms = int(
            config.get("option_probe_budget_ms", DEFAULT_OPTION_PROBE_BUDGET_MS)
        )
        self.logger = logging.getLogger(self.__class__.__name__)

    async def extract_form_data(
        self, url: str, output_dir: Path | None = None, *, board: str = ""
    ) -> dict[str, Any]:
        started_at = time.monotonic()
        metadata = with_board(_parse_greenhouse_url(url), board)
        output_dir = output_dir.resolve() if output_dir else None
        if output_dir:
            output_dir.mkdir(parents=True, exist_ok=True)

        async with async_playwright() as playwright:
            session = await open_cdp_page(
                playwright,
                viewport={"width": 1366, "height": 960},
                tab_stage="extract",
                tab_text=tab_tag.tab_text(
                    metadata.get("board_token") or metadata.get("company") or ""),
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/121.0.0.0 Safari/537.36"
                ),
                extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
                logger=self.logger,
            )
            page = session.page
            try:
                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
                except PlaywrightTimeoutError as exc:
                    self.logger.warning("Navigation timeout for %s: %s", url, exc)

                await self._dismiss_overlays(page)
                target, form_context = await self._find_application_context(page, metadata, url)
                fields = await self._extract_fields_from_context(target)
                if not fields and target is not page:
                    await page.wait_for_timeout(500)
                    refreshed = await self._wait_for_best_loaded_context(page, 3_000)
                    if refreshed:
                        target = refreshed
                        form_context["is_iframe"] = target is not page
                        form_context["parent_url"] = page.url if target is not page else ""
                        form_context["iframe_url"] = getattr(target, "url", "") if target is not page else ""
                        fields = await self._extract_fields_from_context(target)
                await self._probe_dynamic_options(target, fields)
                if self._has_required_dropdowns_without_options(fields):
                    refreshed = await self._wait_for_best_loaded_context(page, 5_000)
                    if refreshed:
                        refreshed_fields = await self._extract_fields_from_context(refreshed)
                        await self._probe_dynamic_options(refreshed, refreshed_fields)
                        if self._field_list_score(refreshed_fields) >= self._field_list_score(fields):
                            target = refreshed
                            form_context = self._build_context(page, target, "reacquired_for_option_probe")
                            fields = refreshed_fields
                # A blocking HTTP call (up to 8s) on a thread, not on the loop:
                # while this process is attached to Chrome its loop must keep
                # draining the Playwright driver, or every other process's new
                # tab freezes until it does (see form_tools_mcp.serve).
                fields = await asyncio.to_thread(
                    self._enrich_fields_from_greenhouse_questions,
                    fields,
                    page.url or "",
                    getattr(target, "url", "") or "",
                    form_context.get("iframe_url", ""),
                    form_context.get("embed_url", ""),
                    form_context.get("fallback_url", ""),
                    url,
                )
                fields = _dedupe_fields(fields)
                closed_posting = await self._detect_closed_posting(page, target)

                # The form DOM is saved on EVERY extraction, not just in debug
                # runs. Ashby and lever already did this; greenhouse did not, so
                # a greenhouse form could not be replayed offline -- and that is
                # exactly why cover_letter and degree--0 on one job were
                # extracted required=False, blocked the submit with
                # validation_errors, and could only be diagnosed by reading a
                # screenshot. `target` is the frame holding the form when
                # greenhouse embeds it in an iframe, which is the DOM that
                # matters.
                if output_dir:
                    await self._save_form_html(target, output_dir)
                if self.debug_artifacts and output_dir:
                    await self._save_debug_artifacts(page, target, output_dir)

                confidence = _readable_or_raise(
                    fields, form_context, closed_posting=closed_posting, allow_low=self.allow_low_confidence
                )

                # Typeahead controls expose only a sample of their real option
                # list; when collection stopped at the cap, downstream (payload
                # agent, filler) must know the visible list is not exhaustive.
                #
                # Truncation is a property of HOW the list was collected, not of
                # its length. The DOM collectors stop at option_limit, so a DOM
                # list that reached the cap may have been cut off. A list from
                # the Greenhouse questions API is the question's own definition
                # -- complete by construction, and already marked
                # supports_custom_input=False ("select from the available
                # options"). Flagging those as truncated contradicted that and
                # switched off the guard that keeps answers on the list: a
                # "College Name" list ending in "Others" was told it
                # was a typeahead, so the payload free-typed a college that was
                # not an option and the application failed. Dozens of complete
                # lists of a hundred-plus options -- mostly country pickers -- were mislabelled
                # the same way.
                for field in fields:
                    if field.get("options_source") == "greenhouse_api":
                        continue
                    opts = field.get("options")
                    if isinstance(opts, list) and len(opts) >= self.option_limit:
                        field["options_truncated"] = True

                job_info = await self._extract_job_info(page, target)
                result = {
                    "platform": "greenhouse",
                    "extractor": "greenhouse_fast_form_extractor",
                    "mode": "fast_dom_scan",
                    "url": page.url or url,
                    "original_url": url,
                    "apply_url": _stable_apply_url(
                        url, page.url, metadata.get("job_id", "")),
                    "url_drifted": _stable_apply_url(
                        url, page.url, metadata.get("job_id", "")) != (page.url or url),
                    "timestamp": _now_iso(),
                    "extracted_at": _now_iso(),
                    "extraction_seconds": round(time.monotonic() - started_at, 3),
                    "job_title": job_info.get("job_title", ""),
                    "company": job_info.get("company", ""),
                    "company_slug": metadata.get("board", ""),
                    "job_id": metadata.get("job_id", ""),
                    "confidence": confidence,
                    "form_context": form_context,
                    "total_fields": len(fields),
                    "required_fields": len([field for field in fields if field.get("required")]),
                    "fields": fields,
                    "user_input_template": _generate_user_input_template(fields),
                    "closed_posting": closed_posting,
                    "warnings": ["posting_closed_or_unavailable"] if closed_posting else [],
                    "errors": [],
                }

                if output_dir:
                    out_file = output_dir / "extracted_fields.json"
                    out_file.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")

                return result
            finally:
                await session.cleanup()

    def _greenhouse_questions_api_url(self, *candidate_urls: str) -> str:
        for candidate_url in candidate_urls:
            if not candidate_url:
                continue
            try:
                parsed = urlparse(candidate_url)
                host = (parsed.netloc or "").lower()
                path = parsed.path or ""
                query = parse_qs(parsed.query or "")
                if "greenhouse.io" not in host:
                    continue

                board = ""
                job_id = ""
                if "/embed/job_app" in path:
                    board = (query.get("for") or [""])[-1]
                    job_id = (query.get("token") or [""])[-1]
                else:
                    parts = [part for part in path.split("/") if part]
                    if len(parts) >= 3 and parts[-2] == "jobs":
                        board = parts[0]
                        job_id = parts[-1]

                if board and job_id:
                    return (
                        "https://boards-api.greenhouse.io/v1/boards/"
                        f"{quote(board, safe='')}/jobs/{quote(job_id, safe='')}?questions=true"
                    )
            except Exception:
                continue
        return ""

    def _fetch_greenhouse_job_payload(self, api_url: str) -> dict[str, Any]:
        if not api_url:
            return {}
        try:
            request = urllib.request.Request(
                api_url,
                headers={
                    "User-Agent": "Mozilla/5.0 job-application-automator",
                    "Accept": "application/json,text/plain,*/*",
                },
            )
            with urllib.request.urlopen(request, timeout=8) as response:
                payload = json.loads(response.read().decode("utf-8"))
            return payload if isinstance(payload, dict) else {}
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            self.logger.debug("Could not fetch Greenhouse questions API options: %s", exc)
            return {}

    def _api_options(self, raw_values: Any, *, label_key: str = "label") -> list[dict[str, str]]:
        options: list[dict[str, str]] = []
        seen: set[str] = set()
        for item in raw_values or []:
            if not isinstance(item, dict):
                continue
            text = _clean_api_label(item.get(label_key) or item.get("label") or item.get("value"))
            value = _normalize(str(item.get("value") or item.get("id") or text))
            if not text or text.lower() in seen:
                continue
            seen.add(text.lower())
            options.append({"text": text, "value": value or text})
        return options

    def _greenhouse_api_option_specs(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        specs: list[dict[str, Any]] = []

        def add_spec(
            *,
            label: Any,
            required: Any,
            field_name: Any = "",
            field_id: Any = "",
            field_type: Any = "",
            options: list[dict[str, str]] | None = None,
        ) -> None:
            clean_label = _clean_api_label(label)
            clean_name = _normalize(str(field_name or ""))
            clean_id = _normalize(str(field_id or ""))
            clean_type = _normalize(str(field_type or ""))
            clean_options = options or []
            if not clean_label and not clean_name and not clean_id:
                return
            if not clean_options:
                return
            specs.append(
                {
                    "label": clean_label or clean_name or clean_id,
                    "field_name": clean_name,
                    "field_id": clean_id,
                    "field_type": clean_type,
                    "required": bool(required),
                    "options": clean_options,
                }
            )

        for question in payload.get("questions") or []:
            if not isinstance(question, dict):
                continue
            label = question.get("label") or ""
            required = question.get("required")
            for field_def in question.get("fields") or []:
                if not isinstance(field_def, dict):
                    continue
                add_spec(
                    label=label,
                    required=required,
                    field_name=field_def.get("name"),
                    field_type=field_def.get("type"),
                    options=self._api_options(field_def.get("values")),
                )

        demographic = payload.get("demographic_questions") or {}
        for question in demographic.get("questions") or []:
            if not isinstance(question, dict):
                continue
            qid = question.get("id")
            add_spec(
                label=question.get("label"),
                required=question.get("required"),
                field_id=qid,
                field_name=qid,
                field_type=question.get("type"),
                options=self._api_options(question.get("answer_options")),
            )

        for compliance in payload.get("compliance") or []:
            if not isinstance(compliance, dict):
                continue
            for question in compliance.get("questions") or []:
                if not isinstance(question, dict):
                    continue
                label = question.get("label") or ""
                required = question.get("required")
                for field_def in question.get("fields") or []:
                    if not isinstance(field_def, dict):
                        continue
                    add_spec(
                        label=label,
                        required=required,
                        field_name=field_def.get("name"),
                        field_type=field_def.get("type"),
                        options=self._api_options(field_def.get("values")),
                    )

        return specs

    def _field_matches_api_spec(self, field: dict[str, Any], spec: dict[str, Any]) -> bool:
        field_id = _normalize(str(field.get("id") or ""))
        field_name = _normalize(str(field.get("name") or ""))
        field_label = _clean_field_label(field.get("label"))
        spec_id = _normalize(str(spec.get("field_id") or ""))
        spec_name = _normalize(str(spec.get("field_name") or ""))
        spec_label = _clean_field_label(spec.get("label"))
        spec_base = spec_name.replace("[]", "")

        if spec_id and field_id == spec_id:
            return True
        if spec_name and (field_name == spec_name or field_id == spec_name):
            return True
        if spec_base and (field_id == spec_base or field_name == spec_base):
            return True
        if (spec_id or spec_name or spec_base) and (field_id or field_name):
            return False
        return bool(spec_label and _normalize_key(field_label) == _normalize_key(spec_label))

    def _field_from_api_spec(self, spec: dict[str, Any]) -> dict[str, Any]:
        field_type = "dropdown"
        original_type = _normalize(str(spec.get("field_type") or ""))
        if original_type == "multi_value_multi_select":
            field_type = "checkbox_group"
        field_id = _normalize(str(spec.get("field_id") or spec.get("field_name") or ""))
        if not field_id:
            field_id = re.sub(r"[^a-zA-Z0-9_]+", "_", str(spec.get("label") or "")).strip("_").lower()
        return {
            "id": field_id,
            "name": _normalize(str(spec.get("field_name") or "")),
            "label": _clean_field_label(spec.get("label")),
            "type": field_type,
            "required": bool(spec.get("required")),
            "selector": "",
            "options": spec.get("options") or [],
            "supports_custom_input": False,
            "options_note": "Select from the available options.",
            "original_type": original_type or field_type,
        }

    def _enrich_fields_from_greenhouse_questions(
        self,
        fields: list[dict[str, Any]],
        *candidate_urls: str,
    ) -> list[dict[str, Any]]:
        api_url = self._greenhouse_questions_api_url(*candidate_urls)
        payload = self._fetch_greenhouse_job_payload(api_url)
        if not payload:
            return fields

        specs = self._greenhouse_api_option_specs(payload)
        if not specs:
            return fields

        enriched = list(fields)
        option_updates = 0
        appended = 0
        for spec in specs:
            options = spec.get("options") or []
            if not options:
                continue
            matched = False
            for field in enriched:
                if not self._field_matches_api_spec(field, spec):
                    continue
                matched = True
                current_options = field.get("options") or []
                if len(options) > len(current_options):
                    field["options"] = options
                    # The question's own definition: complete, so it must never
                    # be flagged truncated just for being long.
                    field["options_source"] = "greenhouse_api"
                    option_updates += 1
                if spec.get("required"):
                    field["required"] = True
                field["supports_custom_input"] = False
                field["options_note"] = "Select from the available options."
                if field.get("type") in {"select", "combobox"}:
                    field["type"] = "dropdown"
                if spec.get("field_type"):
                    field.setdefault("original_type", spec["field_type"])
                break
            if not matched:
                appended_field = self._field_from_api_spec(spec)
                # Built entirely from the API definition, so its options are
                # the complete set too.
                if appended_field.get("options"):
                    appended_field["options_source"] = "greenhouse_api"
                enriched.append(appended_field)
                appended += 1

        if option_updates or appended:
            self.logger.info(
                "Enriched Greenhouse options from questions API: %s option update(s), %s appended field(s)",
                option_updates,
                appended,
            )
        return enriched

    async def _find_application_context(
        self, page: Any, metadata: dict[str, str], original_url: str
    ) -> tuple[Any, dict[str, Any]]:
        deadline = time.monotonic() + (self.ready_timeout_ms / 1000)
        clicked_apply = False

        while time.monotonic() < deadline:
            target = await self._best_loaded_context(page)
            if target:
                canonical = await self._canonical_form_instead(page, target, metadata)
                if canonical:
                    return canonical
                return target, self._build_context(page, target, "loaded_application_context")

            if await self._context_contains_closed_text(page):
                break

            job_id = metadata.get("job_id", "")
            if job_id and job_id not in (page.url or "") and not self._greenhouse_frames(page):
                break

            if not clicked_apply:
                clicked_apply = await self._click_apply_control(page, metadata)
                if clicked_apply:
                    await page.wait_for_timeout(1_000)
                    continue

            await page.wait_for_timeout(250)

        target = await self._best_loaded_context(page)
        if target:
            canonical = await self._canonical_form_instead(page, target, metadata)
            if canonical:
                return canonical
            return target, self._build_context(page, target, "loaded_after_timeout")

        if self._url_marks_unavailable(page.url) or await self._context_contains_closed_text(page):
            return page, {
                "platform": "greenhouse",
                "is_iframe": False,
                "detection_mode": "closed_posting_detected",
                "parent_url": "",
                "iframe_url": "",
            }

        board = metadata.get("board")
        job_id = metadata.get("job_id")
        if board and job_id:
            embed_url = _build_embed_url(board, job_id)
            response = await page.goto(embed_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
            await self._dismiss_overlays(page)
            if await self._page_marks_unavailable(page, response):
                return page, self._closed_posting_context(embed_url=embed_url)
            target = await self._wait_for_best_loaded_context(page, 4_000)
            if target:
                return target, {
                    "platform": "greenhouse",
                    "is_iframe": target is not page,
                    "detection_mode": "constructed_embed_fallback",
                    "parent_url": page.url if target is not page else "",
                    "iframe_url": getattr(target, "url", "") if target is not page else "",
                    "embed_url": embed_url,
                }

        for fallback_url in self._fallback_application_urls(original_url, metadata):
            try:
                response = await page.goto(fallback_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
                await self._dismiss_overlays(page)
                if await self._page_marks_unavailable(page, response):
                    return page, self._closed_posting_context(fallback_url=fallback_url)
                target = await self._wait_for_best_loaded_context(page, 4_000)
                if target:
                    return target, {
                        "platform": "greenhouse",
                        "is_iframe": target is not page,
                        "detection_mode": "url_fallback",
                        "parent_url": page.url if target is not page else "",
                        "iframe_url": getattr(target, "url", "") if target is not page else "",
                        "fallback_url": fallback_url,
                    }
            except Exception:
                continue

        return page, {
            "platform": "greenhouse",
            "is_iframe": False,
            "detection_mode": "main_page_timeout_fallback",
            "parent_url": "",
            "iframe_url": "",
        }

    async def _canonical_form_instead(
        self, page: Any, target: Any, metadata: dict[str, str]
    ) -> tuple[Any, dict[str, Any]] | None:
        """The board's own application form, when the page offers another one.

        A company careers site can render its own forms on the job page --
        one had a talent-network signup beside a custom application -- and
        the page scoring cannot tell them from a Greenhouse form: both have a
        first name and a file input. Nothing downstream understands such a
        form (no question ids, no API options, no Greenhouse confirmation). On
        that site the filler filled the signup form, and six runs were recorded as
        submitted with no confirmation anywhere.

        The questions API says what the real form asks. A Greenhouse rendering
        -- hosted, embedded, or drawn on the company's own domain -- carries
        those field names in its control ids; a
        vendor's form carries none. Only then, and only when the board's embed
        actually serves the form, switch to it. Anything uncertain keeps the
        page, as before.
        """
        if target is not page:
            return None  # a Greenhouse frame is the Greenhouse form
        board, job_id = metadata.get("board", ""), metadata.get("job_id", "")
        if not board or not job_id or "greenhouse.io" in urlparse(page.url or "").netloc.lower():
            return None
        api_url = (
            "https://boards-api.greenhouse.io/v1/boards/"
            f"{quote(board, safe='')}/jobs/{quote(job_id, safe='')}?questions=true"
        )
        names = greenhouse_field_names(
            await asyncio.to_thread(self._fetch_greenhouse_job_payload, api_url))
        if not names:
            return None
        try:
            idents = await page.evaluate(_CONTROL_IDENTS_JS)
        except Exception:
            return None
        if renders_greenhouse_form(idents, names):
            return None
        embed_url = _build_embed_url(board, job_id)
        if not await asyncio.to_thread(_embed_serves_form, embed_url):
            return None

        custom_url = page.url
        self.logger.info("Page form is not the Greenhouse form; using the board's embed %s", embed_url)
        await page.goto(embed_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        await self._dismiss_overlays(page)
        found = await self._wait_for_best_loaded_context(page, 4_000)
        if found:
            return found, {
                "platform": "greenhouse",
                "is_iframe": found is not page,
                "detection_mode": "canonical_embed",
                "parent_url": page.url if found is not page else "",
                "iframe_url": getattr(found, "url", "") if found is not page else "",
                "embed_url": embed_url,
                "custom_page_url": custom_url,
            }
        # The embed did not render after all: put the page back as it was.
        await page.goto(custom_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        await self._dismiss_overlays(page)
        restored = await self._wait_for_best_loaded_context(page, 4_000) or page
        return restored, self._build_context(page, restored, "loaded_application_context")

    def _closed_posting_context(self, **extra: str) -> dict[str, Any]:
        context = {
            "platform": "greenhouse",
            "is_iframe": False,
            "detection_mode": "closed_posting_detected",
            "parent_url": "",
            "iframe_url": "",
        }
        context.update({key: value for key, value in extra.items() if value})
        return context

    async def _page_marks_unavailable(self, page: Any, response: Any | None = None) -> bool:
        return (
            self._response_marks_unavailable(response)
            or self._url_marks_unavailable(page.url)
            or await self._context_contains_closed_text(page)
        )

    def _response_marks_unavailable(self, response: Any | None) -> bool:
        try:
            status = int(response.status) if response else 0
        except Exception:
            return False
        return status in {404, 410}

    def _url_marks_unavailable(self, url: str | None) -> bool:
        if not url:
            return False
        try:
            parsed = urlparse(url)
            query = parse_qs(parsed.query)
        except Exception:
            return False
        return "greenhouse.io" in parsed.netloc.lower() and query.get("error", [""])[-1].lower() == "true"

    async def _wait_for_best_loaded_context(self, page: Any, timeout_ms: int) -> Any | None:
        deadline = time.monotonic() + (timeout_ms / 1000)
        while time.monotonic() < deadline:
            target = await self._best_loaded_context(page)
            if target:
                return target
            if self._url_marks_unavailable(page.url) or await self._context_contains_closed_text(page):
                return None
            await page.wait_for_timeout(250)
        return await self._best_loaded_context(page)

    def _fallback_application_urls(self, original_url: str, metadata: dict[str, str]) -> list[str]:
        parsed = urlparse(original_url)
        query = parse_qs(parsed.query)
        job_id = metadata.get("job_id") or (query.get("gh_jid") or [""])[-1]
        if not job_id or "greenhouse.io" in parsed.netloc.lower():
            return []

        urls: list[str] = []
        origin = f"{parsed.scheme}://{parsed.netloc}"
        form_url = f"{origin}/form?{urlencode({'gh_jid': job_id})}"
        embed_urls = [_build_embed_url(board, job_id) for board in self._likely_board_slugs(parsed.netloc)]

        if parsed.netloc.lower().startswith("jobs."):
            urls.append(form_url)
            urls.extend(embed_urls)
        else:
            urls.extend(embed_urls)
            urls.append(form_url)

        unique: list[str] = []
        seen: set[str] = set()
        for url in urls:
            if url == original_url or url in seen:
                continue
            seen.add(url)
            unique.append(url)
        return unique

    def _likely_board_slugs(self, host: str) -> list[str]:
        labels = [part for part in host.lower().split(".") if part]
        generic = {"www", "jobs", "careers", "job", "apply", "app"}
        candidates = [label for label in labels[:-1] if label not in generic]
        if len(candidates) >= 2 and candidates[-1] in {"co", "com", "net", "org"}:
            candidates = candidates[:-1]
        slugs = []
        if candidates:
            slugs.append(candidates[-1].replace("-", ""))
            slugs.append(candidates[-1])
        return [slug for index, slug in enumerate(slugs) if slug and slug not in slugs[:index]]

    async def _best_loaded_context(self, page: Any) -> Any | None:
        candidates: list[Any] = []
        greenhouse_frames = []
        for frame in self._greenhouse_frames(page):
            if await self._frame_is_visible(frame):
                greenhouse_frames.append(frame)
        candidates.extend(greenhouse_frames)
        candidates.append(page)

        best = None
        best_score = 0
        for candidate in candidates:
            try:
                score = await candidate.evaluate(_APP_SCORE_JS)
            except Exception:
                continue
            if score > best_score:
                best = candidate
                best_score = score

        if best and best_score >= 6:
            try:
                await best.wait_for_function(_APP_READY_JS, timeout=1_500)
            except Exception:
                pass
            return best
        return None

    def _greenhouse_frames(self, page: Any) -> list[Any]:
        return [
            frame
            for frame in page.frames
            if frame != page.main_frame
            and ("greenhouse.io" in (frame.url or "").lower() or "job_app" in (frame.url or "").lower())
        ]

    async def _frame_is_visible(self, frame: Any) -> bool:
        try:
            element = await frame.frame_element()
            box = await element.bounding_box()
            if not box or box.get("width", 0) <= 0 or box.get("height", 0) <= 0:
                return False
            return await element.evaluate(
                """(el) => {
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                }"""
            )
        except Exception:
            return True

    def _build_context(self, page: Any, target: Any, detection_mode: str) -> dict[str, Any]:
        is_iframe = target is not page
        return {
            "platform": "greenhouse",
            "is_iframe": is_iframe,
            "detection_mode": detection_mode,
            "parent_url": page.url if is_iframe else "",
            "iframe_url": getattr(target, "url", "") if is_iframe else "",
        }

    async def _extract_fields_from_context(self, target: Any) -> list[dict[str, Any]]:
        fields = await self._scan_fields_once(target)
        if not fields:
            return []

        best = fields
        best_score = self._field_list_score(fields)
        stable_scans = 0
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            try:
                await target.wait_for_timeout(500)
            except Exception:
                return best
            refreshed = await self._scan_fields_once(target)
            refreshed_score = self._field_list_score(refreshed)
            if refreshed_score > best_score:
                best = refreshed
                best_score = refreshed_score
                stable_scans = 0
            else:
                stable_scans += 1
            if stable_scans >= 2 and _confidence(best, {"detection_mode": ""}) == "high":
                break
        return best

    async def _scan_fields_once(self, target: Any) -> list[dict[str, Any]]:
        try:
            raw = await target.evaluate(_FIELD_EXTRACTION_JS, {"maxOptions": self.option_limit})
            if isinstance(raw, list):
                return raw
        except Exception as exc:
            self.logger.warning("Fast Greenhouse DOM extraction failed: %s", exc)
        return []

    def _field_list_score(self, fields: list[dict[str, Any]]) -> int:
        score = len(fields) * 10
        score += sum(8 for field in fields if field.get("type") == "checkbox")
        score += sum(4 for field in fields if field.get("type") == "checkbox_group")
        score += sum(3 for field in fields if field.get("type") == "file")
        score += sum(2 for field in fields if field.get("required"))
        score += sum(3 for field in fields if field.get("required") and field.get("options"))
        return score

    def _has_required_dropdowns_without_options(self, fields: list[dict[str, Any]]) -> bool:
        for field in fields:
            field_type = str(field.get("type") or "").lower()
            if (
                field.get("required")
                and field_type in {"dropdown", "select"}
                and not field.get("options")
                and not field.get("supports_custom_input")
            ):
                return True
        return False

    async def _probe_dynamic_options(self, target: Any, fields: list[dict[str, Any]]) -> None:
        deadline = time.monotonic() + (self.option_probe_budget_ms / 1000)
        candidates = sorted(fields, key=self._option_probe_priority)
        for field in candidates:
            if time.monotonic() >= deadline:
                break
            if field.get("type") not in {"dropdown", "select", "combobox"}:
                continue
            if len(field.get("options") or []) >= 2:
                continue
            if not self._should_probe_options(field):
                continue

            selector = field.get("selector") or ""
            if not selector:
                continue
            try:
                control = target.locator(selector).first
                if await control.count() == 0:
                    continue
                click_candidates = [control]
                for click_selector in (
                    'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " select ")][1]//*[contains(@class, "select__control")][1]',
                    'xpath=ancestor::*[contains(@class, "select-shell")][1]//*[contains(@class, "select__control")][1]',
                    'xpath=ancestor::*[contains(@class, "select__container")][1]//button[@aria-label="Toggle flyout"][1]',
                    '[aria-haspopup="listbox"], button',
                ):
                    try:
                        nested = control.locator(click_selector).first
                        if await nested.count():
                            click_candidates.append(nested)
                    except Exception:
                        continue

                options = []
                click_target = control
                for candidate in click_candidates:
                    try:
                        click_target = candidate
                        await click_target.scroll_into_view_if_needed(timeout=OPTION_PROBE_TIMEOUT_MS)
                        await click_target.click(timeout=OPTION_PROBE_TIMEOUT_MS)
                    except Exception:
                        try:
                            await click_target.click(timeout=OPTION_PROBE_TIMEOUT_MS, force=True)
                        except Exception:
                            continue
                    await target.wait_for_timeout(250)
                    options = await target.evaluate(_VISIBLE_OPTIONS_JS, {"maxOptions": self.option_limit})
                    if options:
                        break
                if options:
                    field["options"] = options
                    field["supports_custom_input"] = False
                    field["options_note"] = "Select from the available options."
                else:
                    supports_custom_input = await control.evaluate(
                        """(el) => {
                            const input = el.matches('input, textarea, [contenteditable="true"]')
                                ? el
                                : el.querySelector('input, textarea, [contenteditable="true"]');
                            if (!input) return false;
                            return !input.disabled && input.getAttribute('readonly') === null && input.getAttribute('aria-readonly') !== 'true';
                        }"""
                    )
                    if supports_custom_input:
                        field["supports_custom_input"] = True
                        if field.get("type") == "dropdown":
                            field["type"] = "combobox"
                    field["options_probe_status"] = "no_visible_options"
                try:
                    await click_target.press("Escape", timeout=500)
                except Exception:
                    pass
            except Exception:
                continue

    def _should_probe_options(self, field: dict[str, Any]) -> bool:
        return not bool(field.get("options"))

    def _option_probe_priority(self, field: dict[str, Any]) -> int:
        if field.get("required") and not field.get("options"):
            return 0
        if field.get("required"):
            return 1
        if not field.get("options"):
            return 2
        return 9

    async def _dismiss_overlays(self, page: Any) -> None:
        selectors = [
            # CMP-specific IDs (fast, exact — try before generic text matchers)
            "#onetrust-reject-all-handler",          # OneTrust reject (many US companies)
            "#onetrust-accept-btn-handler",          # OneTrust accept
            "#onetrust-close-btn-container button",  # OneTrust close
            "#CybotCookiebotDialogBodyButtonAccept", # Cookiebot
            "#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll",
            "#didomi-notice-agree-button",           # Didomi
            ".sp-cs-ok",                             # Sourcepoint
            "[data-testid='uc-accept-all-button']",  # Usercentrics
            ".iubenda-cs-accept-btn",                # iubenda
            "#truste-consent-button",                # TrustArc
            ".qc-cmp2-summary-buttons button:first-child",  # Quantcast
            # Generic text matchers (existing behaviour, kept as fallback)
            'button:has-text("Accept")',
            'button:has-text("ACCEPT ALL")',
            'button:has-text("Accept All")',
            'button:has-text("I Accept")',
            'button:has-text("Agree")',
            'button:has-text("Got it")',
            'button:has-text("Reject All")',
            'button:has-text("REJECT ALL")',
            '[aria-label="Close"]',
            'button:has-text("Close")',
        ]
        for selector in selectors:
            try:
                locator = page.locator(selector).first
                if await locator.count():
                    await locator.click(timeout=800)
                    await page.wait_for_timeout(150)
            except Exception:
                continue

    async def _click_apply_control(self, page: Any, metadata: dict[str, str]) -> bool:
        job_id = metadata.get("job_id", "")
        try:
            controls = page.locator("a, button").filter(has_text=re.compile("apply|application", re.I))
            count = min(await controls.count(), 10)
        except Exception:
            return False

        for index in range(count):
            control = controls.nth(index)
            try:
                text = _normalize(await control.inner_text(timeout=500)).lower()
                href = await control.get_attribute("href", timeout=500) or ""
                if not await control.is_visible(timeout=500):
                    continue
                if "submit" in text:
                    continue
                if not text and not self._looks_like_greenhouse_apply_url(href):
                    continue
                if job_id and "gh_jid=" in href and job_id not in href:
                    continue
                if href:
                    apply_url = urljoin(page.url, href)
                    if self._is_navigable_apply_url(apply_url):
                        await page.goto(apply_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
                        return True
                    if href.lower().startswith(("mailto:", "tel:")):
                        continue
                await self._click_control_in_owned_page(page, control)
                return True
            except Exception:
                continue
        return False

    async def _click_control_in_owned_page(self, page: Any, control: Any) -> None:
        await control.scroll_into_view_if_needed(timeout=800)
        popup_task = asyncio.create_task(page.wait_for_event("popup", timeout=2_000))
        try:
            await control.click(timeout=1_500)
        except Exception:
            popup_task.cancel()
            raise
        try:
            popup = await popup_task
            try:
                await popup.wait_for_load_state("domcontentloaded", timeout=5_000)
            except Exception:
                pass
            popup_url = popup.url
            try:
                await popup.close()
            except Exception:
                pass
            if self._is_navigable_apply_url(popup_url):
                await page.goto(popup_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        except PlaywrightTimeoutError:
            # No popup: normal in-page buttons may still navigate or reveal the application.
            pass

    def _looks_like_greenhouse_apply_url(self, url: str) -> bool:
        lower = (url or "").lower()
        return "greenhouse.io" in lower or "gh_jid=" in lower or "job_app" in lower

    def _is_navigable_apply_url(self, url: str) -> bool:
        if not url:
            return False
        parsed = urlparse(url)
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)

    async def _extract_job_info(self, page: Any, target: Any) -> dict[str, str]:
        info = {"job_title": "", "company": ""}
        for context in (target, page):
            try:
                context_info = await context.evaluate(_JOB_INFO_JS)
            except Exception:
                context_info = {}
            for key in info:
                if not info[key] and context_info.get(key):
                    info[key] = _normalize(context_info[key])
        if not info["job_title"]:
            try:
                info["job_title"] = _normalize(await page.title())
            except Exception:
                pass
        return info

    async def _detect_closed_posting(self, page: Any, target: Any) -> bool:
        if self._url_marks_unavailable(page.url) or self._url_marks_unavailable(getattr(target, "url", "")):
            return True
        if await self._context_contains_closed_text(target):
            return True
        return await self._context_contains_closed_text(page)

    async def _context_contains_closed_text(self, context: Any) -> bool:
        patterns = (
            "no longer open",
            "no longer accepting applications",
            "position has been filled",
            "job is closed",
            "posting is closed",
        )
        try:
            text = await context.evaluate(
                "() => `${document.title || ''}\\n${document.body ? document.body.innerText : ''}`.toLowerCase()"
            )
        except Exception:
            return False
        if any(pattern in text for pattern in patterns):
            return True
        return False

    async def _save_form_html(self, target: Any, output_dir: Path) -> None:
        """Persist the form exactly as extracted, for offline replay.

        Cheap (one serialisation), never fatal, and the only thing that makes an
        extractor bug reproducible without spending a real application.
        """
        try:
            output_dir.mkdir(parents=True, exist_ok=True)
            (output_dir / "form.html").write_text(await target.content(), encoding="utf-8")
        except Exception:
            pass

    async def _save_debug_artifacts(self, page: Any, target: Any, output_dir: Path) -> None:
        try:
            await page.screenshot(path=str(output_dir / "form.png"), full_page=True)
        except Exception:
            pass
        try:
            (output_dir / "page.html").write_text(await page.content(), encoding="utf-8")
        except Exception:
            pass
        if target is not page:
            try:
                (output_dir / "iframe.html").write_text(await target.content(), encoding="utf-8")
            except Exception:
                pass


_APP_SCORE_JS = """
() => {
    function visible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }
    const controls = Array.from(document.querySelectorAll(
        'input:not([type="hidden"]), textarea, select, [role="combobox"], [role="group"][aria-required], input[type="file"]'
    )).filter(visible);
    const text = document.body ? document.body.innerText.toLowerCase() : '';
    const hasCoreApplicationCue = /first name|last name|resume|cv|cover letter/.test(text) || Boolean(document.querySelector('input[type="file"]'));
    if (!hasCoreApplicationCue) return Math.min(controls.length, 5);
    let score = controls.length;
    if (document.querySelector('input[type="file"]')) score += 8;
    if (/first name|last name|email|resume|cv/.test(text)) score += 5;
    if (/submit application|apply for this job|submit your application/.test(text)) score += 3;
    if (/job alert|department|locations|open roles/.test(text)) score -= 5;
    return score;
}
"""


_APP_READY_JS = """
() => {
    const controls = Array.from(document.querySelectorAll(
        'input:not([type="hidden"]), textarea, select, [role="combobox"], [role="group"][aria-required], input[type="file"]'
    ));
    const visible = controls.filter((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });
    const text = document.body ? document.body.innerText.toLowerCase() : '';
    return visible.length >= 3 && /first name|last name|email|resume|cv|phone/.test(text);
}
"""


_JOB_INFO_JS = """
() => {
    function clean(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
    }
    const titleSelectors = ['h1', '[data-testid*="job-title"]', '.job__title', '.app-title'];
    const companySelectors = ['[data-testid*="company"]', '.company-name', '.job-company'];
    let jobTitle = '';
    let company = '';
    for (const selector of titleSelectors) {
        const el = document.querySelector(selector);
        const text = clean(el && el.textContent);
        if (text && text.length < 180) {
            jobTitle = text;
            break;
        }
    }
    for (const selector of companySelectors) {
        const el = document.querySelector(selector);
        const text = clean(el && el.textContent);
        if (text && text.length < 120) {
            company = text;
            break;
        }
    }
    if (!jobTitle) jobTitle = clean(document.title);
    return { job_title: jobTitle, company };
}
"""


_VISIBLE_OPTIONS_JS = """
(args) => {
    const maxOptions = args && args.maxOptions ? args.maxOptions : 80;
    function clean(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
    }
    function visible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
    const nodes = Array.from(document.querySelectorAll(
        '[role="option"], [role="menuitemradio"], [role="menuitemcheckbox"], .select__option, [class*="option"]'
    )).filter(visible);
    const seen = new Set();
    const options = [];
    for (const node of nodes) {
        const text = clean(node.textContent);
        if (!text || seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());
        options.push({ text, value: node.getAttribute('data-value') || node.getAttribute('value') || text });
        if (options.length >= maxOptions) break;
    }
    return options;
}
"""


_FIELD_EXTRACTION_JS = """
(args) => {
    const maxOptions = args && args.maxOptions ? args.maxOptions : 80;
    const fields = [];
    const consumed = new WeakSet();
    const seen = new Set();

    function clean(value) {
        return String(value || '')
            .replace(/\\*/g, ' ')
            .replace(/\\s+/g, ' ')
            .trim();
    }

    function escapeCss(value) {
        if (window.CSS && CSS.escape) return CSS.escape(value);
        return String(value).replace(/["\\\\]/g, '\\\\$&');
    }

    function visible(el) {
        if (!el) return false;
        if (el.type === 'file') return true;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function applicationRoot() {
        const candidateSelector = [
            'form',
            '[id*="application"]',
            '[class*="application"]',
            '[id*="apply"]',
            '[class*="apply"]',
            '[id*="greenhouse"]',
            '[class*="greenhouse"]',
            '[id*="grnhse"]',
            '[class*="grnhse"]',
            'main',
            'body'
        ].join(',');
        const candidates = Array.from(document.querySelectorAll(candidateSelector));
        let best = document.body || document.documentElement;
        let bestScore = -Infinity;
        for (const candidate of candidates) {
            if (!visible(candidate) && candidate !== document.body) continue;
            const controls = Array.from(candidate.querySelectorAll(
                'input:not([type="hidden"]), textarea, select, [role="combobox"], [role="group"][aria-required], [aria-haspopup="listbox"], [class*="select__control"]'
            )).filter(visible);
            if (!controls.length) continue;
            const text = clean(candidate.innerText || candidate.textContent || '').toLowerCase();
            let score = controls.length;
            if (candidate.querySelector('input[type="file"]')) score += 50;
            if (/resume|cv|cover letter/.test(text)) score += 25;
            if (/submit application|apply for this job|submit your application/.test(text)) score += 20;
            if (/first name/.test(text)) score += 10;
            if (/last name/.test(text)) score += 10;
            if (/email/.test(text)) score += 8;
            if (/talent community|job alert|stay connected|email alerts|departments|locations/.test(text)) score -= 35;
            if (candidate.tagName === 'BODY') score -= 15;
            if (score > bestScore) {
                bestScore = score;
                best = candidate;
            }
        }
        return best;
    }

    function cssPath(el) {
        if (!el || !el.tagName) return '';
        if (el.id && document.querySelectorAll('#' + escapeCss(el.id)).length === 1) {
            return '#' + escapeCss(el.id);
        }
        const name = el.getAttribute('name');
        if (name) {
            const selector = `${el.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\\\"')}"]`;
            if (document.querySelectorAll(selector).length === 1) return selector;
        }
        const parts = [];
        let current = el;
        while (current && current.nodeType === 1 && current !== document.body && parts.length < 6) {
            let part = current.tagName.toLowerCase();
            if (current.classList && current.classList.length) {
                const stable = Array.from(current.classList).find((item) => !/^css-|^sc-|^_[a-z0-9]/i.test(item));
                if (stable) part += '.' + escapeCss(stable);
            }
            const parent = current.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter((node) => node.tagName === current.tagName);
                if (siblings.length > 1) {
                    part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
                }
            }
            parts.unshift(part);
            current = parent;
        }
        return parts.join(' > ');
    }

    function rootFor(el) {
        let current = el;
        for (let depth = 0; current && current !== document.body && depth < 8; depth++) {
            if (
                current.querySelector &&
                current.querySelector('label') &&
                current.querySelector('input, textarea, select, button, [role="combobox"], [role="group"]')
            ) {
                return current;
            }
            current = current.parentElement;
        }
        return el.closest([
            'fieldset',
            '[role="group"]',
            '[data-testid*="question"]',
            '[class*="question"]',
            '[class*="Question"]',
            '.field',
            '.field-wrapper',
            '.input-wrapper',
            '.application--question',
            '.eeoc__question__wrapper',
            '[class*="select"]'
        ].join(',')) || el.parentElement || el;
    }

    function textById(idValue) {
        if (!idValue) return '';
        return clean(idValue.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '));
    }

    function labelFromRoot(root, control) {
        if (!root) return '';
        const selectors = [
            'legend',
            'label:not(:has(input)):not(:has(textarea)):not(:has(select))',
            '[class*="label"]',
            '[class*="Label"]',
            '[data-testid*="label"]',
            'h2',
            'h3',
            'h4',
            'p'
        ];
        for (const selector of selectors) {
            const nodes = Array.from(root.querySelectorAll(selector));
            for (const node of nodes) {
                if (control && node.contains(control) && node !== control) continue;
                const text = clean(node.textContent);
                if (text && text.length <= 300) return text;
            }
        }
        return '';
    }

    function groupLabelFromRoot(root, inputs) {
        if (!root) return '';
        const optionIds = new Set(inputs.map((input) => input.getAttribute('id')).filter(Boolean));
        const optionTexts = new Set(inputs.map((input) => optionLabel(input).toLowerCase()).filter(Boolean));
        const nodes = Array.from(root.querySelectorAll('legend, label, [class*="label"], [class*="Label"], h2, h3, h4, p'));
        for (const node of nodes) {
            const forAttr = node.getAttribute && node.getAttribute('for');
            if (forAttr && optionIds.has(forAttr)) continue;
            const text = clean(node.textContent);
            if (!text || text.length > 300) continue;
            if (optionTexts.has(text.toLowerCase())) continue;
            return text;
        }
        return '';
    }

    function groupRootFor(inputs) {
        if (!inputs.length) return null;
        const fieldset = inputs[0].closest('fieldset');
        if (fieldset) return fieldset;
        let current = inputs[0].parentElement;
        for (let depth = 0; current && current !== document.body && depth < 10; depth++) {
            if (inputs.every((input) => current.contains(input))) {
                const groupLabel = groupLabelFromRoot(current, inputs);
                if (groupLabel) return current;
            }
            current = current.parentElement;
        }
        return rootFor(inputs[0]);
    }

    function labelFor(el) {
        const id = el.getAttribute('id');
        if (id) {
            const exact = document.querySelector(`label[for="${id.replace(/"/g, '\\\\"')}"]`);
            const text = clean(exact && exact.textContent);
            if (text) return text;
        }
        const aria = clean(el.getAttribute('aria-label')) || textById(el.getAttribute('aria-labelledby'));
        if (aria) return aria;
        const parentLabel = el.closest('label');
        const parentText = clean(parentLabel && parentLabel.textContent);
        if (parentText) return parentText;
        const rootText = labelFromRoot(rootFor(el), el);
        if (rootText) return rootText;
        const placeholder = clean(el.getAttribute('placeholder'));
        if (placeholder) return placeholder;
        return clean(el.getAttribute('name') || el.getAttribute('id') || '');
    }

    function requiredFor(el) {
        const root = rootFor(el);
        const attrs = [
            el.required,
            el.getAttribute('aria-required') === 'true',
            el.getAttribute('required') !== null,
            root && root.querySelector('[required], [aria-required="true"]')
        ];
        if (attrs.some(Boolean)) return true;
        const text = root ? root.textContent || '' : '';
        return /\\*\\s*$|required/i.test(text) && text.length < 500;
    }

    function optionsFromSelect(el) {
        const options = [];
        const seenOptions = new Set();
        for (const option of Array.from(el.options || [])) {
            const text = clean(option.textContent);
            if (!text || /select|choose/i.test(text) || seenOptions.has(text.toLowerCase())) continue;
            seenOptions.add(text.toLowerCase());
            options.push({ text, value: option.value || text });
            if (options.length >= maxOptions) break;
        }
        return options;
    }

    function optionLabel(input) {
        const id = input.getAttribute('id');
        if (id) {
            const exact = document.querySelector(`label[for="${id.replace(/"/g, '\\\\"')}"]`);
            const text = clean(exact && exact.textContent);
            if (text) return text;
        }
        const label = input.closest('label');
        const labelText = clean(label && label.textContent);
        if (labelText) return labelText;
        return clean(input.value);
    }

    function add(field) {
        field.label = clean(field.label);
        field.id = clean(field.id || field.name || field.label);
        field.name = clean(field.name || '');
        if (!field.label || !field.id) return;
        const key = [field.id.toLowerCase(), field.label.toLowerCase(), field.type].join('|');
        if (seen.has(key)) return;
        seen.add(key);
        fields.push(field);
    }

    const scanRoot = applicationRoot();

    const groups = new Map();
    for (const input of Array.from(scanRoot.querySelectorAll('input[type="radio"], input[type="checkbox"]'))) {
        if (!visible(input) && input.type !== 'checkbox') continue;
        const name = input.getAttribute('name') || input.getAttribute('id') || '';
        if (!name) continue;
        const key = `${input.type}:${name}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(input);
    }

    for (const [key, inputs] of groups) {
        const type = inputs[0].type;
        const root = groupRootFor(inputs);
        const options = inputs.map((input) => ({
            text: optionLabel(input),
            value: input.value || optionLabel(input)
        })).filter((option) => option.text);
        inputs.forEach((input) => consumed.add(input));
        if (inputs.length === 1 && type === 'checkbox') {
            add({
                id: inputs[0].getAttribute('id') || inputs[0].getAttribute('name') || optionLabel(inputs[0]),
                name: inputs[0].getAttribute('name') || '',
                label: optionLabel(inputs[0]) || labelFromRoot(root, inputs[0]),
                type: 'checkbox',
                required: requiredFor(inputs[0]),
                selector: cssPath(inputs[0])
            });
        } else {
            add({
                id: inputs[0].getAttribute('name') || inputs[0].getAttribute('id') || labelFromRoot(root, inputs[0]),
                name: inputs[0].getAttribute('name') || '',
                label: groupLabelFromRoot(root, inputs) || labelFromRoot(root, inputs[0]) || labelFor(inputs[0]),
                type: type === 'radio' ? 'dropdown' : 'checkbox_group',
                required: inputs.some(requiredFor),
                selector: cssPath(inputs[0]),
                options,
                original_type: type === 'radio' ? 'radio_group' : 'checkbox_group',
                supports_custom_input: false
            });
        }
    }

    const controls = Array.from(scanRoot.querySelectorAll('input, textarea, select, [role="combobox"], [role="group"][aria-required], [aria-haspopup="listbox"]'));
    for (const el of controls) {
        if (consumed.has(el)) continue;
        if (!visible(el)) continue;
        const tag = el.tagName.toLowerCase();
        const inputType = (el.getAttribute('type') || '').toLowerCase();
        if (el.getAttribute('aria-hidden') === 'true') continue;
        if ((el.className || '').toString().includes('requiredInput')) continue;
        if (el.getAttribute('tabindex') === '-1' && el.getAttribute('aria-hidden') === 'true') continue;
        if (tag === 'input' && ['hidden', 'button', 'submit', 'reset', 'radio', 'checkbox'].includes(inputType)) continue;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;

        let type = 'text';
        let options = [];
        if (el.getAttribute('role') === 'group' && el.querySelector('input[type="file"]')) {
            continue;
        }
        if (el.getAttribute('role') === 'group' && el.querySelector('[aria-haspopup="listbox"], button')) {
            type = 'dropdown';
        } else if (tag === 'textarea') {
            type = 'textarea';
        } else if (tag === 'select') {
            type = 'dropdown';
            options = optionsFromSelect(el);
        } else if (inputType === 'file') {
            type = 'file';
        } else if (inputType === 'email') {
            type = 'email';
        } else if (inputType === 'tel') {
            type = 'phone';
        } else if (inputType === 'url') {
            type = 'url';
        } else if (
            el.getAttribute('role') === 'combobox' ||
            el.getAttribute('aria-haspopup') === 'listbox' ||
            el.getAttribute('aria-autocomplete') === 'list'
        ) {
            type = 'dropdown';
        }

        const field = {
            id: el.getAttribute('id') || el.getAttribute('name') || labelFor(el),
            name: el.getAttribute('name') || '',
            label: labelFor(el),
            type,
            required: requiredFor(el),
            selector: cssPath(el)
        };
        if (options.length) field.options = options;
        if (type === 'file') {
            field.accepted_types = clean(el.getAttribute('accept'));
        }
        add(field);
    }

    return fields;
}
"""


async def extract(
    apply_url: str, output_dir: Path, *, debug: bool = False, board: str = ""
) -> dict[str, Any]:
    extractor = FastGreenhouseFormExtractor({"debug_artifacts": debug})
    result = await extractor.extract_form_data(apply_url, output_dir, board=board)
    print(
        f"Extracted {result.get('total_fields', 0)} fields "
        f"({result.get('required_fields', 0)} required, {result.get('mode')}) -> "
        f"{output_dir / 'extracted_fields.json'}"
    )
    return result


async def main() -> None:
    parser = argparse.ArgumentParser(description="Fast Greenhouse form extractor")
    parser.add_argument("apply_url")
    parser.add_argument("output_dir", nargs="?", default="")
    parser.add_argument("--debug", action="store_true", help="write screenshot/html artifacts")
    parser.add_argument(
        "--allow-low-confidence",
        action="store_true",
        help="return a low-confidence (partial) read instead of failing; the app never does this",
    )
    parser.add_argument("--option-limit", type=int, default=DEFAULT_OPTION_LIMIT)
    args = parser.parse_args()

    parsed = urlparse(args.apply_url)
    default_name = re.sub(r"[^a-zA-Z0-9_.-]+", "_", parsed.netloc + parsed.path).strip("_")
    output_dir = Path(args.output_dir) if args.output_dir else Path("output") / f"{default_name}_greenhouse_fast"
    extractor = FastGreenhouseFormExtractor(
        {
            "debug_artifacts": args.debug,
            "allow_low_confidence": args.allow_low_confidence,
            "option_limit": args.option_limit,
        }
    )
    result = await extractor.extract_form_data(args.apply_url, output_dir)
    print(
        f"Extracted {result.get('total_fields', 0)} fields "
        f"({result.get('required_fields', 0)} required, confidence={result.get('confidence', 'n/a')}, "
        f"mode={result.get('mode')}) -> {output_dir / 'extracted_fields.json'}"
    )
    if result.get("errors"):
        print("ERRORS:", result["errors"])


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
