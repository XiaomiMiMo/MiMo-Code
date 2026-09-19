import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect"
import { SessionID } from "./schema"
import { orphanToolIdleSweepRef } from "./orphan-tool-idle-hook"
import { Effect, Layer, Context } from "effect"
import z from "zod"
import { Log } from "@/util"

const slog = Log.create({ service: "session.status" })

export const Info = z
  .union([
    z.object({
      type: z.literal("idle"),
    }),
    z.object({
      type: z.literal("retry"),
      attempt: z.number(),
      phaseAttempt: z.number().optional(),
      message: z.string(),
      next: z.number(),
      phase: z.enum(["request", "stream"]).optional(),
      scope: z.enum(["request", "live-step", "max-candidate", "max-judge"]).optional(),
    }),
    z.object({
      type: z.literal("notice"),
      message: z.string(),
    }),
    z.object({
      type: z.literal("busy"),
      message: z.string().optional(),
    }),
  ])
  .meta({
    ref: "SessionStatus",
  })
export type Info = z.infer<typeof Info>
export type RetryInfo = Extract<Info, { type: "retry" }>

export const Event = {
  Status: BusEvent.define(
    "session.status",
    z.object({
      sessionID: SessionID.zod,
      status: Info,
    }),
  ),
  // deprecated
  Idle: BusEvent.define(
    "session.idle",
    z.object({
      sessionID: SessionID.zod,
    }),
  ),
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
  readonly setRetry: (sessionID: SessionID, status: RetryInfo) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() =>
        Effect.succeed({ statuses: new Map<SessionID, Info>(), retryAttempts: new Map<SessionID, number>() }),
      ),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.statuses.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map((yield* InstanceState.get(state)).statuses)
    })

    const commit = Effect.fn("SessionStatus.commit")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      const normalized: Info =
        status.type === "retry"
          ? {
              ...status,
              attempt: data.retryAttempts.get(sessionID) ?? status.attempt,
              phaseAttempt: status.phaseAttempt ?? status.attempt,
            }
          : status
      if (normalized.type === "retry") {
        data.retryAttempts.set(sessionID, normalized.attempt + 1)
        // Density telemetry (debug): UI reconnect streak is built from these frames.
        // Keep waitMs for field incidents; debug avoids storm-time log flood.
        slog.debug("session.status retry publish", {
          sessionID,
          attempt: normalized.attempt,
          phaseAttempt: normalized.phaseAttempt,
          phase: normalized.phase,
          scope: normalized.scope,
          message: normalized.message,
          waitMs: Math.max(0, normalized.next - Date.now()),
        })
      }
      yield* bus.publish(Event.Status, { sessionID, status: normalized })
      if (normalized.type === "idle") {
        yield* bus.publish(Event.Idle, { sessionID })
        data.statuses.delete(sessionID)
        data.retryAttempts.delete(sessionID)
        // Orphan tool parts (pending/running whose abort finalizer was skipped)
        // must be rewritten on this edge — not deferred to the next prompt, whose
        // entry sweep would emit the abort into the NEW turn's UI stream.
        // before-cutoff: only parts already running at the idle edge.
        const sweep = orphanToolIdleSweepRef.current
        if (sweep) yield* sweep(sessionID, { before: Date.now() }).pipe(Effect.ignore)
      } else {
        data.statuses.set(sessionID, normalized)
      }
      return normalized
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      yield* commit(sessionID, status)
    })

    const setRetry = Effect.fn("SessionStatus.setRetry")(function* (sessionID: SessionID, status: RetryInfo) {
      const normalized = yield* commit(sessionID, status)
      return normalized.type === "retry" ? normalized.attempt : status.attempt
    })

    return Service.of({ get, list, set, setRetry })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as SessionStatus from "./status"
