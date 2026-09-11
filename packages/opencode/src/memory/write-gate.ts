/**
 * Single read point for the memory write switch.
 *
 * Config field: `memory.disable_write` (negative). This accessor is the ONLY
 * place that double negative is allowed to exist — it exposes a positive
 * predicate so every gate reads as `if (!isMemoryWriteEnabled(cfg)) ...`.
 * Business code must never touch `disable_write` directly: field name, polarity,
 * and default all live in this one function body.
 *
 * The parameter is structural rather than `Config.Info` so the same accessor
 * serves callers holding a generated-SDK config object (the plugin hook reads
 * config over the plugin client, whose type lags the engine schema).
 */
export type MemoryWriteConfig = {
  memory?: {
    disable_write?: boolean
  }
}

/**
 * Whether NEW memory may be written. Reading is never affected by this switch.
 *
 * Default ENABLED — an absent config, an absent `memory` section, an absent
 * field, and an explicit `false` all mean writes proceed, so upgrading without
 * touching config keeps today's behavior.
 *
 * `!== true` rather than `?? false`: only a literal `true` disables, so a
 * malformed non-boolean value degrades to "writes enabled" instead of silently
 * killing memory writes.
 */
export function isMemoryWriteEnabled(cfg: MemoryWriteConfig | undefined): boolean {
  return cfg?.memory?.disable_write !== true
}
