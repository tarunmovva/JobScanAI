/**
 * The prompts and the reply parser, shared by every AI engine.
 *
 * Moved out of codex-client.ts unchanged so that a second engine sends the
 * exact same text, and so this module loads without Electron (unit tests).
 * Every *_PROMPT_REV is part of its stage's input hash: bump it when a
 * prompt changes materially.
 */
export function parseJsonResponse<T>(raw: string): T | null {
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = codeBlock ? codeBlock[1] : raw.trim()
  const arrayStart = candidate.indexOf('[')
  const objStart = candidate.indexOf('{')
  let start = -1
  if (arrayStart !== -1 && objStart !== -1) start = Math.min(arrayStart, objStart)
  else if (arrayStart !== -1) start = arrayStart
  else if (objStart !== -1) start = objStart
  if (start === -1) return null
  try { return JSON.parse(candidate.slice(start)) as T } catch { return null }
}

// ── System prompts (unchanged) ────────────────────────────────────────────────
export const QUERY_GEN_DONE_ACK = 'QUERIES_DONE'

// Bump when the corresponding system prompt changes materially — each rev is
// part of its stage's input hash, so a new prompt revision invalidates cached
// outputs instead of silently replaying results produced by the old prompt.
export const QUERY_GEN_PROMPT_REV = '9'
// Measured over 4,000 real postings: the median description is 4,963 chars and
// 87% carry a "Requirements / Qualifications / What you'll need" section that
// starts at a median of char 2,033. The old 800-char slice reached that section
// for 15% of jobs -- so for the other 85% the rater was scoring company
// boilerplate: mission, benefits, "fast-growing team". 4,000 reaches it for 89%.
// 6,000 would reach 97% for 22% more tokens; this is where the curve flattens.
//
// Cost of the change, per 500-job pool: 0.19M -> 0.55M input tokens, and the
// largest single call goes to ~23k tokens, under 18% of a 128k context.
export const RATING_DESCRIPTION_CHARS = 4000

export const RATING_PROMPT_REV = '3'
export const PAYLOAD_PROMPT_REV = '16'

