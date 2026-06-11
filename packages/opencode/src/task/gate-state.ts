import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect"
import type { SessionID } from "@/session/schema"

/**
 * Per-session ReAct counter for the main-path task stop gate. Mirrors
 * Goal.bumpReact (session/goal.ts) — same pattern, different signal: this
 * counts re-entries triggered by non-terminal tasks rather than an unmet
 * goal condition. State lives in InstanceState (per project instance);
 * cleared on instance teardown.
 */

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<number>
  /** Increment counter, return new value. */
  readonly bump: (sessionID: SessionID) => Effect.Effect<number>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskGateState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(
      Effect.fn("TaskGateState.state")(function* () {
        return { counts: new Map<string, number>() }
      }),
    )

    const get = Effect.fn("TaskGateState.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.counts.get(sessionID) ?? 0
    })

    const bump = Effect.fn("TaskGateState.bump")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const next = (data.counts.get(sessionID) ?? 0) + 1
      data.counts.set(sessionID, next)
      return next
    })

    const clear = Effect.fn("TaskGateState.clear")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.counts.delete(sessionID)
    })

    return Service.of({ get, bump, clear })
  }),
)

export const defaultLayer = layer

export * as TaskGateState from "./gate-state"
