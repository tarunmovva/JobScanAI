#!/usr/bin/env python3
"""Coercion for answers that are really yes/no.

A checkbox question ("Will you now or in the future require sponsorship?") is
answered by the model as text, and the fillers turned that text into a click
with plain Python truthiness:

    ashby   want_bool = bool(value)
    lever   if value: await el.check() else: await el.uncheck()

`bool("No")` is True. So an answer of "No" CHECKED the box -- the opposite of
what it says -- and verification could not catch it either, because it compared
`bool(actual) == bool(expected)` and both sides were True.

Measured across the recorded payloads: several answers were a "No" written
into a checkbox. Those were submitted inverted.

Greenhouse already had this helper; lever and ashby did not. One copy now.
"""

from __future__ import annotations

from typing import Any

# Everything here means "unchecked". Anything else, including "Yes", "true",
# "I agree" and any consent wording, means checked -- an unrecognised answer on
# a REQUIRED consent box should tick it, not silently leave the form invalid.
FALSEY_ANSWERS = {
    "", "0", "false", "no", "none", "null", "n", "nope", "no.",
    "unchecked", "not checked", "decline", "i decline", "declined",
    "do not agree", "disagree", "i do not agree", "n/a", "na",
}


def truthy(value: Any) -> bool:
    """Whether an answer means "check this box"."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, (list, tuple, set)):
        # A list answer is the multi-select shape; non-empty means something was
        # chosen. ["I agree"] -> True, [] -> False.
        return bool(value)
    return str(value).strip().lower() not in FALSEY_ANSWERS
