import { ConfigMCP } from "../config/mcp"

/** Process-local embedder connections. Never persisted to user configuration. */
export namespace HostMcp {
  let entries: Record<string, ConfigMCP.Info> = {}
  /** Per-name lifecycle counter. Unchanged content keeps the same revision; remove bumps; restore is a new generation. */
  const nameGen = new Map<string, number>()
  let nextGen = 0

  export function set(input: Record<string, unknown>) {
    const next = Object.fromEntries(Object.entries(input).map(([name, value]) => [name, ConfigMCP.Info.zod.parse(value)]))
    if (JSON.stringify(entries) === JSON.stringify(next)) return
    for (const name of new Set([...Object.keys(entries), ...Object.keys(next)])) {
      const prev = JSON.stringify(entries[name])
      const cur = JSON.stringify(next[name])
      if (prev !== cur) {
        // Content change, removal, or restore after removal → new lifecycle for this name only.
        nameGen.set(name, ++nextGen)
      }
    }
    entries = structuredClone(next)
  }

  export function get(): Record<string, ConfigMCP.Info> {
    return structuredClone(entries)
  }

  /**
   * Lifecycle identity for a host-owned name.
   * Idempotent republish of the same content keeps the same revision.
   * Remove (or content change) advances the counter; restore after remove is a new revision even if content matches.
   */
  export function revisionOf(name: string): string | undefined {
    const entry = entries[name]
    if (!entry) return undefined
    const gen = nameGen.get(name) ?? 0
    return `${gen}:${JSON.stringify(entry)}`
  }
}
