/**
 * Quitting while a manual run is in progress asks first.
 *
 * The run's fillers used to outlive the app, on Windows and macOS alike:
 * they kept filling -- and could submit -- with no app left to record what
 * they did. Loop rounds were already stopped on quit and still are, without
 * asking. A manual run now asks once: stop the run and quit, or keep the app
 * open. Windows closes the window before the app quits, so both ask through
 * this one guard and only one question is shown.
 */
export interface QuitGuardDeps {
  /** A pipeline run is in progress (finding, rating or applying). */
  runActive: () => boolean
  looping: () => boolean
  /** Show the question. 'stop' = stop the run and quit. */
  ask: () => Promise<'stop' | 'stay'>
}

export interface QuitGuard {
  /** May the app quit now? Asks when a manual run is in progress. */
  mayQuit: () => Promise<boolean>
  /** Quit without asking from now on (a terminal Ctrl+C, or a choice already made). */
  skipAsking: () => void
  readonly confirmed: boolean
}

export function createQuitGuard(deps: QuitGuardDeps): QuitGuard {
  let confirmed = false
  let asking: Promise<boolean> | null = null
  return {
    mayQuit: () => {
      if (confirmed || deps.looping() || !deps.runActive()) return Promise.resolve(true)
      if (!asking) {
        asking = deps.ask()
          .then(answer => {
            if (answer === 'stop') confirmed = true
            return answer === 'stop'
          })
          .catch(() => false)
          .finally(() => { asking = null })
      }
      return asking
    },
    skipAsking: () => { confirmed = true },
    get confirmed() { return confirmed },
  }
}