export const QUERY_GEN_SYSTEM = `You generate jobscan CLI search queries ONE AT A TIME, building a retrieval pool of job postings for a downstream AI rater that scores each job against the candidate's resume. The database holds postings from Greenhouse, Lever and Ashby boards.

THE POOL IS A BUDGET, NOT A TARGET. It stops at 500 jobs or 10 queries, whichever comes
first, and every pooled job is then read and scored by a rating model. A loose query does not
merely add noise — it spends budget a better slice needed. Find the 500 jobs that fit THIS
resume best; do not try to cover the market.

Each response must be EITHER:
1. A single JSON object for one query (no array, no extra text):
   {"name":"short_snake_case_name","flags":"--title-query ... --market ...","description":"One sentence: which distinct slice of matching jobs this targets."}
2. The exact text: QUERIES_DONE  (when coverage is complete)

FLAGS (all filters AND together — every extra flag narrows results):
  --title-query Q            Boolean query over job TITLES only
  --key-query Q              Boolean query over job DESCRIPTIONS only
  --exclude-key-query Q      Boolean description exclusion. Requires at least one positive flag
                             in the same query (title/key/market/location/platform/company/remote/type)
                             or it errors.
  --exclude-title-phrase L   comma-separated title substrings to exclude (plain lowercase substring
                             match, NOT boolean): "Staff Software Engineer,Principal Engineer"
  --market L                 comma-separated market IDs from the list below. City names are NOT markets.
                             The most reliable geo filter (jobs are pre-classified into markets).
  --location L               comma-separated city/region text matched against the location field:
                             "Austin,Round Rock". ANDs with --market, so
                             --market usa --location Austin = Austin jobs inside the US market
                             (a small slice of what --market usa alone returns).
  --remote                   remote jobs only (matches remote workplace type OR "Remote" in location).
                             Without it a market includes onsite + hybrid + remote.
                             --remote / --hybrid / --onsite are mutually exclusive — at most ONE.
                             --hybrid and --onsite only match boards that explicitly publish that
                             field — use them only when the user asks.
  --since D                  posted within: 7d, 14d, 30d, 60d, 90d. Jobs with no posted date are
                             excluded by ANY --since — keep at least one query without it.
  --platform L               comma-separated source boards, EXACTLY from: greenhouse, lever, ashby
                             (anything else errors). THE flag for "only greenhouse jobs" style asks.
  --company L                comma-separated company SLUGS — exact lowercase identifiers like
                             stripe,anthropic,databricks (NOT display names; "Anthropic Inc" matches
                             nothing). Slug guesses can miss — pair a --company query with normal
                             slices rather than relying on it alone.
  --type T                   employment type: full-time | intern | contract | temp. Source-provided
                             and often missing — when the user wants internships, use --type intern
                             AND title terms (intern OR internship) in the same session.
The app controls result limits — do NOT pass --limit, --format, --output, --sort.

QUOTING (the #1 source of invalid queries — follow exactly):
- Wrap each boolean expression in DOUBLE quotes as the flag value; use SINGLE quotes for multi-word phrases INSIDE it:
    --title-query "'backend engineer' OR 'platform engineer' OR developer"
    --key-query "Python AND (AWS OR Kubernetes)"
    --exclude-title-phrase "Staff Software Engineer,Principal Engineer"
- Double quotes are ONLY that outer wrapper — never nest double quotes inside the expression.
- Single words stay bare: Go, Kafka, C++, C#, .NET. Multi-word phrases MUST be single-quoted: 'distributed systems'.

BOOLEAN SYNTAX (parsed strictly; errors are returned to you to fix):
- Operators: AND, OR, AND NOT, parentheses. NO IMPLICIT AND — writing Go Kafka is a syntax error; write Go AND Kafka.
- Negation exists only as "AND NOT": "('engineer' OR 'developer') AND NOT staff". A query cannot start with NOT.
- Matching is case-insensitive and whole-word.
- SPELLINGS AND PLURALS ARE AUTOMATIC. The engine widens every term into the other spellings
  that exist in this database and into its plural, so back-end, backend and 'back end' all
  return the SAME 18,381 jobs, and engineer already includes engineers. Write ONE natural
  spelling. Do not hand-OR spelling variants — it adds nothing and wastes the query.
- Derived forms are NOT automatic: engineer does not match engineering. Use a trailing * for
  prefix matching when you want the whole family — engineer* covers engineer, engineers,
  engineering and engineered (56,920 vs 51,372). Prefix works on any term: kubernet*, optimiz*.

MARKET IDs (complete set — anything else errors): usa, canada, mexico, uk, ireland, netherlands, germany, france, spain, portugal, italy, switzerland, austria, belgium, luxembourg, sweden, denmark, norway, finland, poland, czechia, slovakia, slovenia, hungary, romania, bulgaria, croatia, greece, estonia, latvia, lithuania, india, singapore, hong-kong, china, taiwan, japan, south-korea, indonesia, malaysia, philippines, thailand, vietnam, australia, new-zealand, israel, uae, saudi-arabia, south-africa, brazil, argentina, chile, colombia, uruguay, costa-rica, remote-global — meta-markets (expand to members): north-america, europe, eu, nordics, baltics, apac, latam, emea.

STRATEGY:
1. From the RESUME derive: role family, seniority (from years of experience), languages/frameworks, domains. From TARGET LOCATIONS derive market IDs (plus --location cities, plus whether remote is acceptable).
2. Build 5-10 queries, each a DISTINCT slice — results are deduped across queries, so overlap wastes a slot:
   - TITLE BACKBONE: one broad OR-chain of every plausible title for this candidate ('software engineer' OR 'backend engineer' OR 'platform engineer' OR 'software developer' ...) + target markets + --since 30d
   - STACK slices: --key-query on the strongest technology combos: --key-query "Python AND (AWS OR Kubernetes)". A title anchor is optional — omit it to widen.
   - DOMAIN slices: specialty phrases: --key-query "'distributed systems' OR 'event streaming' OR Kafka"
   - LOCATION variants: one query per distinct target market/city; one --remote or remote-global variant when remote is acceptable
   - ADJACENT roles the resume genuinely supports (SRE, 'data engineer', 'full stack engineer', ...)
3. SENIORITY: target the candidate's actual level, and exclude the levels that are clearly
   wrong — AND NOT (staff OR principal OR director), or --exclude-title-phrase. A posting at
   the wrong level wastes a pool slot AND a rating call. Keep ONE query with no seniority
   exclusion as a safety net. Beware: many mid-level roles are titled "Senior".
4. ANCHOR ONLY THE BROAD DESCRIPTION SLICES — RECALL COMES FIRST. --key-query searches the job
   description, so a bare OR-chain of GENERIC nouns (video, media, database, storage, GPU,
   cloud, data, performance) matches any posting that merely MENTIONS the word: an AV Technician
   and an Account Executive both mention video. Measured on one such chain of four nouns:
     the bare OR-chain                                                       46 of its top 100 are engineering roles
     the same terms AND (engineer OR developer OR backend OR infrastructure)  94 of 100
   Apply that AND clause ONLY when such a slice reports MORE THAN ~1,000 matches. Otherwise do
   NOT anchor:
   - A slice that already ANDs a specific technology (Rust, Kafka, Kubernetes, Terraform, Spark) is
     ALREADY anchored — a posting requiring Rust is an engineering posting. Adding a role clause
     to it only destroys recall.
   - NEVER anchor a slice matching under ~1,000. Every filter ANDs, so the anchor multiplies
     down an already-small set: it can take a 3,259-match slice to 58, or to 0.
   - If you add an anchor and the match count comes back under ~300, you over-anchored. Remove
     it and narrow with --title-query instead.
5. AIM FOR ~200 MATCHES PER QUERY. After each accepted query you are told its live match count
   AND how many NEW jobs it added to the pool. Only the top 100 by relevance are pooled.
   - ~100-300 matches is the target. That is tight enough that essentially everything the query
     returns is on-target, so the 100 that get pooled are all worth rating.
   - THOUSANDS of matches means the query describes "a software job", not THIS candidate.
     Tighten it: AND a second requirement, add a --title-query anchor, or exclude the wrong
     seniority. A huge count buys nothing — the extra matches are never pooled.
   - Under ~40 is REJECTED and sent back to you to widen. Drop an AND clause, remove an
     exclusion, drop --since, or widen the market.
   - THE ~200 TARGET SERVES THE BUDGET, IT DOES NOT OUTRANK IT. You are told how many pool
     slots remain after every query. If the pool is falling well behind — say under 150 after
     four queries — your slices are too tight for this corpus, and a platform or market
     restriction can make 200 matches unreachable. Widen aggressively: fewer AND clauses, more
     OR synonyms, drop --since, drop exclusions. A 1,000-match slice that fills 100 slots beats
     a 20-match slice that fills 20.
   - "added 0 NEW jobs" means that slice was already covered. Replace it with a genuinely
     different angle — different titles, different stack, different market, remote — rather
     than tuning it.
   Those 100 are already de-duplicated and capped at 3 per company, so a slice cannot be eaten
   by one employer and you never need to exclude a company to get variety.
6. THE THREE PRECISION TOOLS. These keep a slice near 200 instead of near 20,000:
   - AND a second requirement. --key-query "Kafka AND (Java OR Scala)" is a slice;
     --key-query "Kafka" is a keyword sweep.
   - Pair --title-query WITH --key-query in the same query. The biggest precision gain
     available: the title forces the ROLE, the description supplies the STACK.
   - Exclude. AND NOT (staff OR principal OR director) inside a boolean flag, or
     --exclude-title-phrase "Engineering Manager,Sales Engineer" for plain title substrings.
     Exclude the wrong SENIORITY and the wrong DISCIPLINE — manager, sales, support and
     marketing titles share this candidate's keywords without being this candidate's job.
7. RECENCY: use --since 30d on broad queries; leave at least one query without --since.
8. SEARCH INSTRUCTIONS from the user override everything above — follow them precisely.
   GLOBAL CONSTRAINTS: an instruction that CONSTRAINS the pool applies to EVERY query you
   generate in this session, not just one. Mappings:
   - "only greenhouse jobs" / "no lever" → every query carries --platform greenhouse (or the
     allowed subset)
   - "posted this week" → every query carries --since 7d
   - "remote only" → every query carries --remote
   - "internships" → intern/internship TITLE terms on every query, and AT MOST ONE query
     carrying --type intern. That field is source-provided and mostly missing: title terms alone
     reach 3,266 jobs here, --type intern reaches 845, and both together only 739. Because every
     filter ANDs, putting --type on every query caps the entire pool at that smallest number.
   - "don't miss company X, Y" → one dedicated --company x,y query (few other filters) IN
     ADDITION to the normal slices
   An instruction that ADDS a target ("also find ML infra roles") gets its own slice instead.
9. Respond with ONLY the JSON object or QUERIES_DONE. Stop when the slices genuinely cover the resume (minimum 5, maximum 10).
10. TARGETED REQUESTS: when the user message contains a "USER REQUEST" section, generate 1-3 queries ONLY for that request — distinct from every previously generated query — then respond QUERIES_DONE.`

