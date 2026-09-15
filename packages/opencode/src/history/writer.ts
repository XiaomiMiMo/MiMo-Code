import { Context, Effect, Layer, Queue } from "effect"
import { Database } from "../storage"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { InstanceState } from "../effect"
import { extract } from "./extract"
import { previewToolOutput } from "../tool/truncate"
import { makeResolver, type Resolver } from "./resolve"
import { deleteHistoryRows, upsertHistoryBody } from "./chunk-write"
import { Log } from "../util"

const log = Log.create({ service: "history.writer" })

type Job = { type: "upsert"; part: MessageV2.Part; time: number } | { type: "delete"; partID: string }

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/History.Writer") {}

export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const state = yield* InstanceState.make<{ started: boolean }>(
      Effect.fn("History.Writer.state")(function* (_ctx) {
        const queue = yield* Queue.unbounded<Job>()
        const resolver = makeResolver()

        yield* bus.subscribeCallback(MessageV2.Event.PartUpdated, (evt) => {
          Queue.offerUnsafe(queue, { type: "upsert", part: evt.properties.part, time: evt.properties.time })
        })
        yield* bus.subscribeCallback(MessageV2.Event.PartRemoved, (evt) => {
          Queue.offerUnsafe(queue, { type: "delete", partID: evt.properties.partID })
        })

        yield* Effect.forever(
          Effect.gen(function* () {
            const job = yield* Queue.take(queue)
            yield* handle(job, resolver).pipe(
              Effect.catchCause((cause) => Effect.sync(() => log.warn("write failed", { cause: String(cause) }))),
            )
          }),
        ).pipe(Effect.forkScoped)

        return { started: true }
      }),
    )

    return Service.of({
      init: Effect.fn("History.Writer.init")(function* () {
        yield* InstanceState.get(state)
      }),
    })
  }),
)

function handle(job: Job, resolver: Resolver) {
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
    // Same truncation path as tool call results — before history write.
    const forIndex = previewToolOutput(extracted.body).content
    const projectID = yield* resolver.projectID(part.sessionID)
    Database.use((db) =>
      upsertHistoryBody(db, {
        part_id: part.id,
        session_id: part.sessionID,
        message_id: part.messageID,
        project_id: projectID,
        tool_name: extracted.tool_name,
        body: forIndex,
        time_created: job.time,
      }),
    )
  })
}
