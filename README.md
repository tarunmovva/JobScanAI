# JobScan AI

A desktop app that finds job postings on public **Greenhouse**, **Lever** and **Ashby** job boards, rates each one against your résumé with **Codex** (your own ChatGPT account), and fills in — and submits — the applications you pick, in your own Chrome.

> **It sends real job applications.** A submitted application cannot be withdrawn. Read what it is about to send, start with a few jobs, and use loop mode (unattended rounds) only once you trust your profile and answers. You are responsible for what is submitted in your name and for following each site's terms.

## Requirements

- **Windows 10/11** or **macOS** (Apple Silicon or Intel)
- **Node.js 22+** — <https://nodejs.org/>
- **Go 1.24+** — <https://go.dev/dl/> (macOS: `brew install go`) — the `jobscan` CLI is built from source on your machine
- **Python 3.10+** — <https://www.python.org/downloads/> (macOS: `brew install python`) — runs the form filler
- **Google Chrome** — the filler drives your own Chrome (set `JOB_AUTOMATOR_CHROME_PATH` if it is not in the usual place)
- A **ChatGPT account with Codex access** — you sign in from the app; ratings and answers use your account's Codex usage

## Run it

```bash
git clone <this repository's URL> jobscan-ai
cd jobscan-ai/jobscan-app
npm install
npm run dev
```

`npm run dev` first runs `npm run setup` (`jobscan-app/scripts/setup.mjs`), which:

1. builds the `jobscan` CLI from `jobscan/` into `jobscan/jobscan` (`jobscan.exe` on Windows),
2. creates `jobscan/.venv` and installs `jobscan/requirements.txt` into it,
3. checks that Chrome is installed.

Each step is skipped when it is already up to date, so later starts are quick. Run `npm run setup` on its own to see every step.

## First run

1. **Sign in to Codex** when the app asks.
2. **Add your résumé and profile**: target locations, work authorization, the answers the forms ask for. The target location decides which markets the searches cover.
3. **Find jobs.** The first database build downloads postings from about 13,700 public job boards into `jobscan/jobs.db`. It takes a while and the database grows to a few GB.
4. **Rate, pick and apply.** The app opens Chrome with its own profile (remote debugging on port 9222) and fills each form. Applications needing a CAPTCHA or a person are left for you.

To watch the whole flow without sending anything, start the app with `JOB_AUTOMATOR_SUBMIT=0`: forms are filled but never submitted.

```powershell
# Windows (PowerShell)
$env:JOB_AUTOMATOR_SUBMIT = "0"
npm run dev
```

```bash
# macOS / Linux
JOB_AUTOMATOR_SUBMIT=0 npm run dev
```

## Where things are kept

| What | Where |
|------|-------|
| Settings, résumé, profiles, applied-job history | `%APPDATA%\jobscan-app` (Windows), `~/Library/Application Support/jobscan-app` (macOS) |
| Job database | `jobscan/jobs.db` |
| Per-application records, the app's Chrome profile, one-time-code (OTP) secrets | `jobscan/.job-automator/` |

All of these stay on your machine and are ignored by git. To try a separate setup without touching your profile and history, give the app its own data folder:

```powershell
# Windows (PowerShell)
$env:JOBSCAN_USER_DATA_DIR = "C:\jobscan-test"
npm run dev
```

```bash
# macOS / Linux
JOBSCAN_USER_DATA_DIR=~/jobscan-test npm run dev
```

**One-time codes** sent by email: set an IMAP account with an app password in Settings (simplest), or use Gmail OAuth with `jobscan/setup_gmail_oauth.py`.

## Repository layout

- `jobscan/` — the Go CLI (`fetch`, `search`, the job database, the apply queue) and the Python form filler (`job_application_automator/`)
- `jobscan-app/` — the Electron + React desktop app

## Tests

```bash
cd jobscan-app
npm run test:unit      # typecheck + unit tests
npm run test:e2e       # builds, then drives the app with Playwright (in its own Electron profile)

cd ../jobscan
go test ./...
# Python tests: pytest, plus the headless browser some of them launch (the app itself uses your Chrome)
.venv/bin/python -m pip install pytest
.venv/bin/python -m playwright install chromium-headless-shell
.venv/bin/python -m pytest tests
```

On Windows the environment's Python is `.venv\Scripts\python`:

```powershell
cd ..\jobscan
go test ./...
.venv\Scripts\python -m pip install pytest
.venv\Scripts\python -m playwright install chromium-headless-shell
.venv\Scripts\python -m pytest tests
```

A few tests skip on a fresh clone: they read local data (`jobscan/.job-automator/`, `jobscan/jobs.db`) that only exists after you have used the app.

## Status

- Developed on Windows. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) builds and tests on Windows and macOS on every push; the macOS end-to-end run is informational until it has passed once. Reports from Mac users are welcome.
- `npm run dist` (packaged installers) does not bundle the CLI and Python correctly yet; use `npm run dev`.

## Environment variables

| Variable | Effect |
|----------|--------|
| `JOBSCAN_USER_DATA_DIR` | keep the app's settings and data in this folder instead of the usual one |
| `JOB_AUTOMATOR_SUBMIT=0` | fill forms without ever submitting them |
| `JOB_AUTOMATOR_CHROME_PATH` | the Chrome executable to use |
| `JOBSCAN_SKIP_SETUP=1` | skip `scripts/setup.mjs` (you build the CLI and manage Python yourself) |

Set a variable in the terminal you start the app from, then run `npm run dev` in that same terminal:

| Shell | Example |
|-------|---------|
| Windows PowerShell | `$env:JOB_AUTOMATOR_SUBMIT = "0"` |
| Windows Command Prompt | `set "JOB_AUTOMATOR_SUBMIT=0"` |
| macOS / Linux | `export JOB_AUTOMATOR_SUBMIT=0`, or for one command only: `JOB_AUTOMATOR_SUBMIT=0 npm run dev` |

A variable set this way lasts until that terminal is closed. To clear it sooner: `Remove-Item Env:JOB_AUTOMATOR_SUBMIT` (PowerShell), `set JOB_AUTOMATOR_SUBMIT=` (Command Prompt), `unset JOB_AUTOMATOR_SUBMIT` (macOS / Linux).

## License

MIT — see [LICENSE](LICENSE).
