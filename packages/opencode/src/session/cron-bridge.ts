import { Context, Effect, Layer } from "effect"
import { Scheduler, defaultLayer as SchedulerDefaultLayer, type LoopEndedEvent } from "@/cron/scheduler"
import type { CronTask } from "@/cron/cron-task"
import { resolveAtFireTime } from "@/cron/sentinel"
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
   * onLoopEnded → log + bus (full event-bus integration deferred to T20).
   * No-op when MIMOCODE_EXPERIMENTAL_CRON is unset.
   */
  readonly start: (sessionID: SessionID, workspaceRoot: string) => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
}

export class CronBridge extends Context.Service<CronBridge, Interface>()("@mimocode/CronBridge") {}

export const layer = Layer.effect(
  CronBridge,
  Effect.gen(function* () {
    const scheduler = yield* Scheduler
    const status = yield* SessionStatus.Service
    const bus = yield* Bus.Service

    // Per-mount mutable state. start/stop guard against double-mount.
    let started: { sessionID: SessionID; unsubscribe: () => void; loading: boolean } | null = null

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
        const handle: { sessionID: SessionID; unsubscribe: () => void; loading: boolean } = {
          sessionID,
          unsubscribe: () => undefined,
          loading: initial.type === "busy",
        }
        started = handle

        // Subscribe to SessionStatus.Event.Status so the synchronous isLoading
        // predicate the Scheduler's setInterval tick can call reflects the live
        // session state. The Bus subscribeCallback is fire-and-forget on the
        // session pubsub and yields a synchronous unsubscribe.
        const unsubscribe = yield* bus.subscribeCallback(SessionStatus.Event.Status, (e) => {
          if (e.properties.sessionID !== sessionID) return
          handle.loading = e.properties.status.type === "busy"
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
                  const value = yield* Effect.tryPromise(() =>
                    resolveAtFireTime(task.prompt, workspaceRoot),
                  ).pipe(Effect.orElseSucceed(() => task.prompt))
                  yield* injectScheduledPrompt({
                    sessionID,
                    value,
                    origin: {
                      kind: "cron",
                      taskId: task.id,
                      kindOfTask: task.kind ?? "cron",
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
          // T20 will publish a structured `loop_ended` bus event. For T18 we
          // just log so end-to-end fire is observable in tests.
          log.info("loop ended", { sessionID, reason: e.reason, viaKeepalive: e.via_keepalive ?? false })
        }

        yield* scheduler.start({
          workspaceRoot,
          sessionID,
          isLoading: () => handle.loading,
          isKilled: () => isCronDisabled(),
          onFire,
          onLoopEnded,
        })

        yield* Effect.sync(() => log.info("bridge started", { sessionID, workspaceRoot }))
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

    return CronBridge.of({ start, stop })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SchedulerDefaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(Bus.layer),
)