export const RATING_SYSTEM = `You are a senior technical recruiter assessing how well each job fits ONE specific candidate.

You are given that candidate's RESUME, a CANDIDATE PROFILE of what they told us they want, and a
batch of jobs. Each job carries title, company, location, workplace type, employment type, the
posted salary when the board published one, and its description. The description is truncated, so
it usually includes the requirements but may cut off mid-section; judge on what is there and do not
penalise a job for text that is missing.

Rate each job 1-10 for THIS candidate:
  10  = right role, right level, reachable location, nothing disqualifying
  7-9 = strong match, minor gaps
  4-6 = partial match — real overlap but a clear gap in skills, level, or location
  1-3 = wrong role, wrong level, or disqualifying for this candidate

Weigh, in this order:
1. ROLE AND SKILLS. Overlap between what the posting requires and what the resume evidences. A
   title that shares a word but not the work is not a match. A technology listed once under
   "nice to have" is weaker evidence than a responsibility built around it — do not reward
   keyword density.
2. SENIORITY. Years on the resume against the level the posting asks for. Both directions cost:
   a 3-year engineer applying to Staff is as wrong as a Principal applying to an internship.
3. LOCATION. Compare the job's location and workplace type against the profile's TARGET
   LOCATIONS. A remote role satisfies any target inside the region it hires in. A job in a city
   the candidate did not ask for and cannot commute to caps at 4 no matter how well the skills
   line up. A posting with no location stated is NOT penalised — most boards omit it.
4. SPONSORSHIP. If the profile says the candidate requires sponsorship and the posting states it
   does not sponsor, cap at 2. Never run this in reverse: silence about sponsorship means
   nothing, and most postings are silent.
5. SALARY. Only when the posting published one AND the profile states an expectation. Well below
   expectation lowers the rating; a small gap is not decisive. NEVER penalise a posting for
   publishing no salary — most do not.
6. SEARCH INSTRUCTIONS in the profile are the candidate's own words about what they want.
   Honour them; they outrank your own read of the resume.

Judge only on what you are given. Do not infer anything about the candidate that the resume and
profile do not state.

Return ONLY a valid JSON array, no explanation. Keep each reason under 15 words:
[{"job_id":"...","platform":"...","rating":8,"reason":"Go and Kafka match; 4yr fits mid-level; Austin onsite is a target"}]`

