---
name: recovery-triage
description: Complete or diagnose a job application that a deterministic form filler left unfinished in an already-open browser tab. Use the pre-computed focus dossier to repair named controls directly instead of re-deriving the page from a full-page snapshot.
rev: 8
---

# Recovery triage

A deterministic form filler partially filled a job application in an already-open
browser tab and stopped. Your mission: complete this application and submit it — a
submitted application is success. You have Playwright browser tools attached to a
shared browser; other agents work in other tabs.

## 0. Claim your tab (always first)

List the open tabs and select the tab whose TITLE begins with the exact `tab_marker`
string from the context. Several tabs may share the application URL, so the title
marker — not the URL — identifies the one tab that is yours. Work exclusively inside
that tab, using browser tools only.

When no tab title carries the marker, finish with outcome `gave_up`.

## 1. Read the focus dossier before touching the page

`recovery_focus.json` sits in your working directory. Its `focus_mode` decides your
whole approach.

### focus_mode: "focused" — the broken controls are already identified

**Do not take a full-page snapshot.** The filler was driving this page seconds ago
and recorded exactly what went wrong. A full-page snapshot costs 4,000–10,000
tokens; a targeted repair costs about 200. Snapshotting first throws that away.

Repair the whole list in ONE `mcp__formtools__fill_fields` call: pass each
control's `id` with the `expected` value. It handles text, select, checkbox,
radio and typeahead controls, and reads every value back, so a control that did
not actually take the value comes back `ok: false` rather than looking fixed.

Then, for anything it reports it could not do:

1. Act on `selector` directly — `browser_select_option`, `browser_type`,
   `browser_click`, `browser_fill_form`. `expected` is the answer to apply;
   `observed_actual` is what the control held when the filler gave up.
2. `runtime_options` is the REAL rendered menu, captured live. When it is present,
   the value you select must come from it — the extracted option list can diverge
   from what the page actually shows.
3. `validation_text` is the page's own error message for that control. It usually
   names the real problem (wrong format, required conditional, out-of-range date).
4. Verify that one control changed, then move to the next.

Only when a targeted repair fails: snapshot, and scope it to that control's
container rather than the whole page. Then continue down the list.

When `controls` is exhausted and the page shows no further errors, go to step 3.

### focus_mode: "blind" — the filler could not localise the failure

The submission was not confirmed and no field-level failure was recorded. Start
with `mcp__formtools__form_state`: it returns every control the page marks
invalid with its message, the submit buttons, whether a confirmation is already
showing, and whether a CAPTCHA is blocking. That is the same picture a full-page
snapshot gives for about a twentieth of the tokens (measured: ~105 against
~1,120). Snapshot only when form_state reports something you cannot act on.

When the page already shows a confirmation / thank-you state, finish immediately
with outcome `submitted`.

## 2. Fill what is still missing

Complete every field that is wrong, cleared, or missing — including newly revealed
conditional questions, dropdown selections, consent boxes, and file uploads. Source
each answer in this order:

- a. the provided `answers`,
- b. the `candidate_profile` (work authorization, sponsorship, clearance, salary, EEO),
- c. the `resume_text` (education, employers, titles, dates, skills, locations),
- d. the `job_context` (title, company, description),
- e. INFERENCE — when the data above is silent, choose the highest-probability answer
  that fits everything you know about this candidate and this job, fill it, and
  continue.

Give every required field a value. List each inferred value in `inferred` so it can
be reviewed later. Inference is a last resort, not a shortcut: prefer reading the
files in your working directory over guessing.

| file | holds |
|------|-------|
| `recovery_context_full.json` | the complete field list and every answer the payload agent produced |
| `recovery_resume.txt` | the candidate's resume text |

**Read one file at a time, and only the one you need.** These are tens of
kilobytes; concatenating them into a single command's output is what you must
avoid. Prefer a targeted read over dumping a whole file — e.g. search the field
list for the id you care about rather than printing all of it.

Typeahead dropdowns show only a sample of their full option list — type the real
value into the control to search the complete list, then select the matching option.

For file fields, upload from the absolute path given in the answers.

## 3. Submit and verify

1. When an "I'm not a robot" checkbox captcha is present, click the checkbox, wait
   for it to pass, and continue. When a picture or puzzle challenge appears, finish
   with outcome `failed` and note `captcha_puzzle` — a human completes it in the
   open tab.
2. Submit once with `mcp__formtools__submit_and_verify`. It clicks, waits for the
   page to settle, and reports what the page became — read its result rather than
   assuming; it does not decide success for you. Fall back to a real `browser_click`
   on the submit button if it reports no button found. Re-check the page state
   before any further click.
3. When the page reports this candidate already applied, finish with outcome
   `gave_up`.

## Tool discipline

- `mcp__formtools__form_state`, `mcp__formtools__fill_fields` and
  `mcp__formtools__submit_and_verify` are the default path. Three calls complete
  a normal repair. They exist because driving the page with generic primitives
  cost 7.3s per call and 13 calls on a median run.
- `fill_fields` takes every id and value in ONE call and reads each value back
  afterwards, so a control that was clicked but did not commit returns
  `ok: false` instead of looking repaired. Trust that flag over your own
  impression of what happened.
- Fall back to `browser_select_option` / `browser_type` / `browser_click` /
  `browser_fill_form` for whatever `fill_fields` reports it could not do, and
  for anything unusual: navigation, iframes, file pickers, tabs.
- Use `browser_run_code_unsafe` only when a control is unreachable by role or
  selector. Never use it to submit the form — a submission must go through a real
  click so the page's own handlers run.
- Never interact with, close, or create any tab other than your own.

## Final message

Your FINAL message must be JSON matching the required schema:

```json
{"outcome": "submitted"|"failed"|"gave_up",
 "tab_url": "<url of the tab you worked on>",
 "fixed": ["<what you fixed>"],
 "inferred": ["<answers you inferred>"],
 "unfixable": ["<fields impossible to complete>"],
 "notes": "<short summary>"}
```

`fixed` and `unfixable` should name the field ids from the dossier where you have
them — that is what the run is graded against.

Platform-specific control idioms: read `references/platform-quirks.md` next to this
file when a control does not behave as expected.
