import { readFile, mkdir, rename, unlink, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { validateCatalog, type Provider } from "./models-schema"
export { validateCatalog } from "./models-schema"

type Catalog = Record<string, Provider>
const ttl = 5 * 60 * 1000

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
/** Same-source field overlay: missing fields inherit, arrays and false/zero replace. */
function merge(base: unknown, overlay: unknown): unknown {
  if (!object(base) || !object(overlay)) return structuredClone(overlay)
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(overlay)])].map((key) => [
      key,
      overlay[key] === undefined ? structuredClone(base[key]) : merge(base[key], overlay[key]),
    ]),
  )
}

export function createCatalog(options: {
  cache: string
  explicit?: string
  snapshot: () => Promise<unknown>
  fetch: () => Promise<Response>
  disabled?: () => boolean
  lock?: (run: () => Promise<void>) => Promise<void>
  onError?: (error: unknown) => void
}) {
  let current: Catalog | undefined
  let loading: Promise<Catalog> | undefined
  let flight: Promise<void> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const listeners = new Set<() => void>()
  const read = (file: string, allowEmpty = false) =>
    readFile(file, "utf8")
      .then(JSON.parse)
      .then((value) => validateCatalog(value, allowEmpty))
      .catch(() => undefined)
  const snapshot = options
    .snapshot()
    .then(validateCatalog)
    .catch(() => ({}) as Catalog)
  async function load() {
    if (current) return current
    if (loading) return loading
    loading = (async () => {
      // Explicit operator catalogs remain an exclusive override, not a source overlay.
      const explicit = options.explicit ? await read(options.explicit, true) : undefined
      if (explicit) return (current = explicit)
      const cached = await read(options.cache)
      return (current = merge(await snapshot, cached ?? {}) as Catalog)
    })()
    return loading
  }
  async function fresh() {
    // A malformed cache is not a freshness signal.
    if (!(await read(options.cache))) return false
    return Date.now() - (await stat(options.cache)).mtimeMs < ttl
  }
  async function update(force: boolean) {
    await load()
    if (!force && (await fresh())) {
      // Another process may have refreshed the shared cache under the lock.
      await publish()
      return
    }
    const response = await options.fetch()
    if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`)
    const next = validateCatalog(await response.json())
    await mkdir(path.dirname(options.cache), { recursive: true })
    const temp = `${options.cache}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify(next), { flag: "wx" })
      await rename(temp, options.cache)
    } finally {
      await unlink(temp).catch(() => {})
    }
    await publish(next)
  }
  async function publish(cached?: Catalog) {
    const explicit = options.explicit ? await read(options.explicit, true) : undefined
    const next = explicit ?? (merge(await snapshot, cached ?? (await read(options.cache)) ?? {}) as Catalog)
    if (isDeepStrictEqual(current, next)) return
    current = next
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        options.onError?.(error)
      }
    }
  }
  function refresh(force = false): Promise<void> {
    if (options.disabled?.()) return Promise.resolve()
    if (flight) return flight
    flight = (options.lock ? options.lock(() => update(force)) : update(force))
      .catch((error) => {
        options.onError?.(error)
      })
      .finally(() => {
        flight = undefined
      })
    return flight
  }
  function stop() {
    if (timer) clearInterval(timer)
    timer = undefined
  }
  return {
    async get(): Promise<Catalog> {
      return structuredClone(await load())
    },
    refresh,
    // Preserve the lifecycle owner and subscriptions when legacy callers reset local data.
    reset() {
      current = undefined
      loading = undefined
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    startRefresh() {
      if (timer || options.disabled?.()) return stop
      void refresh()
      timer = setInterval(
        () => {
          void refresh()
        },
        60 * 60 * 1000,
      )
      timer.unref()
      return stop
    },
  }
}
