/**
 * Where app events go besides the window: to the harness's notices, when a
 * Claude Code session is allowed to drive JobScan. A no-op otherwise.
 *
 * Called at the top of every path that sends to the window (pipeline's
 * send(), the loop's status emit, safeSendError), so it fires even with no
 * window open. The harness turns events into numbers and fixed labels
 * (notices.ts); this module only forwards.
 */
type Sink = (channel: string, payload: unknown) => void

let sink: Sink | null = null

export function setNoticeSink(fn: Sink | null): void {
  sink = fn
}

export function noticeEvent(channel: string, payload: unknown): void {
  if (!sink) return
  try { sink(channel, payload) } catch { /* a notice never breaks the app */ }
}
