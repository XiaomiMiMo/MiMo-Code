import { Context, Effect, Layer, Scope } from "effect"
import { InstanceState } from "@/effect"
import { Log } from "@/util"

const log = Log.create({ service: "bash-job" })

// Instance-scoped registry of background bash jobs (see tool/bash.ts's
// runBackground). A job is a monitor fiber forked INTO the instance entry
// scope, so instance disposal interrupts it — and the fiber's own
// Effect.scoped then kills the still-running child through the spawner's
// acquireRelease, the same disposal chain bash-interactive relies on for its
// pending requests. The jobs set only records which jobIDs belong to this
// instance (observability on disposal); lifetime itself is the scope's job.
interface State {
  scope: Scope.Scope
  jobs: Set<string>
}

export interface Interface {
  readonly start: (jobID: string, monitor: Effect.Effect<void, never, never>) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BashJob") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(
      Effect.fn("BashJob.state")(function* () {
        const state: State = {
          scope: yield* Scope.Scope,
          jobs: new Set(),
        }
        // Runs after the scope has interrupted every forked monitor (finalizers
        // are LIFO, and each monitor registered later), so anything still here
        // would be a monitor that failed to clean up after itself.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (state.jobs.size > 0) log.warn("instance disposed with bash jobs still registered", { jobs: state.jobs.size })
            state.jobs.clear()
          }),
        )
        return state
      }),
    )

    const start = Effect.fn("BashJob.start")(function* (jobID: string, monitor: Effect.Effect<void, never, never>) {
      const instance = yield* InstanceState.get(state)
      instance.jobs.add(jobID)
      yield* monitor.pipe(
        Effect.ensuring(Effect.sync(() => instance.jobs.delete(jobID))),
        Effect.forkIn(instance.scope),
      )
      log.info("started background bash job", { jobID })
    })

    return Service.of({ start })
  }),
)

export const defaultLayer = layer

// Standalone entry point (uses the instance-scoped runtime, same pattern as
// BashInteractive): the bash tool calls start() as a promise so its own
// definition does not grow a BashJob service requirement.
import { makeRuntime } from "@/effect/run-service"

const { runPromise } = makeRuntime(Service, defaultLayer)

export function start(jobID: string, monitor: Effect.Effect<void, never, never>): Promise<void> {
  return runPromise((svc) => svc.start(jobID, monitor))
}
