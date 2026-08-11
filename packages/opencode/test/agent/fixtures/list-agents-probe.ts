// Probe helper spawned as a SUBPROCESS by orchestrator.test.ts to observe the
// orchestrator registration under a specific MIMOCODE_EXPERIMENTAL_ORCHESTRATOR
// value. It cannot be a normal in-suite test because test/preload.ts force-sets
// the flag ON for the whole suite (and Flag is read once at import time), so the
// flag-OFF case is only observable in a fresh process that does NOT load the
// preload. Prints `NAMES=<json array of agent names>` to stdout.
import { Effect } from "effect"
import { provideInstance, tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { Agent } from "../../../src/agent/agent"

function load(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<any>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

const tmp = await tmpdir()
const names = (await Instance.provide({
  directory: tmp.path,
  fn: async () => (await load(tmp.path, (svc) => svc.list())).map((a: any) => a.name),
})) as string[]
process.stdout.write("NAMES=" + JSON.stringify(names) + "\n")
await Instance.disposeAll()
