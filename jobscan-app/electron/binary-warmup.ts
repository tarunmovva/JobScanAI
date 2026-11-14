/**
 * A binary's first start, moved off the app's main thread.
 *
 * Starting a program the antivirus has not seen waits for its scan, and
 * Node's spawn() waits on the calling thread -- the one that draws the
 * window. A freshly downloaded codex.exe froze the window for 11 s on its
 * first start. Measured on a never-seen build: 606 ms blocked cold; 6 ms
 * after the same file had been started once in a worker thread, while the
 * main loop never stalled more than 14 ms.
 *
 * warmBinary starts the file once (`--version`) in a worker. A worker, not
 * a helper process: a packaged app may disable Electron's run-as-node.
 * Never fails, never repeats for the same file and arguments.
 */
import fs from 'fs'
import { Worker } from 'worker_threads'

const WORKER = `
const { spawnSync } = require('child_process')
const { workerData, parentPort } = require('worker_threads')
try {
  spawnSync(workerData.exe, workerData.args, { stdio: 'ignore', windowsHide: true, timeout: workerData.timeoutMs })
} catch (e) { /* it could not start: nothing to warm */ }
parentPort.postMessage('done')
`

const warmed = new Map<string, Promise<void>>()

export function warmBinary(exe: string, args: string[] = ['--version'], timeoutMs = 120_000): Promise<void> {
  let key: string
  try {
    const st = fs.statSync(exe)
    key = `${exe}|${st.mtimeMs}|${st.size}|${args.join('\u0000')}`
  } catch {
    return Promise.resolve()   // nothing there to warm
  }
  const hit = warmed.get(key)
  if (hit) return hit
  const p = new Promise<void>(resolve => {
    let done = false
    let worker: Worker | null = null
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(backstop)
      resolve()
    }
    const backstop = setTimeout(() => {
      finish()
      void worker?.terminate().catch(() => { /* gone */ })
    }, timeoutMs + 2_000)
    backstop.unref?.()
    try {
      worker = new Worker(WORKER, { eval: true, workerData: { exe, args, timeoutMs } })
      worker.unref()
      worker.once('message', finish)
      worker.once('error', finish)
      worker.once('exit', finish)
    } catch {
      finish()
    }
  })
  warmed.set(key, p)
  return p
}
