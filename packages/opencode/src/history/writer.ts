import { Context, Deferred, Effect, Layer, Queue } from "effect"
import { Database } from "../storage"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { extract } from "./extract"
import { makeResolver, type Resolver } from "./resolve"
import { deleteHistoryRows, upsertHistoryBody } from "./chunk-write"
import { Log } from "../util"

const log = Log.create({ service: "history.writer" })

type Job =
  | { type: "upsert"; part: MessageV2.Part; time: number }
  | { type: "delete"; partID: string }
  | { type: "drain"; done: Deferred.Deferred<void> }

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/History.Writer") {}

export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const queue = yield* Queue.unbounded<Job>()
    const resolver = makeResolver()
    const subscriptions = new Set<() => void>()

    yield* Effect.forever(
      Effect.gen(function* () {
        const job = yield* Queue.take(queue)
        yield* handle(job, resolver).pipe(
          Effect.catchCause((cause) => Effect.sync(() => log.warn("write failed", { cause: String(cause) }))),
        )
      }),
    ).pipe(Effect.forkScoped)

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const off of subscriptions) off()
        subscriptions.clear()
        const done = yield* Deferred.make<void>()
        yield* Queue.offer(queue, { type: "drain", done })
        yield* Deferred.await(done)
      }),
    )

    const init = yield* Effect.cached(
      Effect.gen(function* () {
        subscriptions.add(
          yield* bus.subscribeRuntimeCallback(MessageV2.Event.PartUpdated, (evt) => {
            Queue.offerUnsafe(queue, { type: "upsert", part: evt.properties.part, time: evt.properties.time })
          }),
        )
        subscriptions.add(
          yield* bus.subscribeRuntimeCallback(MessageV2.Event.PartRemoved, (evt) => {
            Queue.offerUnsafe(queue, { type: "delete", partID: evt.properties.partID })
          }),
        )
      }),
    )

    return Service.of({ init: () => init })
  }),
)

function handle(job: Job, resolver: Resolver) {
  if (job.type === "drain") return Deferred.succeed(job.done, undefined)
  if (job.type === "delete") {
    return Effect.sync(() => Database.use((db) => deleteHistoryRows(db, job.partID)))
  }
  return Effect.gen(function* () {
    const part = job.part
    const extracted = extract(part)
    if (!extracted) {
      Database.use((db) => deleteHistoryRows(db, part.id))
      return
    }
    // Session ownership may change or disappear while a Runtime job is queued.
    Database.transaction(
      (db) => {
        const projectID = resolver.projectID(part.sessionID, db)
        if (!projectID) return
        upsertHistoryBody(db, {
          part_id: part.id,
          session_id: part.sessionID,
          message_id: part.messageID,
          project_id: projectID,
          tool_name: extracted.tool_name,
          body: extracted.body,
          time_created: job.time,
        })
      },
      { behavior: "immediate" },
    )
  })
}
