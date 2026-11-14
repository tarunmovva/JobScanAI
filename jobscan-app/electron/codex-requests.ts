/**
 * The thread/start and turn/start requests the Codex engine sends
 * (codex-client.ts runTurn), built in one place.
 */

/** The cheapest real turn there is: one word. For checking a Codex by hand. */
export const PROBE_TEXT = 'Reply with the single word OK and nothing else.'

/** A fresh ephemeral, read-only thread per turn: each task's context stays its own. */
export function threadStartParams(o: { cwd: string; model?: string | null }): Record<string, unknown> {
  const params: Record<string, unknown> = {
    cwd: o.cwd,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    personality: 'pragmatic',
    ephemeral: true,
  }
  if (o.model) params['model'] = o.model
  return params
}

export function turnStartParams(o: { threadId: string; text: string; model?: string | null }): Record<string, unknown> {
  const params: Record<string, unknown> = {
    threadId: o.threadId,
    effort: 'medium',
    summary: 'none',
    input: [{ type: 'text', text: o.text }],
  }
  if (o.model) params['model'] = o.model
  return params
}
