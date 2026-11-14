"""Cover letter detection and artifact generation.

The payload carries the letter as TEXT. This module turns it into whatever the
form in front of the filler actually accepts: typed prose for a textarea, or a
generated PDF for a file input. Keeping that decision here means the Electron
side never has to know a form's shape, and all three fillers share one
implementation.
"""
from __future__ import annotations

import re
from pathlib import Path

# "cover letter" in any casing, with a space, underscore or hyphen, plus the id
# spellings the three platforms use. Deliberately NOT a bare "cover" or
# "letter": "Letter of Recommendation" and "Please cover your relevant
# experience" must not match. Over-matching puts a cover letter in front of an
# employer in a box that asked for something else.
_MARKERS = ("cover letter", "cover_letter", "coverletter")

# An unfilled template placeholder: a bracketed phrase whose first word is
# capitalised -- "[Company]", "[Company Name]", "[Your Name]", "[Role]". Prose
# brackets ("a team [of six]") start lowercase and are left alone. The prompt
# forbids placeholders, but asking a model is not enforcing, and this text
# goes into a PDF that is uploaded to an employer.
_PLACEHOLDER_RE = re.compile(r"\[[A-Z][A-Za-z]*( [A-Za-z]+)*\]")

# The prompt demands 180-250. This floor sits below that on purpose: it is a
# safety net against a stub or a refusal, not a style check. Measured run:
# 6 of 15 letters came in at 163-179 words, all substantive.
# ("I cannot write that"), not a letter worth sending.
_MIN_WORDS = 150


PDF_NAME = "cover_letter.pdf"
TXT_NAME = "cover_letter.txt"

# Field types that take an uploaded file rather than typed text.
_FILE_TYPES = frozenset({"file", "attachment", "upload"})

# fpdf2's core fonts are latin-1 only, and an LLM emits these constantly. Fold
# them rather than let pdf.output() raise and lose the letter entirely.
_LATIN1_FOLDS = {
    "’": "'", "‘": "'", "“": '"', "”": '"',
    "—": "--", "–": "-", "…": "...", " ": " ",
}


def _haystack(field: dict) -> str:
    parts = [field.get("label"), field.get("id"), field.get("name")]
    return " ".join(str(p or "") for p in parts).lower().replace("-", "_")


def is_cover_letter_field(field: object) -> bool:
    """True when this control is asking for a cover letter."""
    if not isinstance(field, dict):
        return False
    hay = _haystack(field)
    # _haystack folds hyphens to underscores, so "cover-letter" arrives as
    # "cover_letter"; the space form still needs its own marker.
    return any(m in hay for m in _MARKERS)


def write_txt(text: str, out_dir: Path) -> Path:
    """Write the letter as plain text. Always succeeds."""
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / TXT_NAME
    path.write_text(text, encoding="utf-8")
    return path


def _latin1(text: str) -> str:
    for bad, good in _LATIN1_FOLDS.items():
        text = text.replace(bad, good)
    return text.encode("latin-1", "replace").decode("latin-1")


def ensure_pdf(text: str, out_dir: Path) -> Path | None:
    """Render the letter to PDF, or None when that is not possible.

    Returns None rather than raising when fpdf2 is missing: a dependency that
    failed to install should cost the PDF, not the application. The caller
    falls back to plain text.
    """
    if not (text or "").strip():
        return None
    try:
        from fpdf import FPDF
    except Exception:
        return None
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        pdf = FPDF(format="letter", unit="mm")
        pdf.set_auto_page_break(auto=True, margin=20)
        pdf.add_page()
        pdf.set_margins(20, 20, 20)
        pdf.set_font("Helvetica", size=11)
        for para in _latin1(text).split("\n"):
            if para.strip():
                # new_x/new_y are not optional niceties: multi_cell leaves
                # the cursor at the RIGHT margin, so a second consecutive
                # line has no width left and fpdf2 raises "Not enough
                # horizontal space to render a single character".
                pdf.multi_cell(0, 6, para, new_x="LMARGIN", new_y="NEXT")
            else:
                pdf.ln(4)
        path = out_dir / PDF_NAME
        pdf.output(str(path))
        return path if path.is_file() else None
    except Exception as exc:
        # Never raise -- but never go quiet either. A swallowed exception here
        # looks exactly like "fpdf2 is not installed", and the letter simply
        # stops appearing with nothing to explain why.
        print(f"[cover_letter] PDF generation failed: {type(exc).__name__}: {exc}")
        return None



def rejection_reason(text: str) -> str:
    """Why this letter must not be sent, or "" when it is fine."""
    words = len(text.split())
    if words < _MIN_WORDS:
        return f"only {words} words; expected at least {_MIN_WORDS}"
    found = _PLACEHOLDER_RE.search(text)
    if found:
        return f"unfilled placeholder {found.group(0)!r}"
    return ""


def inject_cover_letter(payload: dict, out_dir: Path) -> list[str]:
    """Fill every cover-letter field in ``payload["answers"]``, in place.

    Called once per run, right after a filler loads its answers, so the
    existing fill machinery then treats the letter as an ordinary answer: a
    path goes through the upload path (with its manual-text fallback), prose
    goes straight into the textarea. No fill loop needs to know letters exist.

    Returns the field ids it filled.
    """
    text = str(payload.get("cover_letter") or "").strip()
    if not text:
        return []

    reason = rejection_reason(text)
    if reason:
        # Leaving the field blank is recoverable. Uploading a letter that
        # says "Dear [Company]" is not.
        print(f"[cover_letter] refusing to use this letter: {reason}")
        return []

    answers = payload.setdefault("answers", {})
    fields = payload.get("fields") or []

    file_value: str | None = None
    filled: list[str] = []

    for field in fields:
        if not is_cover_letter_field(field):
            continue
        fid = str(field.get("id") or "").strip()
        if not fid:
            continue
        # Never clobber a real answer. The payload prompt tells the agent to
        # leave file fields blank, so anything already here came from somewhere
        # with better information than we have.
        if answers.get(fid) not in (None, "", []):
            continue

        if str(field.get("type") or "").lower() in _FILE_TYPES:
            if file_value is None:
                # One artifact per run, reused across however many file fields
                # the form has. Falls back to .txt when fpdf2 is unavailable --
                # every platform's manual-text path can still read that.
                path = ensure_pdf(text, out_dir) or write_txt(text, out_dir)
                file_value = str(path)
            answers[fid] = file_value
        else:
            answers[fid] = text
        filled.append(fid)

    return filled
