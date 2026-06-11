import { Context, Effect, Layer, Queue } from "effect"
import { Database, eq } from "../storage"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Config } from "../config"
import { InstanceState } from "../effect"
import { HistoryFtsTable } from "./fts.sql"
import { extract, DEFAULT_KINDS, type Kind } from "./extract"
import { makeResolver, type Resolver } from "./resolve"
import { Log } from "../util"

const log = Log.create({ service: "history.writer" })

type Job =
  | { type: "upsert"; part: MessageV2.Part; time: number }
  | { type: "delete"; partID: string }

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/History.Writer") {}

export const layer: Layer.Layer<Service, never, Config.Service | Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const bus = yield* Bus.Service

    const state = yield* InstanceState.make<{ started: boolean }>(
      Effect.fn("History.Writer.state")(function* (_ctx) {
        const config = yield* cfg.get()
        const kinds = config.history?.kinds ?? DEFAULT_KINDS
        const enabled = new Set<Kind>(kinds as readonly Kind[])
        if (enabled.size === 0) return { started: true }

        const queue = yield* Queue.unbounded<Job>()
        const resolver = makeResolver()

        // Use subscribeCallback (synchronous PubSub.subscribe) so subscriptions
        // are guaranteed live before init() returns. Stream-based subscribe is
        // lazy (Stream.unwrap) and would race with immediate publishes.
        yield* bus.subscribeCallback(MessageV2.Event.PartUpdated, (evt) => {
          Queue.offerUnsafe(queue, { type: "upsert", part: evt.properties.part, time: evt.properties.time })
        })
        yield* bus.subscribeCallback(MessageV2.Event.PartRemoved, (evt) => {
          Queue.offerUnsafe(queue, { type: "delete", partID: evt.properties.partID })
        })

        yield* Effect.forever(
          Effect.gen(function* () {
            const job = yield* Queue.take(queue)
            yield* handle(job, resolver, enabled).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => log.warn("write failed", { cause: String(cause) })),
              ),
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

function handle(job: Job, resolver: Resolver, enabled: ReadonlySet<Kind>) {
  if (job.type === "delete") {
    return Effect.sync(() =>
      Database.use((db) => db.delete(HistoryFtsTable).where(eq(HistoryFtsTable.part_id, job.partID)).run()),
    )
  }
  return Effect.gen(function* () {
    const part = job.part
    const role = yield* resolver.role(part.messageID)
    const extracted = extract(part, role, enabled)
    if (!extracted) return
    const projectID = yield* resolver.projectID(part.sessionID)

    Database.use((db) =>
      db
        .insert(HistoryFtsTable)
        .values({
          part_id: part.id,
          session_id: part.sessionID,
          message_id: part.messageID,
          project_id: projectID,
          kind: extracted.kind,
          tool_name: extracted.tool_name,
          body: extracted.body,
          time_created: job.time,
        })
        .onConflictDoUpdate({
          target: HistoryFtsTable.part_id,
          set: {
            kind: extracted.kind,
            tool_name: extracted.tool_name,
            body: extracted.body,
            time_created: job.time,
          },
        })
        .run(),
    )
  })
}

