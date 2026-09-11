import { EffectLogger, InstanceState } from "@/effect"
import { Runner } from "@/effect"
import { Effect, Layer, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID, agentID?: string) => Effect.Effect<void, Session.BusyError>
  readonly start: (sessionID: SessionID, agentID: string, onInterrupt: Effect.Effect<MessageV2.WithParts>, work: Effect.Effect<MessageV2.WithParts>) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancelActor: (sessionID: SessionID, agentID: string) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    agentID: string,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const runnerKey = (sessionID: SessionID, agentID: string) => `${sessionID}:${agentID}`

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const elog = EffectLogger.create({ service: "SessionRunState" })

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<string, Runner.Runner<MessageV2.WithParts, never, Session.BusyError>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      agentID: string,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const key = runnerKey(sessionID, agentID)
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(key)
      if (existing) return existing
      const isMain = agentID === "main"
      const next = Runner.make<MessageV2.WithParts, never, Session.BusyError>(data.scope, {
        label: key,
        onReentryWarn: (info) => elog.warn("runner-reentry", info),
        onIdle: isMain
          ? Effect.gen(function* () {
              data.runners.delete(key)
              yield* status.set(sessionID, { type: "idle" })
            })
          : Effect.sync(() => {
              data.runners.delete(key)
            }),
        onBusy: isMain ? status.set(sessionID, { type: "busy" }) : Effect.void,
        onInterrupt,
        busy: () => new Session.BusyError(sessionID),
      })
      data.runners.set(key, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID, agentID = "main") {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(runnerKey(sessionID, agentID))
      if (existing?.busy) yield* Effect.fail(new Session.BusyError(sessionID))
      return
    })

    const start: Interface["start"] = Effect.fn("SessionRunState.start")(function* (
      sessionID: SessionID,
      agentID: string,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      const active = yield* runner(sessionID, agentID, onInterrupt)
      yield* active.start(work)
      return
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const key = runnerKey(sessionID, "main")
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(key)
      if (!existing || !existing.busy) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.cancel
    })

    const cancelActor = Effect.fn("SessionRunState.cancelActor")(function* (
      sessionID: SessionID,
      agentID: string,
    ) {
      const key = runnerKey(sessionID, agentID)
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(key)
      if (!existing || !existing.busy) return
      yield* existing.cancel
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      agentID: string,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, agentID, onInterrupt)).ensureRunning(work)
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, "main", onInterrupt)).startShell(work)
    })

    return Service.of({ assertNotBusy, cancel, cancelActor, ensureRunning, start, startShell })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionStatus.defaultLayer))

export * as SessionRunState from "./run-state"
