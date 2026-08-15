import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect"
import type { SessionID } from "@/session/schema"

/**
 * Per-session state for the auto-review stop gate. Mirrors TaskGateState
 * (src/task/gate-state.ts) — same InstanceState-backed map pattern — plus a
 * last-reviewed diff hash (dedup) and an in-flight marker (double-spawn guard).
 * State lives in InstanceState (per project instance); cleared on teardown.
 */

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<number>
  /** Increment counter, return new value. */
  readonly bump: (sessionID: SessionID) => Effect.Effect<number>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  readonly setLastReviewedHash: (sessionID: SessionID, hash: string) => Effect.Effect<void>
  readonly getLastReviewedHash: (sessionID: SessionID) => Effect.Effect<string | undefined>
  readonly setInFlight: (sessionID: SessionID, inFlight: boolean) => Effect.Effect<void>
  readonly inFlight: (sessionID: SessionID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ReviewGateState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(
      Effect.fn("ReviewGateState.state")(function* () {
        return {
          counts: new Map<string, number>(),
          hashes: new Map<string, string>(),
          inflight: new Map<string, boolean>(),
        }
      }),
    )

    const get = Effect.fn("ReviewGateState.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.counts.get(sessionID) ?? 0
    })

    const bump = Effect.fn("ReviewGateState.bump")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const next = (data.counts.get(sessionID) ?? 0) + 1
      data.counts.set(sessionID, next)
      return next
    })

    const clear = Effect.fn("ReviewGateState.clear")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.counts.delete(sessionID)
      data.hashes.delete(sessionID)
      data.inflight.delete(sessionID)
    })

    const setLastReviewedHash = Effect.fn("ReviewGateState.setLastReviewedHash")(function* (
      sessionID: SessionID,
      hash: string,
    ) {
      const data = yield* InstanceState.get(state)
      data.hashes.set(sessionID, hash)
    })

    const getLastReviewedHash = Effect.fn("ReviewGateState.getLastReviewedHash")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.hashes.get(sessionID)
    })

    const setInFlight = Effect.fn("ReviewGateState.setInFlight")(function* (sessionID: SessionID, inFlight: boolean) {
      const data = yield* InstanceState.get(state)
      if (inFlight) data.inflight.set(sessionID, true)
      else data.inflight.delete(sessionID)
    })

    const inFlight = Effect.fn("ReviewGateState.inFlight")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.inflight.get(sessionID) ?? false
    })

    return Service.of({ get, bump, clear, setLastReviewedHash, getLastReviewedHash, setInFlight, inFlight })
  }),
)

export const defaultLayer = layer

export * as ReviewGateState from "./review-gate-state"
