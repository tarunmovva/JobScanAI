/**
 * Keep the bulk of the store out of config.json.
 *
 * Every store.set rewrites the whole of config.json, synchronously, on the
 * main process -- the thread that draws the window. The job pools are most
 * of a real config: the rated pool and the candidate pool, ~3.3 MB each, and
 * every profile's copy of them. One write took ~180 ms with them and ~13 ms
 * without, and the board writes on every job event, so a run froze the
 * window over and over. Each bulk key now lives in its own file beside
 * config.json (config.<key>.json); store.get/set/delete route them, and
 * nothing else in the app changes.
 *
 * Only data the app can rebuild belongs here: a pool lost costs a search and
 * a rating, nothing more. What nothing can rebuild -- the applied history,
 * including the other profiles' -- stays in config.json, which conf writes
 * atomically.
 *
 * Nothing here may lose data:
 * - A side file records which config.json it belongs to: config.json holds a
 *   generation id (SIDECAR_GEN_KEY), and so does each side file. A
 *   config.json that does not name a file's generation -- reset, replaced,
 *   restored from elsewhere -- never reads it as its own, and the first
 *   write that replaces it keeps it as config.<key>.json.prev.
 * - A file that cannot be read is an error, never an empty value: a value
 *   read as empty is written back as empty. A file that reads but does not
 *   parse is damaged: it is set aside (config.<key>.json.corrupt-<time>),
 *   never deleted, and the key reads as empty.
 * - A write reaches the disk (fsync) before it replaces the old file.
 * - A key found in config.json itself always wins, empty or not: an older
 *   version wrote it there, a side write failed, or the file was edited. It
 *   is copied to its side file, read back and compared, and only then
 *   removed from config.json -- in the same single write that records the
 *   generation. A crash at any point leaves the data in config.json, where
 *   the next start finds it again. The side file it replaces is kept as
 *   config.<key>.json.prev.
 * - The first move keeps a copy of config.json beside it, and never removes it.
 * - If a side file cannot be written, the key stays in config.json.
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { isDeepStrictEqual } from 'util'

export const SIDECAR_GEN_KEY = 'storeSidecarGen'

interface ConfLike {
  path: string
  store: Record<string, unknown>
  get: (...args: never[]) => unknown
  set: (...args: never[]) => unknown
  delete: (...args: never[]) => unknown
}

const copy = <T>(v: T): T => (v !== null && typeof v === 'object' ? structuredClone(v) : v)
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Antivirus and indexers hold a file for a moment on Windows. (Too many open
 *  files is not retried: nothing can close one while this thread waits.) */
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN'])

/** `fn`, retried for ~1 s while the file is held. Any other error, or one that outlasts that, is thrown. */
function retrying<T>(fn: () => T): T {
  for (let i = 0; ; i++) {
    try { return fn() } catch (e) {
      if (i >= 6 || !TRANSIENT.has(String((e as NodeJS.ErrnoException)?.code))) throw e
      sleepSync(40 * (i + 1))
    }
  }
}

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT'

/**
 * Route `opts.keys` (key → default value) to side files. Attach after
 * attachReadCache, and keep these keys out of the store's `defaults`: conf
 * writes defaults into config.json at every start.
 *
 * `uncached` keys are read from disk each time instead of being kept parsed
 * in memory -- for big values read rarely (the other profiles' pools): a
 * large resident heap makes every full garbage collection on the main
 * process longer, and one froze the window for 1.1 s in a live run.
 *
 * `retired` keys (key → default value) were side keys in an earlier build
 * and belong in config.json now. A side file of this config's generation is
 * brought back once and then kept beside as .restored-<time> (or
 * .superseded-<time> when it added nothing). For a record (the profile
 * snapshots: id → snapshot) every entry config.json lacks comes back, and
 * the entries config.json holds -- written since -- stay: a restore that
 * failed at one start, after which the boot wrote the active profile's
 * entry, still brings every other profile back at the next.
 *
 * The store also gains `peek(key)`: the value WITHOUT a copy, for code that
 * only counts or scans it. It must never be changed.
 */
