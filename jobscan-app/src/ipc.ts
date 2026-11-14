import { LOOP_ON_MESSAGE } from '../electron/loop-copy'

// Type augmentation for window.api (set by preload)
declare global {
  interface Window {
    api: {
      invoke: (channel: string, data?: unknown) => Promise<unknown>
      on: (channel: string, cb: (...args: unknown[]) => void) => void
      off: (channel: string, cb: (...args: unknown[]) => void) => void
    }
  }
}

/** Fired when main refused an action because loop mode is on; App shows why. */
export const LOOP_REFUSED_EVENT = 'jobscan:loop-refused'

export const ipc = {
  invoke: async <T = unknown>(channel: string, data?: unknown): Promise<T> => {
    const r = await window.api.invoke(channel, data)
    // Screens ignore results they do not expect, so a refusal would look
    // like a dead button. Say it once, centrally.
    if (r && typeof r === 'object'
      && (r as { ok?: unknown }).ok === false && (r as { error?: unknown }).error === LOOP_ON_MESSAGE) {
      window.dispatchEvent(new CustomEvent(LOOP_REFUSED_EVENT))
    }
    return r as T
  },

  on: (channel: string, cb: (...args: unknown[]) => void): void =>
    window.api.on(channel, cb),

  off: (channel: string, cb: (...args: unknown[]) => void): void =>
    window.api.off(channel, cb),
}
