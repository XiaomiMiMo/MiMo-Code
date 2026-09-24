import { AppRuntime } from "@/effect/app-runtime"
import { InstanceBootstrap } from "../project/bootstrap"
import { Instance } from "../project/instance"
import { SessionCheckpoint } from "@/session/checkpoint"
import { Log } from "@/util"

const log = Log.create({ service: "cli.bootstrap" })

export type CheckpointDrainEvent =
  | { type: "start"; count: number; timeoutMs: number }
  | { type: "complete"; drained: number; timedOut: number }

export async function bootstrap<T>(
  directory: string,
  cb: () => Promise<T>,
  options?: { onCheckpointDrain?: (event: CheckpointDrainEvent) => void },
) {
  const report = (event: CheckpointDrainEvent) => {
    try {
      options?.onCheckpointDrain?.(event)
    } catch (error) {
      log.warn("checkpoint drain status failed", { error: String(error) })
    }
  }

  return Instance.provide({
    directory,
    init: () => AppRuntime.runPromise(InstanceBootstrap),
    fn: async () => {
      try {
        return await cb()
      } finally {
        // Give detached background checkpoint writers a chance to finish
        // before teardown. Headless `mimo run` would otherwise exit right
        // after the main response, killing any forked writer mid-LLM-call
        // and leaving zero checkpoint files on disk.
        //
        // Up to 120s for ALL pending writers collectively. Writers that
        // don't settle in time are abandoned — the runtime teardown will
        // kill them anyway, and their thresholds stay marked so the next
        // process invocation can observe the gap via fireCheckpoints.
        const result = await AppRuntime.runPromise(
          SessionCheckpoint.Service.use((svc) =>
            svc.drainWriters({ onStart: (info) => report({ type: "start", ...info }) }),
          ),
        ).catch((err) => log.warn("checkpoint drain failed", { error: String(err) }))
        if (result && result.drained + result.timedOut > 0) report({ type: "complete", ...result })
        await Instance.dispose()
      }
    },
  })
}
