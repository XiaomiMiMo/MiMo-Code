import { AppRuntime } from "@/effect/app-runtime"
import { Instance } from "@/project/instance"
import { Config } from "@/config"
import { Provider } from "@/provider"
import { Effect } from "effect"

/** Prepare every candidate before publishing any model view. Never dispose an Instance. */
export async function refreshProviders() {
  const applied = await Instance.updateIdle(async (contexts) => {
    const commits: (() => void)[] = []
    for (const context of contexts) {
      commits.push(await Instance.restore(context, () => AppRuntime.runPromise(Effect.gen(function* () {
        const config = yield* Config.Service
        const provider = yield* Provider.Service
        const candidate = yield* config.prepareModelRefresh()
        if (!candidate) return () => {}
        const publish = yield* provider.prepareRefresh(candidate.config)
        return () => { candidate.commit(); publish() }
      }))))
    }
    await AppRuntime.runPromise(Config.Service.use((config) => config.invalidateSource()))
    for (const commit of commits) commit()
  })
  return { state: applied ? "applied" as const : "pending" as const }
}
