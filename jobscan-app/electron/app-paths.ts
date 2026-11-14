/**
 * Where the app finds the jobscan CLI, the Python automator, its home and
 * Python itself -- for whoever cloned the repo, wherever they put it.
 *
 * The defaults used to be one fixed checkout path
 * (F:\asbylevergreenhouse\jobscan\jobscan.exe). Any other clone, and every
 * Mac, started with paths that did not exist. They now come from this
 * checkout: the first directory above the running code that holds
 * jobscan/go.mod. Pure, with the platform passed in, so both platforms are
 * tested on either.
 */
import path from 'path'

export interface AppPaths {
  jobscanExePath: string
  pythonDir: string
  jobAutomatorHome: string
}

export const PATH_KEYS = ['jobscanExePath', 'pythonDir', 'jobAutomatorHome'] as const
export type PathKey = typeof PATH_KEYS[number]

type Exists = (p: string) => boolean

const pathFor = (platform: string): typeof path.posix => (platform === 'win32' ? path.win32 : path.posix)

/** The checkout this code runs from: the first directory up holding jobscan/go.mod. */
export function findRepoRoot(platform: string, startDir: string, exists: Exists): string | null {
  const P = pathFor(platform)
  let dir = P.resolve(startDir)
  for (;;) {
    if (exists(P.join(dir, 'jobscan', 'go.mod'))) return dir
    const up = P.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/**
 * The paths for this checkout. Outside one (a packaged app) they fall back
 * to ~/jobscan -- the packaged layout is not wired yet.
 */
export function defaultPaths(o: { platform: string; startDir: string; exists: Exists; homedir: string }): AppPaths {
  const P = pathFor(o.platform)
  const repo = findRepoRoot(o.platform, o.startDir, o.exists)
  const pythonDir = repo ? P.join(repo, 'jobscan') : P.join(o.homedir, 'jobscan')
  return {
    jobscanExePath: P.join(pythonDir, o.platform === 'win32' ? 'jobscan.exe' : 'jobscan'),
    pythonDir,
    jobAutomatorHome: P.join(pythonDir, '.job-automator'),
  }
}

/**
 * The Python to run the automator with: the checkout's venv once
 * `npm run setup` finished it (its packages installed: setup.mjs writes the
 * stamp last), else the platform's usual command -- a Mac has `python3` and
 * no `python`. A half-made venv would fail every fill on `import playwright`.
 */
export function resolvePython(platform: string, pythonDir: string, exists: Exists): string {
  const P = pathFor(platform)
  const venv = platform === 'win32'
    ? P.join(pythonDir, '.venv', 'Scripts', 'python.exe')
    : P.join(pythonDir, '.venv', 'bin', 'python3')
  if (exists(venv) && exists(P.join(pythonDir, '.venv', '.jobscan-requirements.sha256'))) return venv
  return platform === 'win32' ? 'python' : 'python3'
}

/** Built-in defaults earlier builds wrote into config.json. */
export function formerDefaults(platform: string, homedir: string): string[] {
  const P = pathFor(platform)
  // path.join('F:', ...) on a Mac made these relative paths.
  const fDrive = P.join('F:', 'asbylevergreenhouse', 'jobscan')
  return [
    P.join(fDrive, platform === 'win32' ? 'jobscan.exe' : 'jobscan'),
    fDrive,
    P.join(fDrive, '.job-automator'),
    ...(platform === 'win32' ? [] : [P.join(homedir, 'jobscan', 'jobscan')]),
  ]
}

/**
 * Which stored paths to replace with this checkout's defaults.
 *
 * A stored path is replaced only when it is missing on this machine, it
 * was never your choice (an old built-in default, or a default this app
 * filled in itself, remembered in `auto`), AND the new default exists -- so
 * a moved checkout is followed. A path you set in Settings is never
 * touched, even when it is missing, and nothing is pointed at a directory
 * that is not there: jobAutomatorHome holds the OTP and IMAP secrets, and
 * an unplugged drive must not move them somewhere empty.
 */
export function planPathFixes(o: {
  stored: Partial<Record<PathKey, unknown>>
  auto: Partial<Record<PathKey, string>>
  defaults: AppPaths
  former: string[]
  exists: Exists
}): { set: Partial<AppPaths>; auto: Partial<AppPaths> } {
  const set: Partial<AppPaths> = {}
  const auto: Partial<AppPaths> = { ...(o.auto ?? {}) }
  for (const key of PATH_KEYS) {
    const stored = typeof o.stored?.[key] === 'string' ? String(o.stored[key]) : ''
    const def = o.defaults[key]
    if (stored === def) { auto[key] = def; continue }
    const notYours = stored === '' || o.former.includes(stored) || auto[key] === stored
    if (notYours && (stored === '' || !o.exists(stored)) && o.exists(def)) {
      set[key] = def
      auto[key] = def
    }
  }
  return { set, auto }
}
