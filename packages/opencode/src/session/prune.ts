import * as Session from "./session"
import { SessionID } from "./schema"
import { Provider } from "../provider"
import { MessageV2 } from "./message-v2"
import { Token } from "../util"
import { Log } from "../util"
import { Config } from "@/config"
import { Flag } from "@/flag/flag"
import { NotFoundError } from "@/storage"
import { Effect, Layer, Context } from "effect"
import { pressureLevel, usable } from "./overflow"
import { SessionCheckpoint } from "./checkpoint"
import { ActorRegistry } from "@/actor/registry"
import type { ActorPromptOps } from "@/tool/actor"

const log = Log.create({ service: "session.prune" })

const PRUNE_MINIMUM = 20_000
const PRUNE_PROTECT = 40_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const SOFT_TRIM_THRESHOLD = 4096
const SOFT_TRIM_KEEP_HEAD = 1536
const SOFT_TRIM_KEEP_TAIL = 1536
const DEFAULT_CACHE_TTL = 300_000
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

function isCacheCold(model?: Provider.Model, lastAssistantTime?: number): boolean {
  if (!model) return true
  const ttl = model.cacheTTL ?? DEFAULT_CACHE_TTL
  if (!lastAssistantTime) return true
  return Date.now() - lastAssistantTime > ttl
}

/**
 * Parse a checkpoint threshold string into a token count.
 * Supports: "40%" (percent of windowSize), "100K"/"100k" (kilotokens),
 * "1.5M"/"1.5m" (megatokens), or plain number.
 */
export function parseThreshold(s: string, windowSize: number): number {
  const value = Token.parseQuantity(s, windowSize)
  if (value !== undefined) return value
  if (s.trim().endsWith("%")) {
    throw new Error(`Invalid checkpoint threshold percentage: "${s}" (must be 0 < n <= 100)`)
  }
  throw new Error(`Invalid checkpoint threshold format: "${s}"`)
}

/**
 * The highest token count at which a checkpoint write is still meaningful:
 * the window minus the safety buffer. Thresholds are clamped to it, and it is
 * also the hard ceiling on prune's post-failure recovery gate — past this
 * point there is no room left in the window for another attempt.
 */
