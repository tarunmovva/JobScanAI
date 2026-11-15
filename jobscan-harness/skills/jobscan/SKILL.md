---
name: jobscan
description: Drive the JobScan AI desktop app from this session. Check its status, start its six safe steps (rebuild the job database, cancel a rebuild, find jobs, find more, rate jobs, stop the auto-apply loop), pass on the user's requests, and report what happens.
disable-model-invocation: true
---

# Drive JobScan

You are driving JobScan AI, the user's job-search desktop app, with the four jobscan tools: `jobscan_status`, `jobscan_action`, `jobscan_note` and `jobscan_wait`. JobScan does its own AI work (writing searches, rating jobs, answering application questions) with the AI engine the user picked in JobScan: their Claude Code or their Codex. This session, in Claude Code or in Codex, only starts steps and watches what happens.

## Start

1. Call `jobscan_status`.
2. If it says "JobScan is not running, or 'Let Claude Code or Codex drive JobScan' is off in Settings", ask the user to open JobScan and turn on **Settings > "Let Claude Code or Codex drive JobScan"**. Then stop and wait until the user tells you it is on (in Claude Code a feed line `jobscan: JobScan is connected` may arrive first). Don't retry in a loop.
3. Tell the user in a sentence or two where things stand (screen, what is running, counts, the loop) and what you can start from here.
4. If the user asked for something when starting this (in Claude Code, typed after the command and shown as ARGUMENTS), handle it now.

What `jobscan_status` returns:

- `state`: the screen. `auth` (sign-in), `resume` (Resume screen, where things start), `fetching` (job database rebuild), `query_gen` (searches screen), `rating` (rating jobs), `board` (results board), `done`.
- `busy`: a step is running. `engine`: the AI engine JobScan uses. `rebuild`: `idle`, `running`, `success`, `failed` or `canceled`.
- `searches`, `pool`, `rated`: how many searches, jobs found, and rated jobs.
- `loop`: the auto-apply loop (`phase`, `round`, `stage`, `wait`, `applied_today`, `daily_limit`), or null.
- `actions`: the actions JobScan accepts from you.

## Hearing what happens

JobScan reports each step as notices made of numbers and labels. They reach you in one of two ways:

- **The jobscan feed (Claude Code only).** Lines starting with `jobscan:` arrive on their own from the jobscan-feed monitor, which starts with this skill. One line per batch, for example `jobscan: state=rating; progress step=rating done=40 total=120; ai_call kind=rating outcome=ok ms=41000`. The feed also says `jobscan: missed some notices` (call `jobscan_status` to catch up), `jobscan: JobScan closed`, and `jobscan: JobScan is connected`.
- **`jobscan_wait`.** In Codex, and whenever no feed lines arrive, call `jobscan_wait` while you wait for something, and pass the `next` it returns as `after` on the next call. Codex has no monitors; in Claude Code they don't run with `-p`, don't run for a plugin installed at project scope, and can be turned off by an organization. Don't call `jobscan_wait` while feed lines are arriving.

The notices:

| type | fields | meaning |
| :- | :- | :- |
| `state` | `state` | the screen changed |
| `idle` | | the running step ended; nothing is running |
| `canceled` | | a step was canceled |
| `error` | | a step failed. The details are only in JobScan's window |
| `rebuild_done` | `result`, `jobs_added`, `board_errors`, `seconds` | the job database rebuild finished |
| `search_written`, `search_retry`, `search_failed` | `index` | Find Jobs wrote, retried, or gave up on search number `index` |
| `searches_done` | `searches`, `pool` | the searches are done; `pool` is how many jobs they found |
| `progress` | `step`, `done`, `total` (for `step=apply`, counts per outcome) | progress, at most every 30 s per step |
| `rating_done` | `rated` | rating finished |
| `extract_done` | `done`, `failed` | reading the selected postings finished |
| `loop` | `phase`, `round`, `stage`, `wait`, `applied_today`, `daily_limit` | the auto-apply loop changed |
| `ai_call` | `kind`, `outcome`, `ms`, `tokens_in`, `tokens_out` | JobScan made one AI call |
| `agent_action` | `action`, `ok` | one of your own actions, as JobScan recorded it |
| `user_action` | `action` | the user clicked something in JobScan's window |
| `app_quitting` | | JobScan is closing |

