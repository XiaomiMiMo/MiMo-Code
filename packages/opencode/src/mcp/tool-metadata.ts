import { Effect } from "effect"
import { MAX_BYTES, type Interface as Truncate } from "../tool/truncate"

// Runtime-only data for exec; JSON serialization and structuredClone omit symbols.
export const STRUCTURED_CONTENT = Symbol("mcp.structuredContent")

/** Keep at most MAX_BYTES of inline MCP metadata, plus file references. */
export const persistToolMetadata = Effect.fn("MCP.persistToolMetadata")(function* (
  metadata: Record<string, unknown>,
  truncate: Truncate,
) {
  let remaining = MAX_BYTES
  const entries = yield* Effect.forEach(Object.entries(metadata), ([key, value]) =>
    Effect.gen(function* () {
      const text = JSON.stringify(value)
      if (text == null) return [key, value] as const
      const bytes = Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(key)) + 2
      if (bytes <= remaining) {
        remaining -= bytes
        return [key, value] as const
      }
      const outputPath = yield* truncate.write(text)
      // Keep private metadata references under _meta so sharing still removes them.
      return key === "_meta" ? ([key, { truncated: true, outputPath }] as const) : ([`${key}Path`, outputPath] as const)
    }),
  )
  return Object.fromEntries(entries)
})
