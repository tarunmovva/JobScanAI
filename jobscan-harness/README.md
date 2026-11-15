# jobscan: a Claude Code and Codex plugin for JobScan AI

Lets a Claude Code or Codex session drive the JobScan AI desktop app: check where it is, start its safe steps, pass on your requests ("find me remote Rust roles"), and hear what happens. JobScan still does all of its own AI work (searches, ratings, answers) with the engine you picked in JobScan. The session only drives and watches.

It has three parts:

- **The `jobscan` skill** (`skills/jobscan/SKILL.md`): what you start it with. In Claude Code it is `/jobscan:jobscan`; in Codex, `$jobscan:jobscan`.
- **The MCP server** (`server/mcp.mjs`) with four tools: `jobscan_status`, `jobscan_action`, `jobscan_note` and `jobscan_wait`. Claude Code starts it from `.mcp.json` (as `harness`), Codex from `.codex-mcp.json` (as `jobscan`).
- **The `jobscan-feed` monitor** (`monitors/monitors.json`, `server/feed.mjs`), Claude Code only. It starts the first time you run `/jobscan:jobscan` and sends the session one short line per batch of notices. Codex has no monitors, so a Codex session follows progress with `jobscan_wait`.

It needs Node.js 18 or later on your `PATH`. There is nothing to `npm install`.

## Install

The repository is both a Claude Code marketplace (`.claude-plugin/marketplace.json`) and a Codex marketplace (`.agents/plugins/marketplace.json`), each named `jobscan`.

### Claude Code

Install it at user scope (the default). Claude Code doesn't start monitors for a plugin installed at project scope, so the feed wouldn't run.

```bash
claude plugin install jobscan --marketplace tarunmovva/JobScanAI
```

From a local clone (the folder that holds `.claude-plugin/`):

```bash
claude plugin install jobscan --marketplace /path/to/JobScanAI
```

To try it for one session without installing:

```bash
claude --plugin-dir /path/to/JobScanAI/jobscan-harness
```

### Codex

```bash
codex plugin marketplace add tarunmovva/JobScanAI
codex plugin add jobscan@jobscan
```

From a local clone, give its folder instead: `codex plugin marketplace add /path/to/JobScanAI`. Codex copies the plugin when you add it; after you update the clone, run `codex plugin add jobscan@jobscan` again.

## Turn it on in JobScan

In JobScan, open **Settings** and turn on **Let Claude Code or Codex drive JobScan**. JobScan then serves a local endpoint on 127.0.0.1 with a new token each launch, and writes `harness.json` to its data folder, where the plugin finds it:

- Windows: `%APPDATA%\jobscan-app` or `%APPDATA%\JobScan AI`
- macOS: `~/Library/Application Support/jobscan-app` or `~/Library/Application Support/JobScan AI`
- Linux: `$XDG_CONFIG_HOME` (or `~/.config`) followed by `/jobscan-app` or `/JobScan AI`

If you run JobScan with `JOBSCAN_USER_DATA_DIR`, start Claude Code or Codex with `JOBSCAN_HARNESS_FILE` set to the `harness.json` in that folder. Codex passes that variable on to the plugin's server (it is listed in `.codex-mcp.json`).

## Start

- **Claude Code:** run `/jobscan:jobscan`. You can add a request after it, as in `/jobscan:jobscan find me remote Rust roles`.
- **Codex:** type `$jobscan:jobscan` (or pick **jobscan:jobscan** from the `$` list), followed by what you want, as in `$jobscan:jobscan find me remote Rust roles`.

The chip in JobScan's header says **Agent connected** while a session has been in touch within the last minute, and **Waiting for your agent** otherwise.

## Skip the permission prompts

**Claude Code:** add this allow rule to your user settings (`~/.claude/settings.json`) so the four tools run without asking each time:

```json
{
  "permissions": {
    "allow": ["mcp__plugin_jobscan_harness__*"]
  }
}
```

**Codex:** the tools carry MCP annotations (`jobscan_status` and `jobscan_wait` are read-only, and none is destructive), and Codex weighs those and your own approval settings when it decides whether to ask. `codex exec` runs all four without asking.

## Remove it

```bash
claude plugin uninstall jobscan@jobscan
claude plugin marketplace remove jobscan

codex plugin remove jobscan@jobscan
codex plugin marketplace remove jobscan
```

Both marketplaces are named `jobscan`, whether you added a local clone or `tarunmovva/JobScanAI`. To switch from one to the other, remove the first before adding the second.

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

`jobscan-app/tests/unit/jobscan-harness.test.cjs`, run with `npm run test:unit` from `jobscan-app`. It runs both servers against a real JobScan endpoint and checks the Claude Code and Codex plugin files. When `claude` is installed it runs `claude plugin validate --strict`; when `codex` is installed it installs the plugin into a throwaway `CODEX_HOME` and checks that Codex lists the server and the skill.