export function maxAllowedFor(windowSize: number, reserved?: number): number {
  return windowSize - (reserved ?? CHECKPOINT_RESERVED)
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
  const maxAllowed = maxAllowedFor(windowSize, reserved)
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
  /** Clear the crossed-threshold state for a session (e.g. after discard+rebuild). */
  readonly resetThresholds: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrune") {}

export const layer: Layer.Layer<
  Service,
  never,
  Config.Service | Session.Service | SessionCheckpoint.Service | ActorRegistry.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const checkpoint = yield* SessionCheckpoint.Service
    const actorReg = yield* ActorRegistry.Service

    // Per-session state: which checkpoint thresholds have already been crossed
    // (and had a checkpoint writer enqueued). Prevents re-firing on the same
    // threshold every turn.
    const crossed = new Map<SessionID, Set<number>>()
    // Per-session RECOVERY GATE: the token count at or above which the FINAL
    // threshold is allowed to fire a second time, armed only when that
    // threshold's writer settled with a TRANSIENT failure.
    //
    // This is a position on the token axis, not a tally of failures. It is
    // overwritten rather than accumulated, its value is derived from the
    // threshold ladder and the window, and it is dropped the moment it fires.
    // See the arming site below for why that distinction is the whole design.
    const finalRetryAt = new Map<SessionID, number>()

    const stripNonEssential = Effect.fn("SessionPrune.stripNonEssential")(function* (input: {
      sessionID: SessionID
      model: Provider.Model
      lastAssistantTime?: number
    }) {
      if (!isCacheCold(input.model, input.lastAssistantTime)) return

      const msgs = yield* session
        .messages({ sessionID: input.sessionID, agentID: "main" })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      // Protect last 3 turns.
      let turnCount = 0
      let boundary = msgs.length
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].info.role === "user") turnCount++
        if (turnCount > 3) {
          boundary = i
          break
        }
      }

      let stripped = 0
      for (let i = 0; i < boundary; i++) {
        const msg = msgs[i]
        for (const part of msg.parts) {
          if (part.type === "file" && MessageV2.isMedia(part.mime)) {
            yield* session.updatePart({
              ...part,
              url: "",
              filename: `[stripped: ${part.filename ?? part.mime}]`,
            })
            stripped++
          }
          if (part.type === "reasoning" && msg.info.role === "assistant") {
            yield* session.updatePart({
              ...part,
              text: "",
            })
            stripped++
          }
        }
      }

      if (stripped > 0) {
        log.info("stripped non-essential content", { count: stripped })
      }
    })

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

      // Do not consume crossed thresholds while checkpointing is disabled.
      // If an in-process embedder re-enables the flag, the next invocation must
      // still be able to fire every threshold already crossed by the session.
      if (Flag.MIMOCODE_DISABLE_CHECKPOINT) return

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
      // The ladder's own spacing: the token growth the design already accepts
      // as worth one writer. Used below as the recovery gate's step so a retry
      // can never fire faster than a normal threshold would have.
      const step = thresholds.length > 1 ? maxThreshold - thresholds[thresholds.length - 2] : maxThreshold
      const maxAllowed = maxAllowedFor(windowSize, cfg.checkpoint?.reserved)

      for (const t of thresholds) {
        if (currentTokens < t) break // sorted ascending; nothing more to trigger
        if (already.has(t)) {
          // The FINAL threshold is the only one that may fire twice, and only
          // once its recovery gate has been reached. Every other threshold has
          // a successor in the ladder, which is its retry.
          const gate = finalRetryAt.get(input.sessionID)
          if (t !== maxThreshold || gate == null || currentTokens < gate) continue
          // Consume the gate before firing: one gate is one attempt. A further
          // transient failure re-arms it a step higher (below), which is what
          // makes the retry budget the remaining window rather than a count.
          finalRetryAt.delete(input.sessionID)
          log.info("checkpoint recovery gate reached — re-firing the final threshold", {
            sessionID: input.sessionID,
            threshold: t,
            gate,
            currentTokens,
          })
        }

        const outcome = yield* checkpoint
          .tryStartCheckpointWriter({
            sessionID: input.sessionID,
            model: { providerID: input.model.providerID, modelID: input.model.id },
            promptOps: input.promptOps,
          })
          .pipe(Effect.catch(() => Effect.succeed<"started" | "queued" | "skipped">("skipped")))

        if (outcome === "started") {
          // No accounting, no in-place retry on an arbitrary threshold. A failed
          // write is self-healing, so there is nothing to book:
          //   - ensureCheckpointTemplate (checkpoint.ts:117-121) writes the
          //     template ONLY when the file is absent, so a failed writer
          //     cannot clobber the previous checkpoint.
          //   - last_checkpoint_message_id advances ONLY on success
          //     (checkpoint.ts:954).
          // A failure therefore leaves file and watermark mutually consistent,
          // both pointing at the last good checkpoint, and a rebuild uses that
          // automatically. The cost of a failure is a STALER checkpoint, never
          // a missing one, and the NEXT THRESHOLD CROSSING is a natural retry
          // with fresher context than an in-place one. Repeated failures mean
          // the provider is broken — the writer runs on the SAME model the
          // foreground turn passed in (this call's `model`, which wins over any
          // agent-configured model at prompt.ts's `inputModel ?? agentModel`),
          // so the user's own turns are failing too and they already know. The
          // writer's LLM calls also run through the same retry ladder as the
          // foreground (retry.ts), so any failure reaching here is already
          // post-retry; counting it again adds nothing.
          //
          // WHAT THAT ARGUMENT DOES NOT COVER — the FINAL threshold. "The next
          // threshold is the retry" presumes a next threshold; the last one has
          // none. Without a recovery gate, a transient failure there would
          // leave the checkpoint stale until the actual context trigger causes
          // a rebuild and re-arms the ladder.
          //
          // So the final threshold gets a gate, on two conditions that between
          // them replace the deleted counter:
          //   1. CLASS, not history — arm only when the settled failure is
          //      retryable. A deterministic one (overflow / auth / bad request)
          //      recurs identically, so re-firing is pure waste; an unclassified
          //      one carries no evidence a retry helps, so it is treated the
          //      same. This reads ONLY this failure, so it needs no memory.
          //   2. PROGRESS, not attempts — the gate sits one ladder STEP above
          //      the token count that fired, clamped to maxAllowed. A retry can
          //      therefore never fire faster than a normal threshold would, the
          //      number of retries is whatever the remaining window affords
          //      (zero once firedAt + step is past maxAllowed), and a
          //      conversation that stops growing stops retrying by itself.
          // Neither condition accumulates anything across attempts, which is
          // what makes this a gate rather than MAX_WRITER_FAILURES renamed.
          //
          // The wait is also still what makes a stuck writer observable: the
          // bound-expiry log inside waitForWriterSettlement. A writer stuck past
          // the 5min bound otherwise leaves no trace at all until it settles,
          // and a log line exactly like it is what diagnosed #1938. Terminal
          // outcomes are already logged by the settle watcher, so nothing else
          // is reported from here.
          const isFinal = t === maxThreshold
          const firedAt = currentTokens
          yield* Effect.gen(function* () {
            const settled = yield* checkpoint.waitForWriterSettlement(input.sessionID)
            if (!isFinal) return
            // "timeout" means STILL IN FLIGHT — the writer may yet succeed and
            // advance the watermark, so it must not arm anything.
            if (settled.outcome !== "failure") return
            // Truthiness, not `=== undefined` (AGENTS.md, "Reading a nullable
            // column"): absent classification is "unknown", not "retryable".
            if (!settled.failure?.retryable) {
              log.info("final checkpoint threshold failed without a retryable class — no recovery gate armed", {
                sessionID: input.sessionID,
                threshold: t,
                kind: settled.failure?.kind,
                cause: settled.failure?.name,
              })
              return
            }
            const gate = Math.min(firedAt + step, maxAllowed)
            if (gate <= firedAt) {
              log.info("final checkpoint threshold failed transiently but the window has no room left for a retry", {
                sessionID: input.sessionID,
                threshold: t,
                firedAt,
                maxAllowed,
              })
              return
            }
            finalRetryAt.set(input.sessionID, gate)
            log.info("final checkpoint threshold failed transiently — recovery gate armed", {
              sessionID: input.sessionID,
              threshold: t,
              firedAt,
              gate,
              kind: settled.failure.kind,
            })
          }).pipe(Effect.forkDetach)
        }

        already.add(t)
        log.info("checkpoint triggered", { threshold: t, currentTokens })
      }

      crossed.set(input.sessionID, already)
    })

    // Each turn end, decide (based on cache-TTL + pressure) whether to soft-trim
    // old tool outputs, hard-clear them with a compacted timestamp, and/or
    // strip non-essential content. Checkpoint firing is NOT done here — the
    // runLoop calls fireCheckpoints() directly each iteration so thresholds
    // fire mid-turn as tokens grow.
    const prune = Effect.fn("SessionPrune.prune")(function* (input: {
      sessionID: SessionID
      model: Provider.Model
      tokens: MessageV2.Assistant["tokens"]
      lastAssistantTime?: number
      promptOps?: ActorPromptOps
    }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return

      if (!isCacheCold(input.model, input.lastAssistantTime)) return

      const pressure = pressureLevel({ cfg, tokens: input.tokens, model: input.model })
      if (pressure === 0) return
      const level = pressure >= 2 ? 2 : 1
      log.info("pruning", { level })

      const msgs = yield* session
        .messages({ sessionID: input.sessionID, agentID: "main" })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type === "tool")
            if (part.state.status === "completed") {
              if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
              if (part.state.time.compacted) break loop
              const estimate = Token.estimate(part.state.output)
              total += estimate
              if (total > PRUNE_PROTECT) {
                pruned += estimate
                toPrune.push(part)
              }
            }
        }
      }

      log.info("found", { pruned, total, level })

      if (level === 1) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            const output = part.state.output
            if (output.length > SOFT_TRIM_THRESHOLD) {
              part.state.output =
                output.slice(0, SOFT_TRIM_KEEP_HEAD) +
                "\n\n[... trimmed — kept first and last 1.5K of " +
                output.length +
                " chars ...]\n\n" +
                output.slice(-SOFT_TRIM_KEEP_TAIL)
              yield* session.updatePart(part)
            }
          }
        }
        log.info("soft-trimmed", { count: toPrune.length })
      } else {
        if (pruned > PRUNE_MINIMUM) {
          for (const part of toPrune) {
            if (part.state.status === "completed") {
              part.state.time.compacted = Date.now()
              yield* session.updatePart(part)
            }
          }
          log.info("pruned", { count: toPrune.length })
        }
      }

      if (level >= 2) {
        yield* stripNonEssential({
          sessionID: input.sessionID,
          model: input.model,
          lastAssistantTime: input.lastAssistantTime,
        })
      }
    })

    const resetThresholds = Effect.fn("SessionPrune.resetThresholds")(function* (sessionID: SessionID) {
      crossed.delete(sessionID)
      // A rebuild re-arms the whole ladder, which supersedes any pending
      // recovery gate — leaving it set would let the (now re-armable) final
      // threshold fire out of order.
      finalRetryAt.delete(sessionID)
    })

    return Service.of({ prune, fireCheckpoints, resetThresholds })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(SessionCheckpoint.defaultLayer),
    Layer.provide(ActorRegistry.defaultLayer),
  ),
)

export * as SessionPrune from "./prune"
