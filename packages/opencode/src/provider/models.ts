export * as ModelsDev from "./models"
export { Model, Provider } from "./models-schema"
import { Global } from "../global"
import { Log } from "../util"
import path from "node:path"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { lazy } from "@/util/lazy"
import { Flock } from "@mimo-ai/shared/util/flock"
import { Hash } from "@mimo-ai/shared/util/hash"
import { createCatalog } from "./models-catalog"

const log = Log.create({ service: "models.dev" })
const catalog = lazy(() => {
  const source = Flag.MIMOCODE_MODELS_URL || "https://models.dev"
  const cache = path.join(
    Global.Path.cache,
    source === "https://models.dev" ? "models.json" : `models-${Hash.fast(source)}.json`,
  )
  return createCatalog({
    cache,
    explicit: Flag.MIMOCODE_MODELS_PATH,
    snapshot: async () => {
      // Generated and validated at build time; absent in an unbuilt source checkout.
      // @ts-ignore
      return import("./models-snapshot.js").then((m) => m.snapshot)
    },
    fetch: () =>
      fetch(`${source}/api.json`, {
        headers: { "User-Agent": Installation.USER_AGENT },
        signal: AbortSignal.timeout(10000),
      }),
    disabled: () => Flag.MIMOCODE_DISABLE_MODELS_FETCH || process.argv.includes("--get-yargs-completions"),
    lock: (run) => Flock.withLock(`models-dev:${cache}`, run),
    onError: (error) => log.error("Failed to refresh models.dev", { error }),
  })
})

/**
 * Local-only read. Every caller owns its copy; never waits for HTTP.
 * Entity set comes from the last-good cache (or build-time snapshot when absent);
 * snapshot only fills missing fields — it does not revive dropped providers/models.
 */
export function get() {
  return catalog().get()
}
/** Backward-compatible local data entry point. */
export const Data = Object.assign(get, { reset: () => catalog().reset() })
/**
 * `force` always fetches (even under `MIMOCODE_DISABLE_MODELS_FETCH`).
 * Concurrent non-force flights cannot swallow a later force request.
 */
export function refresh(force = false): Promise<void> {
  return catalog().refresh(force)
}
/**
 * Start best-effort background refresh. Import has no network side effect.
 * Embedders that do not go through `src/index.ts` / TUI worker MUST call this
 * after installing their fetch adapter, or the catalog stays frozen at snapshot∪cache.
 */
export function startRefresh(): () => void {
  return catalog().startRefresh()
}
/** Successful changes only; consumers re-read get() and invalidate instances at a safe turn boundary. */
export function subscribe(listener: () => void): () => void {
  return catalog().subscribe(listener)
}
