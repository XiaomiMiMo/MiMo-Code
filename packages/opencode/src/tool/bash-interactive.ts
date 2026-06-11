import { Deferred, Effect, Layer, Context } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect"
import { Log } from "@/util"
import z from "zod"
import crypto from "crypto"

const log = Log.create({ service: "bash-interactive" })

// Bus events

export const Event = {
  Asked: BusEvent.define(
    "bash.interactive.asked",
    z.object({
      id: z.string(),
      command: z.string(),
      cwd: z.string(),
      env: z.record(z.string(), z.string()).optional(),
      description: z.string(),
    }),
  ),
  Replied: BusEvent.define(
    "bash.interactive.replied",
    z.object({
      id: z.string(),
      output: z.string(),
      exitCode: z.number(),
    }),
  ),
}

// Types

export interface InteractiveRequest {
  id: string
  command: string
  cwd: string
  env?: Record<string, string>
  description: string
}

export interface InteractiveResult {
  output: string
  exitCode: number
}

export class InteractiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BashInteractiveError"
  }
}

// Service

interface PendingEntry {
  request: InteractiveRequest
  deferred: Deferred.Deferred<InteractiveResult, InteractiveError>
}

interface State {
  pending: Map<string, PendingEntry>
}

export interface Interface {
  readonly request: (input: {
    command: string
    cwd: string
    env?: Record<string, string>
    description: string
  }) => Effect.Effect<InteractiveResult, InteractiveError>
  readonly reply: (input: { id: string; output: string; exitCode: number }) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<InteractiveRequest>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BashInteractive") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("BashInteractive.state")(function* () {
        const state: State = {
          pending: new Map(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new InteractiveError("Instance disposed"))
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const request = Effect.fn("BashInteractive.request")(function* (input: {
      command: string
      cwd: string
      env?: Record<string, string>
      description: string
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const id = crypto.randomUUID()
      log.info("requesting interactive", { id, command: input.command })

      const deferred = yield* Deferred.make<InteractiveResult, InteractiveError>()
      const req: InteractiveRequest = {
        id,
        command: input.command,
        cwd: input.cwd,
        env: input.env,
        description: input.description,
      }
      pending.set(id, { request: req, deferred })
      yield* bus.publish(Event.Asked, req)

      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("BashInteractive.reply")(function* (input: {
      id: string
      output: string
      exitCode: number
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.id)
      if (!existing) {
        log.warn("reply for unknown request", { id: input.id })
        return
      }
      pending.delete(input.id)
      log.info("replied", { id: input.id, exitCode: input.exitCode })
      yield* bus.publish(Event.Replied, {
        id: existing.request.id,
        output: input.output,
        exitCode: input.exitCode,
      })
      yield* Deferred.succeed(existing.deferred, {
        output: input.output,
        exitCode: input.exitCode,
      })
    })

    const list = Effect.fn("BashInteractive.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.request)
    })

    return Service.of({ request, reply, list })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

// Standalone functions (uses the instance-scoped runtime, same pattern as Bus module)
import { makeRuntime } from "@/effect/run-service"

const { runPromise } = makeRuntime(Service, defaultLayer)

export function request(input: {
  command: string
  cwd: string
  env?: Record<string, string>
  description: string
}): Promise<InteractiveResult> {
  return runPromise((svc) => svc.request(input))
}

export function reply(input: { id: string; output: string; exitCode: number }): Promise<void> {
  return runPromise((svc) => svc.reply(input))
}
