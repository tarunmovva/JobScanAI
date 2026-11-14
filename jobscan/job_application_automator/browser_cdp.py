#!/usr/bin/env python3
"""Shared Chrome CDP browser bootstrap for product extractors and fillers."""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    from .runtime_support import get_runtime_subdir
    from . import tab_tag
except ImportError:
    from runtime_support import get_runtime_subdir
    import tab_tag  # type: ignore

CDP_HOST = os.environ.get("JOB_AUTOMATOR_CDP_HOST", "127.0.0.1")
CDP_PORT = int(os.environ.get("JOB_AUTOMATOR_CDP_PORT", "9222"))
CDP_ENDPOINT = f"http://{CDP_HOST}:{CDP_PORT}"
CHROME_PATH_ENV = "JOB_AUTOMATOR_CHROME_PATH"
CHROME_PROFILE_ENV = "JOB_AUTOMATOR_CHROME_USER_DATA_DIR"


@dataclass
class CdpBrowserSession:
    """A single tab in the shared Chrome CDP browser."""

    browser: Any
    context: Any
    page: Any
    started_process: subprocess.Popen | None = None
    owned_pages: list[Any] = field(default_factory=list)
    # Identity the recovery agent uses to find this exact tab among duplicates
    # of the same job. Empty when the tab was opened untagged.
    tab_id: str = ""

    def track_page(self, page: Any) -> None:
        """Track pages created by this run so cleanup does not leave popups behind."""
        if not page or page in self.owned_pages:
            return
        self.owned_pages.append(page)
        try:
            page.on("popup", self.track_page)
        except Exception:
            pass

    async def cleanup(self) -> None:
        """Close only this run's tabs; keep shared Chrome and context alive."""
        for page in reversed(list(self.owned_pages or [self.page])):
            try:
                if page and not page.is_closed():
                    await page.close()
            except Exception:
                pass


def cdp_url(path: str = "") -> str:
    suffix = path if path.startswith("/") else f"/{path}" if path else ""
    return f"{CDP_ENDPOINT}{suffix}"


def chrome_profile_dir() -> Path:
    configured = os.environ.get(CHROME_PROFILE_ENV)
    if configured:
        path = Path(configured).expanduser()
        path.mkdir(parents=True, exist_ok=True)
        return path
    return get_runtime_subdir("chrome-cdp-profile")


def chrome_executable() -> Path:
    configured = os.environ.get(CHROME_PATH_ENV)
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured).expanduser())

    # Windows paths
    for env_name in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        base = os.environ.get(env_name)
        if base:
            candidates.append(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")

    # macOS paths
    candidates.extend([
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ])
    home = Path.home()
    candidates.append(home / "Applications" / "Google Chrome.app" / "Contents" / "MacOS" / "Google Chrome")

    # PATH-based fallback (cross-platform)
    for name in ("chrome", "chrome.exe", "google-chrome", "google-chrome-stable"):
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))

    for candidate in candidates:
        if candidate.exists():
            return candidate

    tried = ", ".join(str(p) for p in candidates) or "no candidates"
    raise RuntimeError(
        f"Chrome executable not found. Set {CHROME_PATH_ENV}. Tried: {tried}"
    )


def _cdp_reachable() -> bool:
    try:
        with urllib.request.urlopen(cdp_url("/json/version"), timeout=1.0) as response:
            return 200 <= response.status < 300
    except (OSError, urllib.error.URLError):
        return False


async def ensure_cdp_chrome(logger: Any = None, timeout_s: float = 15.0) -> subprocess.Popen | None:
    """Ensure a real Chrome process is reachable through CDP."""
    if await asyncio.to_thread(_cdp_reachable):
        return None

    chrome_path = chrome_executable()
    profile_dir = chrome_profile_dir()
    args = [
        str(chrome_path),
        f"--remote-debugging-port={CDP_PORT}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
    ]

    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(
            subprocess, "DETACHED_PROCESS", 0
        )

    if logger:
        logger.info("Starting Chrome CDP on %s with profile %s", CDP_ENDPOINT, profile_dir)

    process = subprocess.Popen(
        args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=creationflags,
        # macOS/Linux: the app kills a filler's whole process group on cancel;
        # the Chrome it started is the user's browser and must outlive that.
        start_new_session=(os.name != "nt"),
    )

    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if await asyncio.to_thread(_cdp_reachable):
            return process
        await asyncio.sleep(0.25)

    raise RuntimeError(
        "Chrome CDP did not become reachable. "
        f"chrome={chrome_path} profile={profile_dir} port={CDP_PORT}"
    )


async def open_cdp_page(
    playwright: Any,
    *,
    viewport: dict[str, int] | None = None,
    user_agent: str | None = None,
    extra_http_headers: dict[str, str] | None = None,
    geolocation: dict[str, float] | None = None,
    permissions: list[str] | None = None,
    logger: Any = None,
    tab_stage: str | None = None,
    tab_text: str = "",
) -> CdpBrowserSession:
    """Open one new tab in the shared real-Chrome CDP browser.

    tab_stage/tab_text label the tab in Chrome's tab strip. Up to nine of these
    are open at once and, untagged, every one shows the site's own title -- so
    the user cannot tell which job is where, nor which of the tabs left open
    after a failure still need them. See tab_tag.
    """
    started_process = await ensure_cdp_chrome(logger=logger)
    try:
        browser = await playwright.chromium.connect_over_cdp(CDP_ENDPOINT)
    except Exception as exc:
        try:
            chrome_path = str(chrome_executable())
        except Exception as path_exc:
            chrome_path = f"unknown ({path_exc})"
        raise RuntimeError(
            "Failed to connect to Chrome CDP. "
            f"endpoint={CDP_ENDPOINT} chrome={chrome_path} "
            f"profile={chrome_profile_dir()} port={CDP_PORT}"
        ) from exc

    created_context = False
    if browser.contexts:
        context = browser.contexts[0]
    else:
        created_context = True
        context = await browser.new_context(
            viewport=viewport,
            user_agent=user_agent,
            extra_http_headers=extra_http_headers,
            geolocation=geolocation,
            permissions=permissions,
        )

    if permissions:
        try:
            await context.grant_permissions(permissions)
        except Exception:
            pass
    if geolocation:
        try:
            await context.set_geolocation(geolocation)
        except Exception:
            pass

    page = await context.new_page()

    # Installed before any navigation, so the tag is in place for the first
    # document and every one after it. An evaluate-set title is wiped by the
    # next page load; an init script re-runs for each new document.
    tab_id = ""
    if tab_stage:
        try:
            tab_id = tab_tag.new_tab_id()
            await page.add_init_script(tab_tag.init_script(tab_id, tab_stage, tab_text))
        except Exception:
            # A tab label is cosmetic. Never fail a run over it.
            tab_id = ""

    if viewport:
        try:
            await page.set_viewport_size(viewport)
        except Exception:
            pass
    if extra_http_headers:
        await page.set_extra_http_headers(extra_http_headers)

    # User agent can only be guaranteed when we create a fresh context.
    if user_agent and created_context:
        if logger:
            logger.debug("Applied custom user agent through new CDP context")

    session = CdpBrowserSession(
        browser=browser,
        context=context,
        page=page,
        started_process=started_process,
        tab_id=tab_id,
    )
    session.track_page(page)
    return session
