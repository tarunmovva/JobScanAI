import { contextBridge, ipcRenderer } from 'electron'

const ALLOWED_INVOKE = new Set([
  'auth:login', 'auth:logout', 'auth:status',
  'resume:upload', 'resume:browse', 'profile:save', 'profile:get',
  'pipeline:start-query-gen', 'pipeline:add-user-queries', 'pipeline:start-rating',
  'pipeline:start-extract', 'pipeline:start-payload-gen', 'pipeline:reset',
  'pipeline:goto-state',
  'selection:confirm',
  'settings:get', 'settings:save', 'codex:list-models', 'engine:set',
  'codex:update-status', 'codex:check-update',
  'chrome:focus-tab',
  'imap:get-config', 'imap:save-config', 'imap:test-connection',
  'state:get', 'state:get-counts',
  'query_gen:get-state', 'rating:get-state', 'extract:get-state', 'payload:get-state',
  'fetch:check', 'fetch:start', 'fetch:get-state', 'fetch:cancel',
  'shell:open',
  'done:get-summary',
  'applied:get-ids',
  'applied-jobs:get-log', 'applied-jobs:clear', 'applied-jobs:get-details',
  'applied-jobs:open-file',
  'board:get-state',
  // Local profiles (personas)
  'profiles:list', 'profiles:create', 'profiles:switch', 'profiles:rename', 'profiles:delete',
  // Loop mode
  'loop:get-status', 'loop:start', 'loop:stop', 'loop:save-settings',
])

const ALLOWED_EVENTS = new Set([
  'state:change',
  'queryGen:generating', 'queryGen:streaming', 'queryGen:valid', 'queryGen:invalid', 'queryGen:error', 'queryGen:done',
  'queryGen:searched',
  'extract:clear', 'extract:job', 'extract:start',
  'board:seeded',
  'rating:progress', 'rating:done',
  'extract:progress', 'extract:done',
  'payload:progress', 'payload:done',
  'fetch:data', 'fetch:done', 'fetch:progress',
  'error',
  'pipeline:error', 'pipeline:canceled', 'pipeline:idle',
  'loop:status',
])

// Store wrapper→original pairs so off() can remove the exact listener
const listenerMap = new WeakMap<
  (...args: unknown[]) => void,
  (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
>()

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (!ALLOWED_INVOKE.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  on: (channel: string, cb: (...args: unknown[]) => void): void => {
    if (!ALLOWED_EVENTS.has(channel)) return
    const wrapper = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...args)
    listenerMap.set(cb, wrapper)
    ipcRenderer.on(channel, wrapper)
  },

  off: (channel: string, cb: (...args: unknown[]) => void): void => {
    const wrapper = listenerMap.get(cb)
    if (wrapper) {
      ipcRenderer.removeListener(channel, wrapper as never)
      listenerMap.delete(cb)
    }
  },
})