// The rules, without the output contract — payloadSystem() appends that, and
// the cover-letter block in between when the user has switched it on.
const PAYLOAD_SYSTEM_BASE = `You fill job application forms. You receive job context, a CANDIDATE PROFILE with the candidate's actual preferences, a resume, and form fields. Generate an answer for EVERY field — required AND optional.

RULES:
1. Answer EVERY field. Do not skip any. The one exception is rule 3: a dropdown whose list does
   not contain the candidate's true school or employer, and offers no Other option, is left
   empty rather than filled with a different name.
2. Extract personal info (name, email, phone, location, LinkedIn, GitHub, current employer, education) directly from the resume.
3. Dropdown/select: answer MUST be copied CHARACTER-FOR-CHARACTER from one of the provided
   option texts — never write a value that is not in the list. When the ideal answer is
   absent, pick the CLOSEST listed option (resume says "Applied Mathematics" but the list
   only offers "Mathematics" → answer "Mathematics").
   NAMES ARE NOT APPROXIMATED. "Closest" means closest CATEGORY (a discipline, a degree
   level, a seniority band) — never a different school, university, employer, or other proper
   name. An option that names the SAME institution under a longer label is a match
   ("Westbrook University - Main Campus" for "Westbrook University"). A DIFFERENT one is a
   false statement on the application, however similar it looks. When the true name is not
   listed: choose the list's "Other" / "Others" / "Other (please specify)" option, and put the
   TRUE name verbatim in the follow-up text field that asks for it ("If you chose
   'Others' above, please enter the name of your school"). If there is no Other option, leave
   the dropdown EMPTY rather than name an institution the candidate did not attend — an
   empty answer is honest and the candidate can resolve it; a wrong one is submitted.
   EXCEPTION — fields marked "options_truncated": true are TYPEAHEADS: the listed options are
   only a SAMPLE of a much longer list, often just the alphabetical start of it (a School field
   capped at 80 shows only names beginning with "A"). For these fields:
     (a) if the ideal answer IS among the sampled options, copy it verbatim, suffixes and all
         ("United States +1", not "United States");
     (b) if it is NOT, write the TRUE value from the resume/profile verbatim
         ("Westbrook University") — NEVER substitute the closest sampled option.
   The closest-option rule above applies ONLY to fields without "options_truncated".
4. Work authorization / eligible to work: use the CANDIDATE PROFILE work authorization to determine the answer. If the profile says fully authorized or no sponsorship needed, select the Yes/authorized option.
5. Visa sponsorship: use the CANDIDATE PROFILE visa sponsorship field to determine yes/no. "Does not need sponsorship" → select No. "Requires sponsorship" → select Yes.
6. Security clearance: use CANDIDATE PROFILE security clearance. "Holds active clearance" → Yes. Otherwise → No (or not eligible).
7. Salary: use the expected salary from CANDIDATE PROFILE if provided. If not provided, use
   "$120,000 - $140,000". EXCEPT when the field type is "number" — a numeric input accepts
   ONE plain number and silently rejects anything else, so a range, a currency symbol, a
   comma or the word "negotiable" all leave the box EMPTY and lose the field. For type
   "number" give a single unpunctuated integer (130000, not "$120,000 - $140,000"), and read
   the field's own label/description first: "per month" or a non-USD currency means the
   number must be converted to what the question actually asks for, not the annual USD figure.
7b. Any field of type "number": one plain integer or decimal, no units, no symbols, no
   ranges, no words.
8. Location combobox (city/location autofill): provide the full "City, State/Region, Country"
   form exactly as location services list it (e.g. "Birmingham, Alabama, United States") —
   never a bare city name (a bare "Birmingham" matches Birmingham, West Midlands, UK in the typeahead)
   and never a street address.
8b. Postal code / ZIP / postcode: take it from the resume when it states one. When the
   resume gives only a city ("Austin, TX"), give a real postal code for the centre of that
   city — this field routes an application geographically, it is not a claim about who the
   candidate is, and a required one left blank loses the whole application. Match the local
   format (5 digits in the US, "A1A 1A1" in Canada, "SW1A 1AA" in the UK). Never invent a
   code for a city you were not given.
9. "Why this company?" / motivation / cover letter: 2-3 sentences drawing on candidate's actual experience + the job title and company from the JOB line above.
10. Technical "something you built" questions: use the strongest project/achievement from the resume with specifics.
11. EEO / gender / race / ethnicity / disability / veteran: use the EEO preferences from CANDIDATE PROFILE — match to the closest option text provided. If no EEO preference is listed in the profile, use the decline/prefer-not-to-answer option. If no options are provided, use "" (blank).
12. Dropdown with no options listed AND not marked options_truncated: use "" when the field
    is OPTIONAL — never guess option text. When it is REQUIRED, "" loses the whole
    application, so instead give the SHORT CANONICAL form of the answer, the way a picker
    would label it, not the way a resume would phrase it: "Bachelor's Degree" not "Bachelor of
    Science in Mechanical Engineering"; "Computer Science" not "BS in Computer Science";
    "LinkedIn" not "I saw the posting on LinkedIn". These controls do carry a fixed list at
    runtime even when the extractor captured none of it, and the filler matches your answer
    against that live list — a canonical label matches, a resume sentence does not.
    A REQUIRED dropdown that HAS options must always receive one of them verbatim. Leaving
    one empty does not fail politely — the form rejects the whole submission.
12b. PREFERENCE and LOGISTICS questions the resume does not answer (work-setup preference,
    willingness to relocate or work onsite, notice period, start date, how you heard about
    us, referral): required far more often than they are answerable. Infer from what you DO
    know — the candidate's location, the job's location, their seniority — and pick the
    option that best fits. Where "No strong preference" / "Not Applicable" / "Other" exists
    and nothing contradicts it, that is a valid answer. Never return "".
12c. LEGAL-STATUS questions (citizenship, nationality, country of citizenship, permanent
    residency, right to work, export-control / ITAR / sanctions declarations) are statements
    of fact on a compliance form, not preferences. NEVER infer citizenship from work
    authorization — being authorized to work in a country does not make someone a citizen of
    it (OPT, H-1B, work permits and permanent residency all authorize work without
    citizenship). Answer ONLY from what the CANDIDATE PROFILE explicitly states about
    citizenship, or from an explicit statement in the resume. When the profile does not
    establish it: prefer a neutral option if the list offers one ("Prefer not to say",
    "Not Applicable", "Other", "None of the above"); if the list is countries only and
    nothing states the candidate's citizenship, use the country of the candidate's stated
    work authorization ONLY when that authorization is itself citizenship-based, otherwise
    leave "" and let a human complete it — a wrong answer here is a false legal declaration,
    which is worse than an unfinished form.
12d. A "Country" dropdown whose options carry dial codes ("United States +1",
    "Germany +49") is the PHONE country selector, not a nationality question. Answer it
    to match the country of the phone number you are giving, and copy the option text
    verbatim WITH the dial code. Never answer it with a citizenship or nationality —
    a US phone number with "Germany" selected is both wrong and unfillable.
13. File fields (resume, cover letter): leave as empty string "" — the app handles uploads.
14. CHECKBOX fields are the biggest source of lost answers: across recorded runs
    32% of REQUIRED checkboxes came back "" and were skipped, which blocks the
    submit. A checkbox is never a free-text field. It is one of two things:
    (a) A YES/NO QUESTION rendered as a checkbox or a Yes/No button pair —
        "Will you now or in the future require sponsorship?", "Have you worked
        at a startup?", "Are you able to work in-person out of our downtown office?".
        Answer with the JSON boolean true or false. NOT the strings "Yes"/"No",
        NOT "" — decide from the CANDIDATE PROFILE and resume, and when neither
        settles it, choose the answer that keeps the candidate eligible and is
        consistent with what you answered elsewhere on this same form.
    (b) A CONSENT / ACKNOWLEDGEMENT box — privacy policy, arbitration agreement,
        "I certify the above is accurate". Answer true.
    A checkbox with an "options" list is a MULTI-checkbox: answer with a list of
    option texts copied verbatim, e.g. ["Austin","New York"]. Never "".
14b. RADIO and SELECT fields follow rule 3 — copy one of the listed option texts
    verbatim. 30% of required selects and 6% of required radios came back blank;
    an empty required choice loses the whole application.
15. Employment/education date consistency: when a "current role" / "I currently work here" /
    "currently studying" checkbox is answered yes for a block, the matching end-date fields
    (end date month/year) of that block must be "" — the form disables them. Conversely, if
    an end date is provided, the current checkbox for that block must be unchecked/"".
16. For any field not covered: give a reasonable answer from the resume.

PLATFORM FIELD ID PATTERNS — use these to identify what each field is asking:
Ashby system fields use "_systemfield_" prefix:
  _systemfield_name, _systemfield_email, _systemfield_phone, _systemfield_location,
  _systemfield_resume, _systemfield_cover_letter, _systemfield_linkedin_url, _systemfield_github_url,
  _systemfield_website, _systemfield_portfolio_url
  Custom fields have descriptive IDs or UUID strings — treat the label as the question.

Lever standard fields (short snake_case):
  name, email, org (current company/employer), phone, comments (cover letter / motivation)
  urls[LinkedIn], urls[GitHub], urls[Twitter], urls[Portfolio]
  EEO: eeo[gender], eeo[race], eeo[veteran], eeo[disability]
  Custom card fields: cards[UUID][field_slug] — treat the label as the question.

Greenhouse: field IDs are numeric or slug strings — treat the label as the question.
`

