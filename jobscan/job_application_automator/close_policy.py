#!/usr/bin/env python3
"""Tab lifecycle policy shared by the platform form fillers.

After a fill attempt the tab stays OPEN so the user can finish the
application manually — unless the attempt succeeded, or the failure is
"broken" (nothing on the page worth completing).

In a loop run (unattended) every tab closes: nobody is there to finish it,
and each open tab slows every later Chrome connection.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

try:
    from job_application_automator.runtime_support import unattended_run
except ImportError:  # spawned with the package root on sys.path
    from runtime_support import unattended_run

CLOSE_STATUSES = frozenset(
    {
        "submitted",      # success — nothing left to do
        "not_submitted",  # greenhouse no-submit mode — nothing pending
        "nav_failed",     # apply-URL navigation failed — no page loaded
    }
)


def should_keep_tab_open(status: str, *, form_found: bool = True) -> bool:
    """True when the tab should be left open for manual completion.

    form_found=False means the application form never appeared on the
    page — the tab is useless, so it closes regardless of status.
    """
    if unattended_run():
        return False
    if not form_found:
        return False
    return (status or "") not in CLOSE_STATUSES


class _CrashTabGuard:
    def __init__(self) -> None:
        self.session: Any = None

    def watch(self, session: Any) -> None:
        self.session = session


@asynccontextmanager
async def close_tab_on_unattended_crash() -> AsyncIterator[_CrashTabGuard]:
    """Close the watched tab when the body raises during a loop run.

    A filler that crashes after its tab opened returns an error result through
    its outer crash guard, and nothing ever closed the tab. Enter this in the
    same ``async with`` as ``async_playwright()`` and after it, so it exits
    first, while the browser connection still exists to close the tab:

        async with async_playwright() as pw, close_tab_on_unattended_crash() as guard:
            session = await open_cdp_page(pw, ...)
            guard.watch(session)

    Normal runs are untouched: the tab stays open for the user, as before.
    """
    guard = _CrashTabGuard()
    try:
        yield guard
    except BaseException:
        if guard.session is not None and unattended_run():
            try:
                await guard.session.cleanup()
            except Exception:
                pass
        raise
