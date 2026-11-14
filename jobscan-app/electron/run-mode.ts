/**
 * Whether the current run belongs to loop mode, and its per-job hooks.
 *
 * No imports on purpose: cli-runner reads the flag to mark the CLI
 * environment, and pipeline reads the hooks, without either importing the
 * loop itself.
 *
 * Unattended: nobody is at the computer, so the Python fillers close every
 * tab (JOB_AUTOMATOR_UNATTENDED=1). The hooks let the loop skip jobs on a
 * paused platform, count each filler start, and classify each result. With
 * no loop running there are no hooks, and the agent pool runs exactly as
 * before.
 */

export interface HookJob {
  platform: string
  job_id: string
  title?: string
  company?: string
  apply_url?: string
}

export interface HookResult extends HookJob {
  submitted: boolean
  status: string
  detail: string
  timedOut: boolean
}

/** How the board and the record show a result the loop handled. */
export interface HookView {
  asSkipped: boolean
  message?: string
}

export interface RunHooks {
  /**
   * Fill this job, or skip it? Asked after the claim and again just before
   * the filler starts, so it must only look, never change anything.
   */
  beforeFill(job: HookJob): { skip: false } | { skip: true; reason: string; notPicked?: true }
  /** The filler is starting. Called once per job, only if it really starts. */
  onFillStart(job: HookJob): void
  /**
   * The job's result -- for every job that got an onFillStart, and for jobs
   * whose answers failed before it (a Codex limit shows up there first).
   * `timedOut` is a fill cut off by its deadline or by Stop now.
   */
  onResult(r: HookResult): HookView
}

let unattended = false
let hooks: RunHooks | null = null

export function setUnattended(on: boolean): void {
  unattended = on
}

export function isUnattended(): boolean {
  return unattended
}

/** Environment the CLI gets during a loop round; empty otherwise. */
export function unattendedEnv(): Record<string, string> {
  return unattended ? { JOB_AUTOMATOR_UNATTENDED: '1' } : {}
}

export function setRunHooks(h: RunHooks | null): void {
  hooks = h
}

export function getRunHooks(): RunHooks | null {
  return hooks
}
