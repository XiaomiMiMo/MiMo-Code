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
/**
 * Entity set comes only from the authoritative catalog (cache / successful fetch).
 * Snapshot fills missing fields on entities that still exist — it never revives
 * providers or models the upstream catalog has dropped.
 */
function overlayEntities(base: unknown, overlay: unknown): Catalog {
  if (!object(overlay)) return {}
  const snap = object(base) ? base : {}
  const out: Catalog = {}
  for (const [pid, provider] of Object.entries(overlay)) {
    if (!object(provider)) continue
    const snapProvider = object(snap[pid]) ? (snap[pid] as Record<string, unknown>) : {}
    const authModels = object(provider.models) ? (provider.models as Record<string, unknown>) : {}
    const snapModels = object(snapProvider.models) ? (snapProvider.models as Record<string, unknown>) : {}
    const models: Record<string, unknown> = {}
    for (const [mid, model] of Object.entries(authModels)) {
      models[mid] = merge(snapModels[mid], model)
    }
    out[pid] = { ...(merge(snapProvider, provider) as Provider), models: models as Provider["models"] }
  }
  return out
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
  let generation = 0
  let flight: Promise<void> | undefined
  let flightForce = false
  let queuedForce = false
  let timer: ReturnType<typeof setInterval> | undefined
  const listeners = new Set<() => void>()
  const readCache = (file: string) =>
    readFile(file, "utf8")
      .then(JSON.parse)
      .then((value) => validateCatalog(value))
      .catch(() => undefined)
  const snapshot = options
    .snapshot()
    .then(validateCatalog)
    .catch(() => ({}) as Catalog)
  /** Exclusive operator override. Invalid content fails closed — never falls back to public. */
  async function readExplicit(): Promise<Catalog | "invalid" | undefined> {
    if (!options.explicit) return undefined
    try {
      const raw = JSON.parse(await readFile(options.explicit, "utf8"))
      return validateCatalog(raw, true)
    } catch (error) {
      options.onError?.(error)
      return "invalid"
    }
  }
  async function compose(authoritative?: Catalog): Promise<Catalog> {
    // No cache yet: ship-time snapshot is the local entity set.
    if (!authoritative) return structuredClone(await snapshot)
    return overlayEntities(await snapshot, authoritative)
  }
  async function load() {
    if (current) return current
    if (loading) return loading
    const gen = generation
    const promise = (async () => {
      const explicit = await readExplicit()
      let next: Catalog
      if (explicit === "invalid") next = {}
      else if (explicit) next = structuredClone(explicit)
      else next = await compose(await readCache(options.cache))
      // Discard settle after reset(); a newer load owns `current`.
      if (gen === generation) current = next
      return next
    })()
    loading = promise
    try {
      return await promise
    } finally {
      if (loading === promise) loading = undefined
    }
  }
  async function fresh() {
    // A malformed cache is not a freshness signal.
    if (!(await readCache(options.cache))) return false
    return Date.now() - (await stat(options.cache)).mtimeMs < ttl
  }
  async function update(force: boolean) {
    await load()
    // Exclusive override never consults TTL, fetches, or rewrites the shared cache.
    if (options.explicit) {
      await publish()
      return
    }
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
    const gen = generation
    let next: Catalog
    const explicit = await readExplicit()
    if (explicit === "invalid") next = {}
    else if (explicit) next = structuredClone(explicit)
    else next = await compose(cached ?? (await readCache(options.cache)))
    // reset() during await must not let this settle write back.
    if (gen !== generation) return
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
    // Explicit force still runs when auto-fetch is disabled; only background paths are gated.
    if (!force && options.disabled?.()) return Promise.resolve()
    if (flight) {
      // A force request that joins a non-force flight must still cause a fetch afterwards.
      // Joining an already-force flight is coalesced — do not schedule a duplicate update.
      if (force && !flightForce) queuedForce = true
      return flight
    }
    flightForce = force
    queuedForce = false
    flight = (async () => {
      try {
        for (;;) {
          const runForce = flightForce || queuedForce
          flightForce = runForce
          queuedForce = false
          try {
            await (options.lock ? options.lock(() => update(runForce)) : update(runForce))
          } catch (error) {
            options.onError?.(error)
            // A force that joined this flight is still owed after a failed attempt.
            if (!queuedForce) break
            continue
          }
          if (!queuedForce) break
        }
      } finally {
        flight = undefined
        flightForce = false
      }
    })()
    return flight
  }
  function stop() {
    if (timer) clearInterval(timer)
    timer = undefined
  }
  return {
    /** Local-only read. Each caller owns its copy (providers mutate shared entries). */
    async get(): Promise<Catalog> {
      return structuredClone(await load())
    },
    refresh,
    // Preserve the lifecycle owner and subscriptions when legacy callers reset local data.
    reset() {
      generation++
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