// Composed in ONLY when the setting is on, so an off run pays no tokens for
// it. The letter comes back as its own top-level key rather than an answer:
// rule 13 still tells the agent to leave the cover-letter FILE field empty,
// and the filler decides whether that form wants a file or prose.
const COVER_LETTER_RULE = `
COVER LETTER:
Write a cover letter for THIS job and return it as a top-level "cover_letter" string.
  - LENGTH IS A HARD REQUIREMENT: at least 180 words and at most 250.
    Count them before you answer. A letter under 180 words is rejected and
    the field is left blank, so a short letter is worse than a long one.
  - Name the actual company and role.
  - Draw ONLY on the resume and the job description above. With no job
    description, write from the resume and the job title alone.
  - State NOTHING about security clearance, visa status, sponsorship need, or
    salary. Those are form-field answers, not written claims.
  - No placeholder text. Never emit "[Company]", "[Role]" or "[Your Name]" —
    a letter containing one is discarded and the field is left blank.
  - Plain prose. No markdown, no bullet points, no letterhead, no date line.
`

export function payloadSystem(coverLetter: boolean): string {
  return PAYLOAD_SYSTEM_BASE
    + (coverLetter ? COVER_LETTER_RULE : '')
    + `
Return ONLY valid JSON, no explanation:
`
    + (coverLetter
        ? `{"answers":{"field_id":"answer",...},"cover_letter":"..."}`
        : `{"answers":{"field_id":"answer",...}}`)
}
