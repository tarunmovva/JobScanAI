/**
 * The built-in engine: Codex, exactly as before the AiEngine seam existed.
 * Every method is the call pipeline.ts and the loop used to make directly.
 */
import store from './state-store'
import {
  runCodexThread, clearCodexClient, codexLoginStatus, checkAuth, readRateLimits, codexInstalled,
} from './codex-client'
import { codexHashModel, type AiEngine } from './ai-engine'

export function createCodexEngine(): AiEngine {
  return {
    id: 'codex',
    complete: call => runCodexThread(call.system, call.user, call.onToken),
    hashModel: () => codexHashModel(k => store.get(k)),
    // No Codex to run is not ready, whatever auth.json says (the loop must not start).
    ready: async () => codexInstalled() && ((await codexLoginStatus()) ?? checkAuth()),
    limits: () => readRateLimits(),
    // Awaited so the next call cannot race a still-alive codex.exe holding
    // the SQLite WAL (see cancelActivePipeline).
    cancelAll: async () => { try { await clearCodexClient() } catch { /* best effort */ } },
    // Turns are not tied to an owner; cancelAll covers them, as before.
    cancelOwner: () => { /* no-op */ },
  }
}
