# jobscan: a Claude Code plugin for JobScan AI

Lets a Claude Code session drive the JobScan AI desktop app: check where it is, start its safe steps, pass on your requests ("find me remote Rust roles"), and hear what happens. JobScan still does all of its own AI work (searches, ratings, answers) with your Claude Code. The session only drives and watches.

It has three parts:

- **`/jobscan:jobscan`**: the skill you start it with (`skills/jobscan/SKILL.md`).
- **The `harness` MCP server** (`.mcp.json`, `server/mcp.mjs`) with four tools: `jobscan_status`, `jobscan_action`, `jobscan_note` and `jobscan_wait`.
- **The `jobscan-feed` monitor** (`monitors/monitors.json`, `server/feed.mjs`). It starts the first time you run `/jobscan:jobscan` and sends the session one short line per batch of notices.

It needs Node.js 18 or later on your `PATH`. There is nothing to `npm install`.

## Install

Install it at user scope (the default). Claude Code doesn't start monitors for a plugin installed at project scope, so the feed wouldn't run.

From GitHub:

```bash
claude plugin install jobscan --marketplace tarunmovva/JobScanAI
```

From a local clone (the folder that holds `.claude-plugin/marketplace.json`):

```bash
claude plugin install jobscan --marketplace /path/to/JobScanAI
```

To try it for one session without installing:

```bash
claude --plugin-dir /path/to/JobScanAI/jobscan-harness
```

## Turn it on in JobScan

In JobScan, open **Settings** and turn on **Let Claude Code drive JobScan**. JobScan then serves a local endpoint on 127.0.0.1 with a new token each launch, and writes `harness.json` to its data folder, where the plugin finds it:

- Windows: `%APPDATA%\jobscan-app` or `%APPDATA%\JobScan AI`
- macOS: `~/Library/Application Support/jobscan-app` or `~/Library/Application Support/JobScan AI`
- Linux: `$XDG_CONFIG_HOME` (or `~/.config`) followed by `/jobscan-app` or `/JobScan AI`

If you run JobScan with `JOBSCAN_USER_DATA_DIR`, start Claude Code with `JOBSCAN_HARNESS_FILE` set to the `harness.json` in that folder.

## Start

In Claude Code, run `/jobscan:jobscan`. You can add a request after it, as in `/jobscan:jobscan find me remote Rust roles`.

## Skip the permission prompts

Add this allow rule to your user settings (`~/.claude/settings.json`) so the four tools run without asking each time:

```json
{
  "permissions": {
    "allow": ["mcp__plugin_jobscan_harness__*"]
  }
}
```

## What the session can and cannot do

It can:

- read JobScan's status: the screen, what is running, counts, and the auto-apply loop
- start six steps, each only where and when its button works in JobScan's window: `rebuild_db`, `cancel_rebuild`, `find_jobs`, `find_more`, `rate_jobs` and `stop_loop`
- leave short notes that you see in JobScan's window
- hear what JobScan does: steps, progress, AI calls, and your clicks in the window

It cannot apply, choose or confirm jobs, start the loop, change settings, reset, or open files or links. Those stay in JobScan's window. When you click something there, the session hears which button it was and follows your lead.

## What the session sees

Numbers and fixed labels only. Job titles, companies, links, descriptions, model replies and error text never reach the session, so a job posting can't talk to it. JobScan sends nothing else, and the plugin checks every reply again and drops anything that isn't a number, a true/false value or a short label.

## Tests

`jobscan-app/tests/unit/jobscan-harness.test.cjs`, run with `npm run test:unit` from `jobscan-app`. It runs both servers against a real JobScan endpoint, and runs `claude plugin validate --strict` when `claude` is installed.
