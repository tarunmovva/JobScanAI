/**
 * Turn notifications that arrive before their turn is registered.
 *
 * Codex can send a turn's streamed text and its turn/completed in the same
 * chunk as the reply to turn/start. readline hands over every line of a chunk
 * before `await sendRequest('turn/start')` resumes and registers the turn, so
 * those notifications used to be dropped and the call waited out its full
 * 3-minute timeout -- a fast failure such as a usage limit then looked like a
 * timeout. The update probe had the same race (fixed in 87dba38).
 *
 * Kept by turn id for a short while; whatever is never claimed (a turn that
 * already timed out, say) is pruned.
 */
export interface EarlyCompletion {
  status: string
  error: Record<string, unknown> | undefined
}

export class EarlyTurnEvents {
  private readonly texts = new Map<string, { text: string; at: number }>()
  private readonly completions = new Map<string, { completion: EarlyCompletion; at: number }>()

  constructor(
    private readonly keepMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  delta(turnId: string, delta: string): void {
    this.prune()
    const prior = this.texts.get(turnId)
    this.texts.set(turnId, { text: (prior?.text ?? '') + delta, at: prior?.at ?? this.now() })
  }

  completed(turnId: string, completion: EarlyCompletion): void {
    this.prune()
    this.completions.set(turnId, { completion, at: this.now() })
  }

  /** Everything held for this turn, removed from the buffer. */
  take(turnId: string): { text: string; completion: EarlyCompletion | null } {
    const text = this.texts.get(turnId)?.text ?? ''
    const completion = this.completions.get(turnId)?.completion ?? null
    this.texts.delete(turnId)
    this.completions.delete(turnId)
    return { text, completion }
  }

  get size(): number {
    return this.texts.size + this.completions.size
  }

  private prune(): void {
    const cutoff = this.now() - this.keepMs
    for (const [id, entry] of this.texts) if (entry.at < cutoff) this.texts.delete(id)
    for (const [id, entry] of this.completions) if (entry.at < cutoff) this.completions.delete(id)
  }
}
