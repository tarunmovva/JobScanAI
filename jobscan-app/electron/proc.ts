/**
 * Ending child processes — the whole tree, and on a deadline when asked.
 *
 * jobscan.exe spawns python, which spawns codex and playwright-mcp. A plain
 * kill() of the top process orphans the grandchildren, which keep driving the
 * browser — and can submit applications — after a cancel.
 */
import { spawn, ChildProcess } from 'child_process'
import { StringDecoder } from 'string_decoder'

/**
 * Spawn options that keep a child's whole tree killable. On macOS and Linux
 * the child leads its own process group, so killTree can end every process
 * in it: Go does not pass a kill on to the python filler it started, which
 * otherwise kept driving Chrome. Windows needs nothing: taskkill /T walks
 * the tree.
 */
export function treeSpawnOptions(platform: string = process.platform): { detached?: boolean } {
  return platform === 'win32' ? {} : { detached: true }
}

/** Children asked to stop with SIGTERM first, and the grace before SIGKILL. */
const gentle = new WeakMap<object, number>()

/**
 * On macOS/Linux, stop `child` with SIGTERM first and SIGKILL only if it is
 * still running after `graceMs`: for jobscan fetch, which on SIGTERM
 * abandons its rebuild and leaves jobs.db as it was, where a SIGKILL leaves
 * the rebuild file behind. NEVER for a filler -- a grace period would let
 * it click submit. Windows has no SIGTERM to send: taskkill /F, as before.
 */
export function stopGently(child: object, graceMs: number): void {
  gentle.set(child, graceMs)
}

type Killable = Pick<ChildProcess, 'pid' | 'kill'> & Partial<Pick<ChildProcess, 'exitCode' | 'signalCode'>>

export function killTree(
  child: Killable,
  platform: string = process.platform,
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => { process.kill(pid, signal) },
): void {
  try {
    if (platform === 'win32' && child.pid) {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true })
    } else if (child.pid) {
      // The child leads its own group (treeSpawnOptions): end all of it, by
      // force, like taskkill /F. A child spawned without its own group throws.
      const pid = child.pid
      const signalGroup = (sig: NodeJS.Signals): void => {
        try { kill(-pid, sig) } catch { try { child.kill(sig) } catch { /* gone */ } }
      }
      const grace = gentle.get(child)
      if (grace === undefined) {
        signalGroup('SIGKILL')
      } else {
        signalGroup('SIGTERM')
        const stillRunning = (): boolean => child.exitCode == null && child.signalCode == null
        const t = setTimeout(() => { if (stillRunning()) signalGroup('SIGKILL') }, grace)
        t.unref?.()
      }
    } else {
      child.kill()
    }
  } catch { /* best effort */ }
}

/**
 * Kill `child`'s tree if it is still running after `ms`, then call
 * `onTimeout`. Nothing below the app has a timeout — Go waits on a filler
 * forever — so this is what keeps one hung filler from stalling a loop round.
 *
 * Returns a disarm function; the child exiting on its own disarms it too.
 */
export function armTimeout(child: ChildProcess, ms: number, onTimeout: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null
    killTree(child)
    onTimeout()
  }, ms)
  const disarm = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  child.once('exit', disarm)
  return disarm
}

export interface ChildResult {
  stdout: string
  stderr: string
  /** -2 when the deadline ran out. */
  exitCode: number
  timedOut: boolean
}

/** After a deadline kill, how long to wait for the pipes to close before giving up on them. */
const DEFAULT_GRACE_MS = 30_000

/**
 * Collect a child's output and wait for it to finish, optionally on a
 * deadline.
 *
 * Settles on 'close', not 'exit': the filler writes into Go's stderr, so the
 * pipes close only once the whole tree has died. After a deadline kill that
 * is the proof nothing below can still click submit -- and only then may the
 * caller close the job's tab. If a survivor keeps a pipe open past the grace
 * period, it settles anyway rather than hang the run.
 *
 * Lines reach `onLine` whole, as they complete -- however the output was
 * cut into chunks -- with any trailing CR removed. The last line is handed
 * over when the child exits, even without a newline.
 */
export function collectChild(
  child: ChildProcess,
  opts: { onLine?: (line: string) => void; timeoutMs?: number; graceMs?: number } = {},
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let grace: ReturnType<typeof setTimeout> | null = null
    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      if (grace) clearTimeout(grace)
      disarm()
      // A consumer that throws on the last line must not keep the run waiting.
      try { flush() } catch (e) { console.warn('[proc] the last output line could not be handled:', String(e).slice(0, 160)) }
      resolve({ stdout, stderr, exitCode: timedOut ? -2 : exitCode, timedOut })
    }
    const disarm = opts.timeoutMs && opts.timeoutMs > 0
      ? armTimeout(child, opts.timeoutMs, () => {
        timedOut = true
        grace = setTimeout(() => finish(-2), opts.graceMs ?? DEFAULT_GRACE_MS)
      })
      : (): void => {}

    // A character can be split across chunks: decode across them too.
    const outText = new StringDecoder('utf8')
    const errText = new StringDecoder('utf8')
    let partial = ''
    const emitLines = (text: string, last: boolean): void => {
      if (!opts.onLine) return
      const lines = (partial + text).split('\n')
      partial = last ? '' : (lines.pop() ?? '')
      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (line) opts.onLine(line)
      }
    }
    const flush = (): void => {
      const out = outText.end()
      stdout += out
      emitLines(out, true)
      stderr += errText.end()
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      // Reported already: whatever a survivor still prints is not this run's.
      if (settled) return
      const text = outText.write(chunk)
      stdout += text
      emitLines(text, false)
    })
    child.stderr?.on('data', (chunk: Buffer) => { if (!settled) stderr += errText.write(chunk) })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      if (grace) clearTimeout(grace)
      disarm()
      reject(err)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}
