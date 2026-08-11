import type { Config } from "@/config"
import type { Provider } from "@/provider"
import { ProviderTransform } from "@/provider"
import { Log, Token, Wildcard } from "@/util"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

// Cap the output reservation so models with large output windows (e.g. 32K, 64K)
// don't strangle the usable input window. 20K covers >99.99% of compaction
// summary outputs based on production telemetry of summary token counts.
const OUTPUT_CAP = 20_000

const log = Log.create({ service: "session.overflow" })
const warned = new Set<string>()

export type Window = {
  /** Largest prompt the provider accepts. 0 means unknown — overflow handling is off. */
  hard: number
  /** Working window after the user's `compaction.max_context` budget is applied. */
  effective: number
  /** Token count at which compaction fires (effective minus reserves). */
  usable: number
  source: "model" | "config"
}

function reserves(input: { cfg: Config.Info; model: Provider.Model }) {
  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  // When the provider publishes a dedicated input cap, output tokens are already
  // outside it, so reserving output headroom again would double-count.
  const output = input.model.limit.input ? 0 : Math.min(ProviderTransform.maxOutputTokens(input.model), OUTPUT_CAP)
  return reserved + output
}

function budget(input: { cfg: Config.Info; model: Provider.Model }, hard: number, reserved: number) {
  const configured = input.cfg.compaction?.max_context
  if (configured === undefined) return undefined
  const key = `${input.model.providerID}/${input.model.id}`
  const raw =
    typeof configured === "object"
      ? (Wildcard.all(key, configured as Record<string, number | string>) as number | string | undefined)
      : configured
  if (raw === undefined) return undefined
  if (raw === "") return undefined

  const parsed = Token.parseQuantity(raw, hard)
  // 0 means "no budget for this model" — a config merge cannot delete a key, so this is
  // how the UI restores a model to its own window. Not a misconfiguration, so no warning.
  if (parsed === 0) return undefined
  if (parsed === undefined || parsed <= reserved) {
    if (!warned.has(`${key}:${raw}`)) {
      warned.add(`${key}:${raw}`)
      log.warn("ignoring compaction.max_context", {
        model: key,
        value: raw,
        reason: parsed === undefined ? "unparseable" : `must exceed ${reserved} reserved tokens`,
      })
    }
    return undefined
  }
  // A budget at or above the provider cap is a no-op — report it as such so the
  // UI keeps attributing the window to the model.
  if (parsed >= hard) return undefined
  return parsed
}

/**
 * Resolve the provider cap, the user's working budget, and the compaction
 * trigger for a model. `usable()` is the trigger; the other fields exist so the
 * TUI and CLI can explain where the number came from.
 */
export function contextWindow(input: { cfg: Config.Info; model: Provider.Model }): Window {
  const hard = input.model.limit.context === 0 ? 0 : input.model.limit.input || input.model.limit.context
  if (hard === 0) return { hard: 0, effective: 0, usable: 0, source: "model" }

  const reserved = reserves(input)
  const configured = budget(input, hard, reserved)
  const effective = configured ?? hard
  return {
    hard,
    effective,
    usable: Math.max(0, effective - reserved),
    source: configured === undefined ? "model" : "config",
  }
}

export function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  return contextWindow(input).usable
}

export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}

export function pressureLevel(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
}): 0 | 1 | 2 | 3 {
  if (input.cfg.compaction?.auto === false) return 0
  return contextPressureLevel(input)
}

export function contextPressureLevel(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
  additionalTokens?: number
}): 0 | 1 | 2 | 3 {
  if (input.model.limit.context === 0) return 0

  const count =
    (input.tokens.total ||
      input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write) +
    (input.additionalTokens ?? 0)
  const limit = usable(input)
  if (limit === 0) return 0

  const ratio = count / limit
  if (ratio < 0.50) return 0
  if (ratio < 0.70) return 1
  if (ratio < 0.85) return 2
  return 3
}
