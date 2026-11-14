# Platform control idioms

Read this when a control does not respond the way a plain HTML control would.
Everything here is behaviour the deterministic filler had to be taught the hard way.

## Greenhouse

**Typeahead dropdowns (School, Discipline, Country, Location).** The option list the
extractor captured is a SAMPLE capped at 80 entries, so a School list contains only
names beginning with "A". Type the real value into the control to search the full
list, then pick the match. Never settle for the closest sampled option.

**React-select menus need real key events.** The async option fetch listens to real
keyboard events; a synthetic `input` event (what a plain value-set produces) loads no
options at all. Type, do not assign.

**Background tabs throttle the menu.** When the menu opens with no options, press
`ArrowDown` — it forces the menu open and re-triggers the debounced fetch.

**Location comboboxes need the full place string.** A bare "Birmingham" matches
"Birmingham, West Midlands, United Kingdom". Use "City, State/Region, Country" —
"Birmingham, Alabama, United States". Some forms also offer an "Enter manually"
button that turns the combobox into plain text inputs.

**Form-disabled controls are the form's decision, not a bug.** A checked "I currently
work here" / "currently studying" checkbox disables that block's end-date month/year.
`disabled`, `readOnly`, `aria-disabled`, a `--is-disabled` container class, or an
enclosing `fieldset:disabled` all mean the same thing: leave it alone. Uncheck the
"current" checkbox first if the end date genuinely needs a value.

**Email verification after submit.** Greenhouse may show a security-code screen after
Submit. The system completes that step automatically — finish and note `otp_pending`
rather than trying to read the mailbox yourself.

**Field ids** are numeric or slug strings (`school--0`, `question_1234567890`). Treat
the label as the question.

## Lever

**Field ids** are short snake_case for standard fields: `name`, `email`, `phone`,
`org` (current employer), `comments` (cover letter / motivation).
URLs are bracketed: `urls[LinkedIn]`, `urls[GitHub]`, `urls[Portfolio]`.
EEO is bracketed: `eeo[gender]`, `eeo[race]`, `eeo[veteran]`, `eeo[disability]`.
Custom questions are `cards[UUID][field_slug]` — treat the label as the question.

## Ashby

**System fields carry a `_systemfield_` prefix**: `_systemfield_name`,
`_systemfield_email`, `_systemfield_phone`, `_systemfield_location`,
`_systemfield_resume`, `_systemfield_cover_letter`, `_systemfield_linkedin_url`,
`_systemfield_github_url`, `_systemfield_website`.

Custom fields have descriptive ids or bare UUID strings — treat the label as the
question.
