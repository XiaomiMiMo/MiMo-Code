import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import z from "zod"

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
      if (normalized.type === "retry") data.retryAttempts.set(sessionID, normalized.attempt + 1)
      yield* bus.publish(Event.Status, { sessionID, status: normalized })
      if (normalized.type === "idle") {
        yield* bus.publish(Event.Idle, { sessionID })
        data.statuses.delete(sessionID)
        data.retryAttempts.delete(sessionID)
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
