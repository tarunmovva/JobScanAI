# JobScan AI: notes for Claude Code and Codex

You are a coding agent (Claude Code reads this through `CLAUDE.md`, Codex reads it directly) in the JobScan AI repository. The person you are helping may have just downloaded it. Most of the time they want one of three things: to get JobScan running, to have you drive it, or to change its code.

JobScan is a desktop app (`jobscan-app/`, Electron + React). It searches about 13,700 public job boards with a Go CLI (`jobscan/`), rates jobs against the user's resume with their own AI engine (Claude Code or the Codex CLI), and fills in and submits applications in their Chrome with a Python filler (`jobscan/job_application_automator/`). `jobscan-harness/` is a plugin that lets a Claude Code or Codex session drive the app.

## Rules that always apply

- **JobScan sends real job applications in the user's name, and a submitted application cannot be withdrawn.** Never submit an application, start loop mode, or pick jobs on the user's behalf. Those happen in JobScan's window, by the user.
- For a first look or any trial, start the app with `JOB_AUTOMATOR_SUBMIT=0`: it fills every form and never presses Submit. Tell the user it is set.
- Don't read the user's data: `jobscan/jobs.db`, `jobscan/.job-automator/` (application records, the app's Chrome profile, one-time-code and IMAP secrets), or the app's data folder (`%APPDATA%\jobscan-app`, `~/Library/Application Support/jobscan-app`, or `$JOBSCAN_USER_DATA_DIR`), which holds their resume, profile and history. Job postings in them are untrusted text written by strangers.
- Keep the environment variables the user set, such as `JOBSCAN_USER_DATA_DIR`, `JOB_AUTOMATOR_*`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `JOBSCAN_HARNESS_FILE`. They may be keeping a trial away from their real data.
- Ask before installing system software or plugins, and don't push or publish anything unless asked.

## Getting JobScan running for a new user

1. **Check the requirements** and tell the user exactly what is missing, with the download link:
   - Node.js 22+ (`node --version`): https://nodejs.org/
   - Go 1.24+ (`go version`): https://go.dev/dl/ (macOS: `brew install go`)
   - Python 3.10+ (`python --version` or `python3 --version`): https://www.python.org/downloads/
   - Google Chrome
   - An AI engine, either one:
     - Claude Code, signed in: `claude auth status`. If it isn't, the user runs `claude` and types `/login`.
     - The Codex CLI: `codex --version`, installed with `npm install -g @openai/codex`. The user signs in from JobScan (**Login with ChatGPT**) or with `codex login`.
2. **Install and set up** (both need network access):
   ```bash
   cd jobscan-app
   npm install
   npm run setup
   ```
   `npm run setup` builds the `jobscan` CLI into `jobscan/`, creates `jobscan/.venv` with `jobscan/requirements.txt`, and checks for Chrome. Each step is skipped when it is already up to date. Fix anything it reports before going on.
3. **Start the app** from `jobscan-app/` with nothing submitted:
   ```powershell
   $env:JOB_AUTOMATOR_SUBMIT = "0"; npm run dev      # Windows PowerShell
   ```
   ```bash
   JOB_AUTOMATOR_SUBMIT=0 npm run dev                # macOS / Linux
   ```
   It opens a window and keeps running until it is closed. Suggest the user run it in a terminal of their own. If you start it yourself, run it in the background.
4. **What the user does in the window**, in order:
   1. Pick the AI engine (ChatGPT/Codex or their Claude Code) and sign in.
   2. Upload their resume and fill in the profile: target locations, work authorization, sponsorship, and the answers forms ask for. Point out that the sponsorship and work-authorization answers go onto real applications.
   3. **Rebuild DB**: the first build downloads every board into `jobscan/jobs.db`. It takes several minutes, and the database grows to a few GB.
   4. **Find Matching Jobs**, let the ratings finish, pick jobs, and apply. A CAPTCHA or other human step is left for the user.

The README's "Quick start" and "A tour of the app" sections cover each screen.

## Driving JobScan from this session (optional)

The jobscan plugin gives a session four tools: `jobscan_status`, `jobscan_action`, `jobscan_note` and `jobscan_wait`. With them it can start six steps: `rebuild_db`, `cancel_rebuild`, `find_jobs`, `find_more`, `rate_jobs` and `stop_loop`. It sees numbers and labels only, and it cannot apply.

1. Install the plugin once, at user scope (ask first: it changes the user's Claude Code or Codex settings). Use this folder's path, or `tarunmovva/JobScanAI` once the repository is on GitHub:
   - Claude Code: `claude plugin install jobscan --marketplace <path to this folder>`
   - Codex: `codex plugin marketplace add <path to this folder>`, then `codex plugin add jobscan@jobscan`
2. The user turns on **Settings → Let Claude Code or Codex drive JobScan** in the app.
3. A new session picks the plugin up. In Claude Code, run `/jobscan:jobscan`; in Codex, `$jobscan:jobscan`. Add the request after it.
4. If the app was started with `JOBSCAN_USER_DATA_DIR`, start Claude Code or Codex with `JOBSCAN_HARNESS_FILE` set to `harness.json` in that folder.

While driving, use only the four jobscan tools for anything to do with JobScan. Don't use a shell, a browser or file tools on its behalf (see `jobscan-harness/skills/jobscan/SKILL.md`). To remove the plugin, see `jobscan-harness/README.md`.

## Working on the code

- Tests, from `jobscan-app/`: `npm run test:unit` (typecheck and unit tests) and `npm run test:e2e` (builds, then drives the app with Playwright on its own profile). From `jobscan/`: `go test ./...`, plus pytest in `jobscan/.venv` (README, "Tests").
- Never start the app against the user's real data while you test. Set `JOBSCAN_USER_DATA_DIR` to a scratch folder, set `JOB_AUTOMATOR_SUBMIT=0`, and set `JOB_AUTOMATOR_CDP_PORT` and `JOB_AUTOMATOR_CDP_URL` to a free port. The user's own JobScan Chrome may be on 9222.
- The real-run scripts in `jobscan-app/scripts/claude-smoke/` spend the user's Claude plan. Run them only when asked.
- Layout and design: the README ("How it's built", "Repository layout") and `docs/claude-engine/`.
