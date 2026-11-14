# Recovery replay corpus

Frozen job-application pages, one directory per failed fill, used to measure how
accurately the AI recovery agent identifies the broken controls — offline,
repeatably, without submitting real applications.

This directory starts empty. Cases accumulate as recoveries happen: since
`agent_recovery` began writing `recovery_page.html` at handoff time, every
recovery leaves a replayable capture behind in its job directory.

```bash
# harvest whatever captures exist into this directory
python -m job_application_automator.recovery_replay build

# check whether a frozen page's controls still respond (React pages often do not)
python -m job_application_automator.recovery_replay run --probe --all

# replay and grade
python -m job_application_automator.recovery_replay run --all
```

Each case holds:

| file | what it is |
|------|-----------|
| `recovery_page.html` | the page exactly as the filler left it |
| `recovery_context.json` | what the agent was shown |
| `recovery_focus.json` | the dossier it was handed |
| `case.json` | ground truth — the field ids the filler recorded as broken |
| `replay_result.json` | written by `run`: grade + token/tool cost |

**What this measures.** Field-id recall: of the controls the filler recorded as
broken, how many did the agent name in `fixed[]` / `unfixable[]`. Live A/B cannot
answer this — 71% → 85% at 80% power needs ~150 runs per arm and the entire
recorded history is ~190 recoveries — so the live submit rate stays a
non-regression guardrail and accuracy is measured here.

**What it does not measure.** A frozen page has no JS bundle, so a React control
may not respond to a click. `run --probe` records `drivable` per case; grade
*repair* only on the drivable ones, and read the rest as a diagnosis benchmark.
