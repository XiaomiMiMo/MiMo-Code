import type { Config } from "@/config"
import { Flag } from "@/flag/flag"
import type { Provider } from "@/provider"
import { ProviderTransform } from "@/provider"
import { Log, Token, Wildcard } from "@/util"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 33_000

// Cap the output reservation so models with large output windows (e.g. 32K, 64K)
// don't strangle the usable input window. 20K covers >99.99% of compaction
// summary outputs based on production telemetry of summary token counts.
const OUTPUT_CAP = 20_000

// Compaction fires when usage reaches a fraction of the working window, leaving
// the remaining headroom for the summary generation. The default 0.9 keeps the
// trigger at a flat 90% of the model's context regardless of window size,
// instead of a fixed token reserve that punishes small windows. Override with
// MIMOCODE_COMPACTION_TRIGGER_RATIO.

const log = Log.create({ service: "session.overflow" })
const warned = new Set<string>()

export type Window = {
  /** Largest prompt the provider accepts. 0 means unknown — overflow handling is off. */
  hard: number
  /** Working window after the user's `compaction.max_context` budget is applied. */
  effective: number
  /** Token count at which compaction fires (a fixed fraction of `effective`). */
  usable: number
  source: "model" | "config"
}

// Output headroom to keep clear of the input budget. Providers that publish no
// dedicated input cap enforce `input + max_tokens <= context`, so the completion
// has to fit inside the same window the prompt does. Where the provider does
// publish one, output tokens are already outside it and reserving again would
// double-count. Capped at OUTPUT_CAP rather than the model's full max_tokens:
// `maxOutputTokens()` is an optimistic request ceiling (128K for anything the
// large-model heuristic matches), and reserving that much would halve the
// working window on a 200K model. The hard guarantee lives in
// `completionBudget()` instead.
function outputReserve(model: Provider.Model) {
  return model.limit.input ? 0 : Math.min(ProviderTransform.maxOutputTokens(model), OUTPUT_CAP)
}

function reserves(input: { cfg: Config.Info; model: Provider.Model }) {
  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  return reserved + outputReserve(input.model)
}

function budget(input: { cfg: Config.Info; model: Provider.Model }, hard: number, reserved: number) {
  const configured = input.cfg.compaction?.max_context ?? Flag.MIMOCODE_COMPACTION_MAX_CONTEXT
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
  // `input + max_tokens <= context` means the trigger has to stop short of the
  // whole window, or the reply has nowhere to go (#2356). Never reserve more
  // than half the window, so a tiny context still gets a workable trigger.
  const completion = Math.min(outputReserve(input.model), Math.floor(effective * 0.5))
  return {
    hard,
    effective,
    usable: Math.min(Math.floor(effective * Flag.MIMOCODE_COMPACTION_TRIGGER_RATIO), effective - completion),
    source: configured === undefined ? "model" : "config",
  }
}

export function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  return contextWindow(input).usable
}

// `Token.estimate` counts chars/4, so the prompt that reaches the wire can land
// a little above what we measured. Hold this much back so that error does not
// turn into a rejected request at the boundary.
const COMPLETION_MARGIN = 1_024

// Below this there is no reply worth asking for: the prompt itself is over
// budget and overflow handling, not `max_tokens`, owns the recovery.
const COMPLETION_FLOOR = 1_024

/**
 * Trim a request's `max_tokens` to what the prompt leaves inside the provider's
 * context window.
 *
 * Providers without a dedicated `limit.input` reject the whole request when
 * `input + max_tokens` exceeds the window, and the compaction trigger is only
 * sampled between turns — so the trigger alone cannot guarantee the next
 * request fits. This can, because it reads the prompt actually being sent.
 *
 * `undefined` passes through so plugins that drop `max_tokens` keep that.
 */
export function completionBudget(input: {
  model: Provider.Model
  requested: number | undefined
  /** Deferred so the estimate is only paid for on the models that need it. */
  inputTokens: () => number
}) {
  if (input.requested === undefined) return input.requested
  if (input.model.limit.input) return input.requested
  if (input.model.limit.context === 0) return input.requested
  const remaining = input.model.limit.context - input.inputTokens() - COMPLETION_MARGIN
  if (remaining >= input.requested) return input.requested
  return Math.max(remaining, COMPLETION_FLOOR)
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
