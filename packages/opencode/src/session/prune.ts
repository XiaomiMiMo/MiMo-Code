import { SessionID } from "./schema"
import { Provider } from "../provider"
import { MessageV2 } from "./message-v2"
import { Log } from "../util"
import { Config } from "@/config"
import { Effect, Layer, Context } from "effect"
import { usable } from "./overflow"
import { SessionCheckpoint } from "./checkpoint"
import { ActorRegistry } from "@/actor/registry"
import type { ActorPromptOps } from "@/tool/actor"
import { Flag } from "@/flag/flag"

const log = Log.create({ service: "session.prune" })

// Default safety buffer subtracted from windowSize to derive maxAllowed for
// checkpoint thresholds. Users can override via cfg.checkpoint.reserved.
const CHECKPOINT_RESERVED = 13_000

/**
 * Default checkpoint thresholds by context window size.
 *
 * Schedule (Part 2 density):
 *   < 25K          → []                    (subsystem disabled)
 *   25K ≤ w ≤ 200K → 4 triggers @ 20%      (mid-tier models)
 *   200K < w ≤ 500K → 9 triggers @ 10%     (extended-context models)
 *   w > 500K        → 18 triggers @ 5%     (1M+ window models)
 *
 * Density mirrors cc's intent that writers fire often enough that overflow
 * almost always finds a fresh `checkpoint.md` to rebuild from (avoiding
 * fallback to lossy compaction). cc uses growth+toolcall triggers; we use
 * % of window for a simpler implementation that doesn't require new state.
 * See docs/superpowers/specs/2026-06-03-checkpoint-threshold-density-design.md.
 */
export function defaultThresholdsFor(window: number): readonly string[] {
  if (window < 25_000) return []
  if (window <= 200_000) return ["20%", "40%", "60%", "80%"]
  if (window <= 500_000) {
    return ["10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%"]
  }
  return Array.from({ length: 18 }, (_, i) => `${(i + 1) * 5}%`)
}

/**
 * Parse a checkpoint threshold string into a token count.
 * Supports: "40%" (percent of windowSize), "100K"/"100k" (kilotokens),
 * "1.5M"/"1.5m" (megatokens), or plain number.
 */
export function parseThreshold(s: string, windowSize: number): number {
  const trimmed = s.trim()
  if (trimmed.endsWith("%")) {
    const pct = parseFloat(trimmed.slice(0, -1))
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new Error(`Invalid checkpoint threshold percentage: "${s}" (must be 0 < n <= 100)`)
    }
    return Math.floor((windowSize * pct) / 100)
  }
  const match = trimmed.match(/^(\d+(?:\.\d+)?)([KkMm]?)$/)
  if (!match) throw new Error(`Invalid checkpoint threshold format: "${s}"`)
  let n = parseFloat(match[1])
  if (match[2] === "K" || match[2] === "k") n *= 1_000
  else if (match[2] === "M" || match[2] === "m") n *= 1_000_000
  return Math.floor(n)
}

/**
 * Parse, validate, sort, and deduplicate checkpoint thresholds.
 *
 * - Values ≤ maxAllowed pass through.
 * - The FIRST over-cap value (in user-provided order) is clamped to maxAllowed
 *   and logged INFO.
 * - Later over-cap values are dropped and logged INFO.
 * - Throws only when maxAllowed itself is <= 0 (model context too small to
 *   accommodate the safety buffer — no recovery available).
 */
export function resolveThresholds(raw: readonly string[], windowSize: number, reserved?: number): number[] {
  const effectiveReserved = reserved ?? CHECKPOINT_RESERVED
  const maxAllowed = windowSize - effectiveReserved
  if (maxAllowed <= 0) {
    throw new Error(
      `Model window size (${windowSize}) is too small for checkpoints ` +
        `(need > ${effectiveReserved} reserved tokens)`,
    )
  }

  const parsed = raw.map((s) => ({ raw: s, value: parseThreshold(s, windowSize) }))

  const result: number[] = []
  let cappedAlready = false
  for (const p of parsed) {
    if (p.value <= maxAllowed) {
      result.push(p.value)
      continue
    }
    if (!cappedAlready) {
      log.info(
        `checkpoint threshold "${p.raw}" (${p.value}) exceeds maxAllowed (${maxAllowed}) — clamped to maxAllowed`,
      )
      result.push(maxAllowed)
      cappedAlready = true
      continue
    }
    log.info(
      `checkpoint threshold "${p.raw}" (${p.value}) exceeds maxAllowed (${maxAllowed}) — dropped (already clamped earlier)`,
    )
  }

  // Sort and dedupe. If a sub-cap entry happened to equal maxAllowed, it
  // collapses with the clamped value.
  const values = result.sort((a, b) => a - b)
  const deduped: number[] = []
  for (const v of values) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== v) deduped.push(v)
  }
  return deduped
}

export interface Interface {
  readonly prune: (input: {
    sessionID: SessionID
    model: Provider.Model
    tokens: MessageV2.Assistant["tokens"]
    lastAssistantTime?: number
    promptOps?: ActorPromptOps
  }) => Effect.Effect<void>
  /**
   * Fire background checkpoint writers for every newly-crossed threshold.
   * Call this at the START of each runLoop iteration so thresholds fire
   * mid-turn as tokens grow (not only at turn end).
   */
  readonly fireCheckpoints: (input: {
    sessionID: SessionID
    model: Provider.Model
    tokens: MessageV2.Assistant["tokens"]
    promptOps: ActorPromptOps
    agentID?: string
  }) => Effect.Effect<void>
  /** True when the current tokens have just crossed the max checkpoint threshold. */
  readonly maxThresholdCrossed: (sessionID: SessionID) => Effect.Effect<boolean>
  /** Clear the crossed-threshold state for a session (e.g. after discard+rebuild). */
  readonly resetThresholds: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrune") {}

export const layer: Layer.Layer<
  Service,
  never,
  Config.Service | SessionCheckpoint.Service | ActorRegistry.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const checkpoint = yield* SessionCheckpoint.Service
    const actorReg = yield* ActorRegistry.Service

