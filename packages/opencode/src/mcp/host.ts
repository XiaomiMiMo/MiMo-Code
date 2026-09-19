import { ConfigMCP } from "../config/mcp"

/** Process-local embedder connections. Never persisted to user configuration. */
export namespace HostMcp {
  let entries: Record<string, ConfigMCP.Info> = {}

  export function set(input: Record<string, unknown>) {
    const next = Object.fromEntries(Object.entries(input).map(([name, value]) => [name, ConfigMCP.Info.zod.parse(value)]))
    entries = structuredClone(next)
  }

  export function get(): Record<string, ConfigMCP.Info> {
    return structuredClone(entries)
  }
}
