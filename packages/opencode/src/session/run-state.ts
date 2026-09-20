import { EffectLogger, InstanceState } from "@/effect"
import { Runner } from "@/effect"
import { Effect, Layer, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { orphanToolIdleSweepRef, assistantMessageIdsSnapshotRef } from "./orphan-tool-idle-hook"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID, agentID?: string) => Effect.Effect<void, Session.BusyError>
  readonly start: (sessionID: SessionID, agentID: string, onInterrupt: Effect.Effect<MessageV2.WithParts>, work: Effect.Effect<MessageV2.WithParts>) => Effect.Effect<void, Session.BusyError>
  /** [C001] Start and return cancel bound to this run id only. */
  readonly startOwned: (
    sessionID: SessionID,
    agentID: string,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<{ readonly runId: number; readonly interruptOwned: Effect.Effect<void> }, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancelActor: (sessionID: SessionID, agentID: string) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    agentID: string,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
  /** [R003] Exclusive: run work only if idle; busy → BusyError. Never join. */
  readonly ensureExclusive: (
    sessionID: SessionID,
    agentID: string,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

/**
 * Runners are keyed by session then agentID — NOT a flat `${sessionID}:${agentID}`
 * string. Flat prefixes are ambiguous when a legal imported session id itself
 * contains a colon (`ses_example` vs `ses_example:child`).
 */
type RunnersBySession = Map<SessionID, Map<string, Runner.Runner<MessageV2.WithParts, never, Session.BusyError>>>

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const elog = EffectLogger.create({ service: "SessionRunState" })

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners: RunnersBySession = new Map()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            const all = [...runners.values()].flatMap((byAgent) => [...byAgent.values()])
            yield* Effect.forEach(all, (runner) => runner.cancel, {
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
      const data = yield* InstanceState.get(state)
      let byAgent = data.runners.get(sessionID)
      if (!byAgent) {
        byAgent = new Map()
        data.runners.set(sessionID, byAgent)
      }
      const existing = byAgent.get(agentID)
      if (existing) return existing
      const isMain = agentID === "main"
      const next = Runner.make<MessageV2.WithParts, never, Session.BusyError>(data.scope, {
        label: `${sessionID}:${agentID}`,
        onReentryWarn: (info) => elog.warn("runner-reentry", info),
        // Do NOT delete Runners on idle: a waiter parked on Cancelling retries
        // on this same instance after Idle — deleting it would start B on an
        // unregistered Runner (RL-ORPHAN-C01). Applies to main AND non-main
        // (Cancelling-wait is agent-agnostic in Runner.ensureRunning).
        // Session idle status is main-only (actors do not publish session idle).
        onIdle: isMain ? status.set(sessionID, { type: "idle" }) : Effect.void,
        onBusy: isMain ? status.set(sessionID, { type: "busy" }) : Effect.void,
        // Child executors must observe cancellation, not a stale assistant.
        onInterrupt: isMain ? onInterrupt : Effect.interrupt,
        busy: () => new Session.BusyError(sessionID),
      })
      byAgent.set(agentID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID, agentID = "main") {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)?.get(agentID)
      if (existing?.busy) yield* Effect.fail(new Session.BusyError(sessionID))
      return
    })

    /**
     * Snapshot assistant message IDs while work is still exiting, then sweep
     * orphans only on that set (RL-ORPHAN-D01). Field evidence: the original
     * orphan sat on an INCOMPLETE assistant (completed only stamped at next
     * prompt entry as Abandoned). Snapshot covers those messages; new turns
     * create new message IDs and cannot enter an earlier snapshot.
     */
    const withOrphanSweep = (sessionID: SessionID, agentID: string, work: Effect.Effect<MessageV2.WithParts>) => {
      if (agentID !== "main") return work
      return work.pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            Effect.gen(function* () {
              const sweep = orphanToolIdleSweepRef.current
              const snapshot = assistantMessageIdsSnapshotRef.current
              if (!sweep || !snapshot) return
              const ownedMessageIds = yield* snapshot(sessionID)
              yield* sweep(sessionID, { ownedMessageIds }).pipe(Effect.ignore)
            }),
          ),
        ),
      )
    }

    const start: Interface["start"] = Effect.fn("SessionRunState.start")(function* (
      sessionID: SessionID,
      agentID: string,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      const active = yield* runner(sessionID, agentID, onInterrupt)
      yield* active.start(withOrphanSweep(sessionID, agentID, work))
      return
    })

    const startOwned: Interface["startOwned"] = Effect.fn("SessionRunState.startOwned")(function* (
      sessionID: SessionID,
      agentID: string,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      const active = yield* runner(sessionID, agentID, onInterrupt)
      return yield* active.startOwned(withOrphanSweep(sessionID, agentID, work))
    })

    // Process-group kill: session abort cancels EVERY runner under this session
    // (main + actor/subagent slices). Orchestrator is unrelated.
    //
    // Do NOT unconditionally delete the captured runner after cancel: Runner.cancel
    // transitions that Runner to Idle, but a replacement ensureRunning may already
    // have reused it (or installed a newer fiber) before interrupt finishes.
    // Unconditional delete orphans still-running work and makes assertNotBusy
    // false-negative. onIdle is the identity-safe cleanup. Below, idle leftovers
    // are removed only when NO runner under this session is still busy.
    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const byAgent = data.runners.get(sessionID)
      if (!byAgent || byAgent.size === 0) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      const targets = [...byAgent.values()]
      yield* Effect.forEach(targets, (existing) => existing.cancel, {
        concurrency: "unbounded",
        discard: true,
      })
      // Idle only when nothing under this session is still busy (replacement
      // work may have started on a reused Runner while cancel was interrupting).
      const after = yield* InstanceState.get(state)
      const current = after.runners.get(sessionID)
      const stillBusy = current ? [...current.values()].some((r) => r.busy) : false
      if (stillBusy) return
      if (current) {
        // Keep Runners registered (Idle): waiters parked on Cancelling retry
        // on this instance (RL-ORPHAN-C01). Do not delete here.
      }
      // Main onIdle also sets idle; force-clear when main was already gone so
      // `/session/status` never stays busy after a successful abort.
      yield* status.set(sessionID, { type: "idle" })
    })

    const cancelActor = Effect.fn("SessionRunState.cancelActor")(function* (
      sessionID: SessionID,
      agentID: string,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)?.get(agentID)
      if (!existing || !existing.busy) return
      yield* existing.cancel
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      agentID: string,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, agentID, onInterrupt)).ensureRunning(withOrphanSweep(sessionID, agentID, work))
    })

    const ensureExclusive = Effect.fn("SessionRunState.ensureExclusive")(function* (
      sessionID: SessionID,
      agentID: string,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, agentID, onInterrupt)).ensureExclusive(work)
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, "main", onInterrupt)).startShell(work)
    })

    return Service.of({ assertNotBusy, cancel, cancelActor, ensureRunning, ensureExclusive, start, startOwned, startShell })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionStatus.defaultLayer))

export * as SessionRunState from "./run-state"
