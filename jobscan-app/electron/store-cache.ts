/**
 * Keep electron-store from re-reading its whole file on every access.
 *
 * conf (under electron-store) has no in-memory copy: every store.get reads
 * config.json and JSON-parses ALL of it, and every set does that and then
 * re-serializes and rewrites all of it -- synchronously, on the main process,
 * which is also the thread that drives the window. The file has grown to
 * 17.5 MB (profile snapshots, the rated pool, the candidate pool), so one get
 * costs ~85 ms. Measured after clicking Apply: 3.7 s of the next 4.2 s were
 * spent in store reads and writes, and an idle app spent ~90% of the time in a
 * 22-read burst every two seconds. The window cannot present frames while the
 * main thread is held, so the Rating screen faded out and the board never
 * appeared -- "just the background".
 *
 * The parsed file is kept in memory and reused while the file is unchanged on
 * disk (mtime + size: one stat, ~0.05 ms). Something else editing the file --
 * the e2e specs do, between reloads -- is still picked up on the next access.
 *
 * Semantics the rest of the app relied on are kept:
 * - get() hands out a COPY of just that value, as a fresh parse did, so a
 *   caller that mutates what it got can never change the stored state behind
 *   the store's back.
 * - set() copies what it is given, for the same reason in the other direction.
 * - Writes stay synchronous and immediate. Durability matters here: applied
 *   job ids are written the moment a submit is detected, so a crash right
 *   after cannot lead to applying to the same job twice.
 */
import fs from 'fs'

interface ConfLike {
  path: string
  get: (...args: never[]) => unknown
  set: (...args: never[]) => unknown
}

function storeAccessor(obj: object): { get: () => unknown; set: (v: unknown) => void } {
  for (let p = Object.getPrototypeOf(obj); p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, 'store')
    if (d?.get && d?.set) return { get: d.get, set: d.set }
  }
  throw new Error('store-cache: no store accessor on this object')
}

const copy = <T>(v: T): T => (v !== null && typeof v === 'object' ? structuredClone(v) : v)

export function attachReadCache<S extends ConfLike>(s: S): S {
  const file = storeAccessor(s)
  let cache: unknown
  let stamp = ''
  const stampNow = (): string => {
    try {
      const st = fs.statSync(s.path)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return ''  // missing file: never trust the cache, let conf handle it
    }
  }

  Object.defineProperty(s, 'store', {
    configurable: true,
    enumerable: false,
    get() {
      const now = stampNow()
      if (cache === undefined || now === '' || now !== stamp) {
        cache = file.get.call(s)
        stamp = now
      }
      return cache
    },
    set(value: unknown) {
      file.set.call(s, value)
      cache = value
      stamp = stampNow()
    },
  })

  const rawGet = s.get.bind(s) as (...a: unknown[]) => unknown
  const rawSet = s.set.bind(s) as (...a: unknown[]) => unknown
  ;(s as { get: unknown }).get = (...a: unknown[]) => copy(rawGet(...a))
  ;(s as { set: unknown }).set = (key: unknown, ...rest: unknown[]) =>
    typeof key === 'object' && key !== null ? rawSet(copy(key)) : rawSet(key, ...rest.map(copy))
  return s
}