export function attachSidecars<S extends ConfLike>(
  s: S, opts: { keys: Record<string, unknown>; uncached?: string[]; retired?: Record<string, unknown> },
): S {
  const defaults = opts.keys
  const UNCACHED = new Set(opts.uncached ?? [])
  const KEYS = Object.keys(defaults)
  const isBulk = (k: unknown): k is string => typeof k === 'string' && hasOwn(defaults, k)
  const dir = path.dirname(s.path)
  const base = path.basename(s.path, path.extname(s.path))
  const fileFor = (k: string): string => path.join(dir, `${base}.${k}.json`)

  const rawGet = s.get.bind(s) as (...a: unknown[]) => unknown
  const rawSet = s.set.bind(s) as (...a: unknown[]) => unknown
  const rawDelete = s.delete.bind(s) as (...a: unknown[]) => unknown

  // What each side file on disk is known to hold: its stamp and generation,
  // and -- for cached keys -- its parsed value.
  const known = new Map<string, { stamp: string; gen: string; value?: unknown; has: boolean }>()
  // A move that failed is not retried on every access in the same session.
  let moveFailed = false

  /** '' when the file does not exist. Any other failure is thrown. */
  const stampOf = (f: string): string => {
    try {
      const st = retrying(() => fs.statSync(f))
      return `${st.mtimeMs}:${st.size}`
    } catch (e) {
      if (isMissing(e)) return ''
      throw e
    }
  }

  /**
   * The side file of `k` as stored, or null when there is none. A damaged
   * file is set aside and reads as none; a file that cannot be read throws.
   */
  function readFresh(k: string): { gen?: unknown; value?: unknown } | null {
    const f = fileFor(k)
    let text: string
    try {
      text = retrying(() => fs.readFileSync(f, 'utf-8'))
    } catch (e) {
      if (isMissing(e)) return null
      throw e
    }
    try {
      const parsed = JSON.parse(text) as { gen?: unknown; value?: unknown } | null
      if (parsed && typeof parsed === 'object' && typeof parsed.gen === 'string' && hasOwn(parsed, 'value')) return parsed
      throw new Error('not a side file')
    } catch (e) {
      const aside = `${f}.corrupt-${Date.now()}`
      retrying(() => fs.renameSync(f, aside))
      known.delete(k)
      console.error(`[store] ${path.basename(f)} is damaged (${String(e).slice(0, 80)}); kept as ${path.basename(aside)}, read as empty`)
      return null
    }
  }

  /** The side value of `k` for generation `gen`, if that file is this config's. */
  function readSide(k: string, gen: string): { found: boolean; value?: unknown } {
    const stamp = stampOf(fileFor(k))
    if (!stamp) { known.delete(k); return { found: false } }
    const c = known.get(k)
    if (c && c.has && c.stamp === stamp && c.gen === gen) return { found: true, value: c.value }
    const parsed = readFresh(k)
    if (!parsed) return { found: false }
    known.set(k, UNCACHED.has(k)
      ? { stamp, gen: String(parsed.gen), has: false }
      : { stamp, gen: String(parsed.gen), value: parsed.value, has: true })
    if (parsed.gen !== gen) return { found: false }
    return { found: true, value: parsed.value }
  }

  /**
   * Write `value` as `k`'s side file. The file it replaces is kept as .prev
   * when `keepPrev` says so, or when it is not known to be this generation's.
   */
  function writeSide(k: string, value: unknown, gen: string, keepPrev = false): void {
    const f = fileFor(k)
    const tmp = `${f}.${process.pid}.tmp`
    try {
      const fd = retrying(() => fs.openSync(tmp, 'w'))
      try {
        fs.writeFileSync(fd, JSON.stringify({ gen, value }))
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      const stamp = stampOf(f)
      const c = known.get(k)
      if (stamp && (keepPrev || !c || c.stamp !== stamp || c.gen !== gen)) {
        retrying(() => fs.copyFileSync(f, `${f}.prev`))
      }
      retrying(() => fs.renameSync(tmp, f))
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch { /* never written */ }
      throw e
    }
    const stamp = stampOf(f)
    known.set(k, UNCACHED.has(k) ? { stamp, gen, has: false } : { stamp, gen, value: copy(value), has: true })
  }

  function backupOnce(): void {
    const bak = `${s.path}.bak-before-split`
    if (!fs.existsSync(bak)) fs.copyFileSync(s.path, bak)
  }

  /**
   * Make sure config.json names its side files, and move any bulk key it
   * holds itself into its side file. Returns the generation, or '' when
   * there is none yet (the move failed); the data then stays in config.json.
   */
  function ensure(): string {
    const main = s.store
    const marked = typeof main[SIDECAR_GEN_KEY] === 'string' ? String(main[SIDECAR_GEN_KEY]) : ''
    const inline = KEYS.filter(k => hasOwn(main, k))
    if (marked && inline.length === 0) return marked
    if (moveFailed) return marked
    const gen = marked || randomUUID()
    try {
      for (const k of inline) {
        const v = main[k]
        writeSide(k, v, gen, true)
        const back = readFresh(k)
        if (!back || back.gen !== gen || !isDeepStrictEqual(back.value, v)) {
          throw new Error(`${k} did not read back the same from its side file`)
        }
      }
      if (inline.length > 0) backupOnce()
      // The commit: one write records the generation and drops the moved keys.
      const next: Record<string, unknown> = { ...main, [SIDECAR_GEN_KEY]: gen }
      for (const k of inline) delete next[k]
      s.store = next
      return gen
    } catch (e) {
      moveFailed = true
      console.error('[store] keeping the bulk keys in config.json:', String(e).slice(0, 200))
      return marked
    }
  }

  function getBulk(k: string, fallback: unknown[]): unknown {
    const gen = ensure()
    if (hasOwn(s.store, k)) return rawGet(k)            // still in config.json: it wins
    if (gen) {
      const r = readSide(k, gen)
      // A value parsed just now for a key kept out of memory is already a private copy.
      if (r.found) return UNCACHED.has(k) ? r.value : copy(r.value)
    }
    return copy(fallback.length > 0 ? fallback[0] : defaults[k])
  }

  /** The value as stored, not copied. Read-only. */
  function peek(k: unknown): unknown {
    if (typeof k !== 'string') return undefined
    if (!isBulk(k)) return s.store[k]
    const gen = ensure()
    if (hasOwn(s.store, k)) return s.store[k]
    if (gen) {
      const r = readSide(k, gen)
      if (r.found) return r.value
    }
    return defaults[k]
  }

  function setBulk(k: string, value: unknown): void {
    const gen = ensure()
    if (!gen || hasOwn(s.store, k)) { rawSet(k, value); return }
    try {
      writeSide(k, value, gen)
    } catch (e) {
      // config.json wins at every read, and the next start moves it out again.
      console.error(`[store] could not write ${k} beside config.json; keeping it inside:`, String(e).slice(0, 200))
      rawSet(k, value)
    }
  }

  function deleteBulk(k: string): void {
    if (hasOwn(s.store, k)) rawDelete(k)
    if (ensure()) setBulk(k, defaults[k])
  }

  /** Bring a retired side key back into config.json. Never deletes a file. */
  function retire(k: string, def: unknown): void {
    const f = fileFor(k)
    try {
      if (!fs.existsSync(f)) return
      const main = s.store
      const gen = typeof main[SIDECAR_GEN_KEY] === 'string' ? String(main[SIDECAR_GEN_KEY]) : ''
      const side = readFresh(k)
      if (!side || !gen || side.gen !== gen) return     // not this config's: left as it is
      const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
      const inline = hasOwn(main, k) ? main[k] : undefined
      const empty = inline === undefined || isDeepStrictEqual(inline, def)
      const next = isRecord(side.value) && (empty || isRecord(inline))
        ? { ...side.value, ...(isRecord(inline) ? inline : {}) }      // what config.json holds is newer
        : empty ? side.value : inline
      const adds = !isDeepStrictEqual(next, inline)
      if (adds) {
        rawSet(k, next)
        if (!isDeepStrictEqual(s.store[k], next)) throw new Error(`${k} did not read back the same from config.json`)
      }
      retrying(() => fs.renameSync(f, `${f}.${adds ? 'restored' : 'superseded'}-${Date.now()}`))
      console.warn(`[store] ${path.basename(f)}: ${adds ? 'brought back into config.json' : 'config.json already holds all of it'}; the file is kept beside`)
    } catch (e) {
      // Left in place: the next start tries again.
      console.error(`[store] could not bring ${path.basename(f)} back into config.json:`, String(e).slice(0, 200))
    }
  }

  // Temp files of writes a crash cut short.
  try {
    const tmp = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[A-Za-z]+\\.json\\.\\d+\\.tmp$`)
    for (const f of fs.readdirSync(dir)) {
      if (tmp.test(f)) { try { fs.unlinkSync(path.join(dir, f)) } catch { /* held: next start */ } }
    }
  } catch { /* the directory is read again at the next start */ }

  for (const [k, def] of Object.entries(opts.retired ?? {})) retire(k, def)

  ;(s as { get: unknown }).get = (key: unknown, ...rest: unknown[]) =>
    isBulk(key) ? getBulk(key, rest) : rawGet(key, ...rest)

  ;(s as { set: unknown }).set = (key: unknown, ...rest: unknown[]) => {
    if (typeof key === 'object' && key !== null) {
      const plain: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(key as Record<string, unknown>)) {
        if (isBulk(k)) setBulk(k, v)
        else plain[k] = v
      }
      if (Object.keys(plain).length > 0) rawSet(plain)
      return
    }
    if (isBulk(key)) setBulk(key, rest[0])
    else rawSet(key, ...rest)
  }

  ;(s as { peek?: unknown }).peek = peek

  ;(s as { delete: unknown }).delete = (key: unknown) => {
    if (isBulk(key)) deleteBulk(key)
    else rawDelete(key)
  }

  return s
}
