import { EffectLogger, InstanceState } from "@/effect"
import { Runner } from "@/effect"
import { Effect, Layer, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { orphanToolIdleSweepRef } from "./orphan-tool-idle-hook"

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
        // Cleanup only when THIS runner is actually idle. Cancel must never
        // delete a map entry that has already been replaced by a newer run.
        onIdle: isMain
          ? Effect.gen(function* () {
              byAgent.delete(agentID)
              if (byAgent.size === 0) data.runners.delete(sessionID)
              yield* status.set(sessionID, { type: "idle" })
            })
          : Effect.sync(() => {
              byAgent.delete(agentID)
              if (byAgent.size === 0) data.runners.delete(sessionID)
            }),
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
     * Orphan tool sweep must run while THIS Runner still owns execution
     * (work Effect not yet exited → state still Running → new start only
     * attaches pending, cannot launch new main-slice tools). Primary hook:
     * Effect.ensuring on the work. status.set(idle) in onIdle runs after
     * finishRun already flipped the Runner to Idle, so it is NOT a safe
     * ownership boundary (RL-ORPHAN-D01).
     */
    const withOrphanSweep = (sessionID: SessionID, agentID: string, work: Effect.Effect<MessageV2.WithParts>) => {
      if (agentID !== "main") return work
      return work.pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            const sweep = orphanToolIdleSweepRef.current
            if (!sweep) return Effect.void
            // force: Runner is still Running, get() is busy — that is correct.
            // before: belt-and-suspenders only; pending work cannot start until
            // this ensuring completes, so new-turn tools cannot exist yet.
            return sweep(sessionID, { force: true, before: Date.now() }).pipe(Effect.ignore)
          }),
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
        // No runner left to own the sweep. Force-clean orphans before idle so
        // the next prompt does not emit abort into a new turn (backup path;
        // primary is work ensuring while Runner is Running).
        const sweep = orphanToolIdleSweepRef.current
        if (sweep) yield* sweep(sessionID, { force: true, before: Date.now() }).pipe(Effect.ignore)
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
        for (const [agentID, r] of [...current.entries()]) {
          if (!r.busy) current.delete(agentID)
        }
        if (current.size === 0) after.runners.delete(sessionID)
      }
      const sweep = orphanToolIdleSweepRef.current
      if (sweep) yield* sweep(sessionID, { force: true, before: Date.now() }).pipe(Effect.ignore)
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
