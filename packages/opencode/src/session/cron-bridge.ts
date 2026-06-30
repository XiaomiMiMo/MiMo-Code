import { Context, Effect, Layer } from "effect"
import { Scheduler, defaultLayer as SchedulerDefaultLayer, type LoopEndedEvent } from "@/cron/scheduler"
import type { CronTask } from "@/cron/cron-task"
import { resolveAtFireTime, isSentinel } from "@/cron/sentinel"
import { listLoopStates, deleteLoopState, resetStrikes, incrementStrikes, getStrikes } from "@/cron/loop-state"
import { injectScheduledPrompt } from "./prompt"
import { SessionStatus } from "./status"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import { Flag } from "@/flag/flag"
import { Log } from "@/util"

const log = Log.create({ service: "cron-bridge" })

/**
 * Reads MIMOCODE_DISABLE_CRON from the live environment so a runtime flip stops
 * already-running schedulers (per spec [S10]). MIMOCODE_EXPERIMENTAL_CRON, by
 * contrast, is read once at start() time.
 */
const isCronDisabled = () => {
  const v = process.env.MIMOCODE_DISABLE_CRON
  if (!v) return false
  const s = v.trim().toLowerCase()
  // Whitespace-only env value treated as not set (matches !v above semantically).
  return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off"
}

export interface Interface {
  /**
   * Start the scheduler for one session. Wires onFire → injectScheduledPrompt,
   * onLoopEnded → log emission, and busy→idle status edges → keepalive sweep
   * (spec [S8]). No-op when MIMOCODE_EXPERIMENTAL_CRON is unset.
   */
  readonly start: (sessionID: SessionID, workspaceRoot: string) => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  /**
   * Run one keepalive sweep against the active session. Exposed for the
   * integration test so the algorithm can be exercised without driving a
   * busy→idle status edge through the bus + dynamic-import detour the
   * production wiring uses. Returns early if no session is mounted.
   */
  readonly runKeepaliveSweep: () => Effect.Effect<void>
}

export class CronBridge extends Context.Service<CronBridge, Interface>()("@mimocode/CronBridge") {}