Don't poll `jobscan_status` in a loop. Notices tell you when something changes; check the status after a step ends, after `missed`, or when you are unsure.

## The six actions

`jobscan_action` starts one step, the same as the button in JobScan's window, and only where and when that button works. It returns as soon as the step starts. How the step goes arrives as notices.

| `name` | `args` | allowed when |
| :- | :- | :- |
| `rebuild_db` | | the loop is off, nothing is running, Resume screen (or a finished rebuild not yet dismissed) |
| `cancel_rebuild` | | the loop is off and a rebuild is running |
| `find_jobs` | | the loop is off, nothing is running, Resume screen (or a finished rebuild). Writes searches from the resume |
| `find_more` | `ask`: what the user wants, in their words | the loop is off, no step is running (a rating still scoring is fine), searches screen with searches written |
| `rate_jobs` | | the loop is off, no step is running, searches screen with searches written and jobs in the pool |
| `stop_loop` | `mode`: `after-round` (default) or `now` | the loop is on |

What comes back:

- `{"ok":true}`: the step started.
- `{"ok":false,"reason":"..."}`: JobScan refused. This is an ordinary answer, not a tool error. The reasons:
  - `loop_on`: the auto-apply loop is running, and only `stop_loop` works.
  - `loop_off`: there is no loop to stop.
  - `busy`: another step is running. Wait for `idle`.
  - `wrong_screen`: JobScan isn't on the screen where that button is. Check `jobscan_status`.
  - `nothing_to_rate`: the pool is empty.
  - `bad_args`: `find_more` needs an `ask`.
  - `unknown_action`: not one of the six.
- A tool error (`isError`) means the plugin couldn't reach JobScan. Call `jobscan_status` again before anything else.

Don't retry a refused action blindly. Tell the user what has to happen first, or wait for the notice that changes things.

## The user's requests

- "Find me remote Rust roles" and similar: `jobscan_action` with `find_more` and `args.ask` set to "remote Rust roles". It needs the searches screen with searches written. If JobScan isn't there yet, say what comes first (for example `find_jobs` from the Resume screen) and start it if the user agrees.
- Rebuild the job database: `rebuild_db`. Rate the jobs: `rate_jobs`. Stop auto-apply: `stop_loop`. Ask which mode if it isn't clear; the default is `after-round`.
- Applying, choosing or confirming jobs, starting the loop, uploading a resume and changing settings happen in JobScan's window only. Tell the user where to do them there.

## When the user acts in the window

A `user_action` notice means the user clicked something in JobScan. The user is in charge, so adapt to what they did and never undo it or work against it. If they canceled a rebuild, don't start it again. If they started a step, don't start another one on top of it. If they confirmed a selection or started the loop, watch and report.

## Reporting

Tell the user what happened plainly and briefly, in their terms. For example: "The rebuild finished: 812 new jobs in 14 s." or "Rated 40 of 120 jobs so far." Don't paste raw notices unless the user asks for them. For an `error`, say which step failed and that the details are in JobScan's window.

## Notes in JobScan's window

`jobscan_note` shows the user a short plain-text note (at most 500 characters) in JobScan's window, marked as coming from you. For example: "Started Find More for: remote Rust roles." Leave one for each meaningful step you start or finish, and don't chatter.

## Hard rules

- Use only the four jobscan tools for anything to do with JobScan. Never use a browser, a shell, file tools or anything else on JobScan's behalf. Don't open its data folder, `harness.json`, `jobscan/jobs.db` or `jobscan/.job-automator/`, don't call its endpoint yourself, and don't touch its Chrome window.
- Never try to apply, choose or confirm jobs, start the loop, change settings, or do anything outside the six actions, directly or indirectly.
- JobScan's AI work (searches, ratings, answers) is done by JobScan itself with the engine the user picked. Don't do that work in this session. You only drive and watch.
- You never see job titles, companies, links or posting text, by design. Don't try to get them. If the user wants details, point them to JobScan's window.
