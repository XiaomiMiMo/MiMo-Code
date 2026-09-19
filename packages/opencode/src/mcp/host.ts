import { ConfigMCP } from "../config/mcp"

/** Process-local embedder connections. Never persisted to user configuration. */
export namespace HostMcp {
  let entries: Record<string, ConfigMCP.Info> = {}
  /** Bumps on every non-idempotent set. Remove+restore is a new generation (ABA). */
  let generation = 0

  export function set(input: Record<string, unknown>) {
    const next = Object.fromEntries(Object.entries(input).map(([name, value]) => [name, ConfigMCP.Info.zod.parse(value)]))
    if (JSON.stringify(entries) !== JSON.stringify(next)) {
      generation += 1
      entries = structuredClone(next)
      return
    }
    // Idempotent republish: keep generation and entries.
  }

  export function get(): Record<string, ConfigMCP.Info> {
    return structuredClone(entries)
  }

  export function generationOf(): number {
    return generation
  }

  export function revisionOf(name: string): string | undefined {
    const entry = entries[name]
    if (!entry) return undefined
    return `${generation}:${JSON.stringify(entry)}`
  }
}