    // Per-session state: which checkpoint thresholds have already been crossed
    // (and had a checkpoint writer enqueued). Prevents re-firing on the same
    // threshold every turn.
    const crossed = new Map<SessionID, Set<number>>()
    // Per-session signal: the max threshold was just crossed; prompt.ts should
    // trigger discard+rebuild on the next loop iteration.
    const maxCrossed = new Set<SessionID>()

    // Fires a checkpoint write for every threshold newly crossed by the
    // current token count. Exposed publicly so runLoop can call it at each
    // iteration to catch mid-turn threshold crossings (not just turn end).
    const fireCheckpoints = Effect.fn("SessionPrune.fireCheckpoints")(function* (input: {
      sessionID: SessionID
      model: Provider.Model
      tokens: MessageV2.Assistant["tokens"]
      promptOps: ActorPromptOps
      agentID?: string
    }) {
      if (!Flag.MIMOCODE_ENABLE_CHECKPOINT) return
      // Checkpoint serves main/peer only; subagents use per-actor compaction
      // (independent layers — see 2026-05-22-checkpoint-v8-design.md:71), and
      // system-spawned agents (checkpoint-writer/dream/distill) are the writers
      // themselves and must not self-trigger. Both exclusions live in the shared
      // `servesCheckpoint` judgement (keyed on agent TYPE and MODE, kept orthogonal
      // there so a future system agent spawned as mode:"peer" can't slip back in).
      // It also shares the exact judgement with LLM.buildSystemArray's memory gate,
      // so "who owns a checkpoint" and "who is taught about it" can never drift.
      // A subagent shares the parent sessionID, so if it triggered a checkpoint the
      // writer's unfiltered-stream watermark could land on the subagent's messages
      // and the fork would capture the wrong parent system prompt. Unresolved actor
      // (no agentID / unregistered / race) → servesCheckpoint fails open and fires:
      // main and peer must never silently lose checkpoints.
      if (!(yield* actorReg.servesCheckpoint(input.sessionID, input.agentID))) return

      // Lock: skip if a writer is already running for this session.
      // crossed Set is NOT incremented here — when the in-flight writer
      // finishes, the next fireCheckpoints invocation can re-fire previously-
      // skipped thresholds.
      if (yield* checkpoint.isWriterRunning(input.sessionID)) {
        log.info("checkpoint writer running, skipping new threshold trigger", {
          sessionID: input.sessionID,
        })
        return
      }

      const cfg = yield* config.get()
      const windowSize = usable({ cfg, model: input.model })
      if (windowSize === 0) return
      const raw = cfg.checkpoint?.thresholds ?? defaultThresholdsFor(windowSize)

      // resolveThresholds throws on invalid config; we let that propagate so
      // the user sees the error fast at the first overflow check.
      const thresholds = resolveThresholds(raw, windowSize, cfg.checkpoint?.reserved)
      if (thresholds.length === 0) return

      const currentTokens =
        input.tokens.total ||
        input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

      const already = crossed.get(input.sessionID) ?? new Set<number>()
      const maxThreshold = thresholds[thresholds.length - 1]

      for (const t of thresholds) {
        if (currentTokens < t) break // sorted ascending; nothing more to trigger
        if (already.has(t)) continue

        const outcome = yield* checkpoint
          .tryStartCheckpointWriter({
            sessionID: input.sessionID,
            model: { providerID: input.model.providerID, modelID: input.model.id },
            promptOps: input.promptOps,
          })
          .pipe(Effect.catch(() => Effect.succeed<"started" | "queued" | "skipped">("skipped")))

        already.add(t)
        log.info("checkpoint triggered", { threshold: t, currentTokens })

        if (t === maxThreshold) maxCrossed.add(input.sessionID)
      }

      crossed.set(input.sessionID, already)
    })

    // RL trajectories are append-only: later turns must never rewrite tool
    // outputs, reasoning, or media from earlier turns. Checkpoint firing remains
    // separate and is controlled by its own opt-in flag.
    const prune = Effect.fn("SessionPrune.prune")(function* (input: {
      sessionID: SessionID
      model: Provider.Model
      tokens: MessageV2.Assistant["tokens"]
      lastAssistantTime?: number
      promptOps?: ActorPromptOps
    }) {
      void input
      return
    })

    const maxThresholdCrossed = Effect.fn("SessionPrune.maxThresholdCrossed")(function* (
      sessionID: SessionID,
    ) {
      if (!Flag.MIMOCODE_ENABLE_CHECKPOINT) return false
      return maxCrossed.has(sessionID)
    })

    const resetThresholds = Effect.fn("SessionPrune.resetThresholds")(function* (sessionID: SessionID) {
      crossed.delete(sessionID)
      maxCrossed.delete(sessionID)
    })

    return Service.of({ prune, fireCheckpoints, maxThresholdCrossed, resetThresholds })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(SessionCheckpoint.defaultLayer),
    Layer.provide(ActorRegistry.defaultLayer),
  ),
)

export * as SessionPrune from "./prune"
