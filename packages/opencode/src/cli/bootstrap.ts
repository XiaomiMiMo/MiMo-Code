import { AppRuntime } from "@/effect/app-runtime"
import { InstanceBootstrap } from "../project/bootstrap"
import { Instance } from "../project/instance"
import { SessionCheckpoint } from "@/session/checkpoint"
import { Log } from "@/util"

const log = Log.create({ service: "cli.bootstrap" })

export async function bootstrap<T>(directory: string, cb: () => Promise<T>) {
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
        await AppRuntime.runPromise(
          SessionCheckpoint.Service.use((svc) => svc.drainWriters()),
        ).catch((err) => log.warn("checkpoint drain failed", { error: String(err) }))
        await Instance.dispose()
      }
    },
  })
}