export const layer = Layer.effect(
  CronBridge,
  Effect.gen(function* () {
    const scheduler = yield* Scheduler
    const status = yield* SessionStatus.Service
    const bus = yield* Bus.Service

    // Per-mount mutable state. start/stop guard against double-mount.
    type Handle = {
      sessionID: SessionID
      unsubscribe: () => void
      loading: boolean
      armedThisTurn: Set<string>
    }
    let started: Handle | null = null

    // Spec [S8] keepalive algorithm. Runs once per busy→idle edge. Iterates
    // every live LoopState, resets strikes for prompts the model re-armed
    // this turn, otherwise increments + auto-arms keepalive (up to budget)
    // or declares the loop model_stopped on budget exhaustion. Defined here
    // (before `start`) so the bus subscribeCallback closure can capture it
    // without TDZ risk.
    const runKeepaliveSweepFor = (handle: Handle) =>
      Effect.gen(function* () {
        const budget = Flag.MIMOCODE_LOOP_KEEPALIVE_BUDGET
        const delaySeconds = Flag.MIMOCODE_LOOP_KEEPALIVE_DELAY_S
        // Snapshot then clear immediately so a concurrent re-arm during the
        // sweep itself is treated as next-turn data.
        const armedSnapshot = new Set(handle.armedThisTurn)
        handle.armedThisTurn.clear()

        for (const loop of listLoopStates()) {
          if (armedSnapshot.has(loop.prompt)) {
            resetStrikes(loop.prompt)
            continue
          }
          const strikes = getStrikes(loop.prompt)
          if (strikes >= budget) {
            yield* scheduler.endLoop(loop.prompt, "model_stopped", { via_keepalive: true })
            continue
          }
          incrementStrikes(loop.prompt)
          const arm = yield* scheduler.armLoop({
            prompt: loop.prompt,
            delay_seconds: delaySeconds,
            reason_length: 0,
            viaKeepalive: true,
          })
          if (arm === null) {
            // Scheduler refused to arm (killed / aged out). Drop loop state
            // so the next sweep doesn't keep churning on a zombie row.
            deleteLoopState(loop.prompt)
            continue
          }
          log.info("loop_keepalive_fired", {
            sessionID: handle.sessionID,
            prompt_is_sentinel: isSentinel(loop.prompt),
            strikes: strikes + 1,
            scheduled_for: arm.scheduledFor,
          })
        }
      })

    const start = (sessionID: SessionID, workspaceRoot: string) =>
      Effect.gen(function* () {
        if (!Flag.MIMOCODE_EXPERIMENTAL_CRON) {
          yield* Effect.sync(() => log.info("cron disabled by flag — bridge inert", { sessionID }))
          return
        }
        if (started) {
          yield* Effect.sync(() => log.warn("bridge already started — ignoring", { sessionID }))
          return
        }

        // Seed isLoading from current session status (busy iff a turn is in-flight).
        const initial = yield* status.get(sessionID)
        const handle: Handle = {
          sessionID,
          unsubscribe: () => undefined,
          loading: initial.type === "busy",
          armedThisTurn: new Set(),
        }
        started = handle

        // Subscribe to SessionStatus.Event.Status. The same subscription serves
        // two purposes:
        //   1. Keep the synchronous isLoading() predicate that the scheduler's
        //      setInterval tick reads in sync with the live session state.
        //   2. Detect the busy→idle transition. That edge IS the turn-end
        //      signal per the recommendation in plan task 9 — after the
        //      assistant message is finalized and all tool_results have
        //      settled, the runLoop transitions the session back to idle.
        //      Intermediate assistant→tool_use→tool_result rounds stay in
        //      `busy`, so this edge fires exactly once per completed turn.
        const unsubscribe = yield* bus.subscribeCallback(SessionStatus.Event.Status, (e) => {
          if (e.properties.sessionID !== sessionID) return
          const wasLoading = handle.loading
          const nowLoading = e.properties.status.type === "busy"
          handle.loading = nowLoading
          if (wasLoading && !nowLoading) {
            // busy → idle: a turn just completed. Run the keepalive sweep
            // detached on the host runtime — we cannot yield* here because
            // subscribeCallback's callback is synchronous.
            import("@/effect/app-runtime")
              .then(({ AppRuntime }) => AppRuntime.runPromise(runKeepaliveSweepFor(handle)))
              .catch((err) =>
                log.error("keepalive sweep failed", { sessionID, error: String(err) }),
              )
          }
        })
        handle.unsubscribe = unsubscribe

        const onFire = (task: CronTask) => {
          // Detached fire-and-forget on the host runtime. We cannot yield* here
          // because the setInterval tick escapes the Effect scope; the host's
          // global runtime materializes the prompt fan-out (same pattern as
          // auto-dream / auto-distill near the cron-bridge mount in prompt.ts).
          //
          // Dynamic import breaks a real module-init cycle:
          // app-runtime.ts (imports CronBridgeDefaultLayer) → cron-bridge.ts →
          // app-runtime.ts. A top-level import here would deadlock module init.
          import("@/effect/app-runtime")
            .then(({ AppRuntime }) =>
              AppRuntime.runPromise(
                Effect.gen(function* () {
                  const resolved = yield* Effect.tryPromise(() =>
                    resolveAtFireTime(task.prompt, workspaceRoot),
                  ).pipe(Effect.orElseSucceed(() => task.prompt))
                  // Prepend an ISO fire timestamp so both the user (TUI) and the
                  // model see when each fire happened. Recurring fires especially
                  // need this — otherwise a `*/5` reply looks identical whether it
                  // came from the :00 tick or the :05 tick. Format kept short and
                  // unambiguous: `[cron fire @ YYYY-MM-DDTHH:MM:SSZ] `.
                  const firedAtISO = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
                  const value = `[cron fire @ ${firedAtISO}] ${resolved}`
                  yield* injectScheduledPrompt({
                    sessionID,
                    value,
                    origin: {
                      kind: "cron",
                      taskId: task.id,
                      kindOfTask: task.kind ?? "cron",
                      firedAt: firedAtISO,
                    },
                    priority: "later",
                    isMeta: true,
                  })
                }),
              ),
            )
            .catch((err) => log.error("scheduled fire failed", { taskId: task.id, error: String(err) }))
        }

        const onLoopEnded = (e: LoopEndedEvent) => {
          // Structured `loop_ended` emission. Analytics-only for now: TUI
          // does not render this row yet (deferred to T21+). The bridge's
          // keepalive sweep calls scheduler.endLoop which routes through here.
          log.info("loop_ended", {
            sessionID,
            reason: e.reason,
            prompt: e.prompt,
            via_keepalive: e.via_keepalive ?? false,
          })
        }

        const onArmLoop = (prompt: string) => {
          // Model-driven re-arm of an existing loop. Record so the busy→idle
          // sweep knows whose strikes to reset. Keepalive-driven auto-arms
          // set viaKeepalive:true in armLoop, which suppresses this callback.
          handle.armedThisTurn.add(prompt)
        }

        yield* scheduler.start({
          workspaceRoot,
          sessionID,
          isLoading: () => handle.loading,
          isKilled: () => isCronDisabled(),
          onFire,
          onLoopEnded,
          onArmLoop,
        })

        yield* Effect.sync(() => log.info("bridge started", { sessionID, workspaceRoot }))
      })

    const runKeepaliveSweep = () =>
      Effect.gen(function* () {
        const handle = started
        if (!handle) return
        yield* runKeepaliveSweepFor(handle)
      })

    const stop = () =>
      Effect.gen(function* () {
        const handle = started
        if (!handle) return
        started = null
        yield* Effect.sync(() => handle.unsubscribe())
        yield* scheduler.stop()
        yield* Effect.sync(() => log.info("bridge stopped", { sessionID: handle.sessionID }))
      })

    // If the Layer's scope closes (session teardown), make sure stop() runs.
    yield* Effect.addFinalizer(() => stop().pipe(Effect.orElseSucceed(() => undefined)))

    return CronBridge.of({ start, stop, runKeepaliveSweep })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SchedulerDefaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(Bus.layer),
)
