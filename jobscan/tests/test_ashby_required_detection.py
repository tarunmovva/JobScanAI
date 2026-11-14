#!/usr/bin/env python3
"""Ashby marks required-ness on the LABEL, not on the control.

Its native inputs (text, email, file, textarea) carry the `required` attribute,
so the old `el.required || aria-required` check found them. Its custom widgets --
radio groups, checkboxes, multi-checkboxes, comboboxes -- are div-based and carry
neither. The only DOM signal is a CSS-module class on the question label:

    <label class="_heading_f7cvd_52 _required_f7cvd_91 ...">Have you used our product before?
    <label class="_heading_f7cvd_52 _label_1e3gg_42 ...">Do you have a Github to share?

Missing it meant the payload stage answered those fields with "", the filler
skipped them as "empty value", Ashby refused to submit, and a blind AI recovery
run had to infer the answers and submit -- measured on a live
run. Replayed across every captured Ashby form, half of them reported at
least one required field as optional.

The extraction JS runs in a page, so this drives the real script through the
shared CDP Chrome and SKIPS when that browser is not up (CI, no Chrome).

    python tests/test_ashby_required_detection.py
"""

from __future__ import annotations

import asyncio
import sys
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job_application_automator import ashby_form_extractor as ashby  # noqa: E402

CDP_VERSION_URL = "http://127.0.0.1:9222/json/version"


def cdp_available() -> bool:
    try:
        with urllib.request.urlopen(CDP_VERSION_URL, timeout=2):
            return True
    except Exception:
        return False


def field_entry(path: str, label_classes: str, label: str, control: str, for_attr: str | None = None) -> str:
    target = path if for_attr is None else for_attr
    return (
        f'<div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry" data-field-path="{path}">'
        f'<label class="{label_classes} ashby-application-form-question-title" for="{target}">{label}</label>'
        f'<div>{control}</div></div>'
    )


REQ = "_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42"
OPT = "_heading_f7cvd_52 _label_1e3gg_42"

FORM = "<html><body><form>" + "".join([
    # native control: already worked, must keep working
    field_entry("_systemfield_name", REQ, "Your name",
                '<input name="_systemfield_name" id="_systemfield_name" type="text" required="">'),
    # custom checkbox marked required ONLY on the label
    field_entry("q-required-cb", REQ, "Are you able to work in-person?",
                '<input type="checkbox" id="q-required-cb" name="q-required-cb">'),
    # custom checkbox genuinely optional
    field_entry("q-optional-cb", OPT, "Do you have a Github to share?",
                '<input type="checkbox" id="q-optional-cb" name="q-optional-cb">'),
    # radio group marked required only on the label
    field_entry("q-required-radio", REQ, "How many years of experience?",
                '<input type="radio" id="r1" name="q-required-radio"><label for="r1">1-3</label>'
                '<input type="radio" id="r2" name="q-required-radio"><label for="r2">4-6</label>'),
    # a repeating section whose OWN label is optional but which nests a
    # required sub-control label -- the section must not inherit it
    '<div class="_fieldEntry_1e3gg_28" data-field-path="_systemfield_education_history">'
    f'<label class="{OPT} ashby-application-form-question-title" for="_systemfield_education_history">Education History</label>'
    f'<label class="{REQ}" for="school-0">School</label><input type="text" id="school-0" name="school-0">'
    '</div>',
]) + "</form></body></html>"


class AshbyRequiredDetectionTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        if not cdp_available():
            self.skipTest("shared CDP Chrome not running on 127.0.0.1:9222")
        from playwright.async_api import async_playwright
        from job_application_automator.browser_cdp import open_cdp_page
        self._pw = await async_playwright().start()
        self._session = await open_cdp_page(self._pw, viewport={"width": 1280, "height": 800})
        page = self._session.page
        await page.set_content(FORM, wait_until="domcontentloaded")
        raw = await page.evaluate(ashby._FIELD_EXTRACTION_JS)
        fields = raw.get("fields") if isinstance(raw, dict) else raw
        self.by_path = {str(f.get("field_path") or f.get("id")): f for f in (fields or [])}

    async def asyncTearDown(self) -> None:
        try:
            await self._session.cleanup()
        finally:
            await self._pw.stop()

    def test_native_required_attribute_still_wins(self):
        self.assertTrue(self.by_path["_systemfield_name"]["required"])

    def test_custom_checkbox_required_only_on_its_label(self):
        self.assertTrue(self.by_path["q-required-cb"]["required"],
                        "Ashby marks custom controls required via the label class only")

    def test_a_genuinely_optional_control_stays_optional(self):
        self.assertFalse(self.by_path["q-optional-cb"]["required"],
                         "over-marking makes the filler refuse to submit a valid form")

    def test_radio_group_required_only_on_its_label(self):
        self.assertTrue(self.by_path["q-required-radio"]["required"])

    def test_a_section_does_not_inherit_a_nested_required_label(self):
        self.assertFalse(self.by_path["_systemfield_education_history"]["required"],
                         "a repeating section nests sub-control labels; they are not its own")

    def test_every_field_carries_a_stable_field_path(self):
        # `id` is whatever the control exposes -- for Ashby consent checkboxes
        # that is the question TEXT -- so anything needing a durable handle uses
        # field_path instead.
        for path, field in self.by_path.items():
            self.assertTrue(field.get("field_path"), f"{path} has no field_path")


if __name__ == "__main__":
    unittest.main(verbosity=2)
