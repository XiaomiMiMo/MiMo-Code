import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, gt, sql } from "drizzle-orm"
import { Database } from "../storage"
import { Config } from "../config"
import { PartTable, SessionTable } from "../session/session.sql"
import { HistoryFtsTable } from "./fts.sql"
import { extract, DEFAULT_KINDS, type Kind } from "./extract"
import { makeResolver, type Resolver } from "./resolve"
import { Log } from "../util"
import type { MessageV2 } from "../session/message-v2"

const log = Log.create({ service: "history.backfill" })

const BATCH = 500

/**
 * Walk PartTable newest-session-first with the given enabled kinds.
 * Idempotent — re-running skips already-indexed parts via NOT EXISTS.
 * Exposed for tests so callers can pass a pre-resolved enabled set.
 */
export function backfillAll(enabled: ReadonlySet<Kind> = new Set(DEFAULT_KINDS)) {
  return Effect.gen(function* () {
    if (enabled.size === 0) return

    const resolver = makeResolver()
    const sessions = Database.use((db) =>
      db
        .select({ id: SessionTable.id, project_id: SessionTable.project_id })
        .from(SessionTable)
        .orderBy(desc(SessionTable.time_updated))
        .all(),
    )

    for (const session of sessions) {
      yield* scanSession(session, resolver, enabled).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => log.warn("session scan failed", { session: session.id, cause: String(cause) })),
        ),
      )
      yield* Effect.sleep("50 millis")
    }
    log.info("backfill complete", { sessions: sessions.length })
  })
}

function scanSession(
  session: { id: string; project_id: string },
  resolver: Resolver,
  enabled: ReadonlySet<Kind>,
) {
  return Effect.gen(function* () {
    let cursor = ""
    while (true) {
      const parts = Database.use((db) =>
        db
          .select()
          .from(PartTable)
          .where(
            and(
              eq(PartTable.session_id, session.id as any),
              gt(PartTable.id, cursor as any),
              sql`NOT EXISTS (SELECT 1 FROM history_fts WHERE history_fts.part_id = ${PartTable.id})`,
            ),
          )
          .orderBy(asc(PartTable.id))
          .limit(BATCH)
          .all(),
      )
      if (parts.length === 0) return

      yield* writeBatch(parts, session.project_id, resolver, enabled)
      cursor = parts[parts.length - 1]!.id
      yield* Effect.sleep("10 millis")
    }
  })
}

function writeBatch(
  parts: Array<{ id: string; session_id: string; message_id: string; data: unknown; time_created: number }>,
  projectID: string,
  resolver: Resolver,
  enabled: ReadonlySet<Kind>,
) {
  return Effect.gen(function* () {
    type ToWrite = {
      part: (typeof parts)[number]
      kind: Kind
      body: string
      tool_name: string | null
      time: number
    }
    const writes: ToWrite[] = []
    for (const p of parts) {
      const role = yield* resolver.role(p.message_id)
      // Reconstruct the MessageV2.Part shape that extract() expects.
      // PartTable.data stores everything except id/sessionID/messageID.
      const fullPart = {
        id: p.id,
        sessionID: p.session_id,
        messageID: p.message_id,
        ...(p.data as object),
      } as MessageV2.Part
      const extracted = extract(fullPart, role, enabled)
      if (!extracted) continue
      writes.push({
        part: p,
        kind: extracted.kind,
        body: extracted.body,
        tool_name: extracted.tool_name,
        time: p.time_created,
      })
    }
    if (writes.length === 0) return
    Database.transaction((tx) => {
      for (const w of writes) {
        tx.insert(HistoryFtsTable)
          .values({
            part_id: w.part.id,
            session_id: w.part.session_id,
            message_id: w.part.message_id,
            project_id: projectID,
            kind: w.kind,
            tool_name: w.tool_name,
            body: w.body,
            time_created: w.time,
          })
          .onConflictDoUpdate({
            target: HistoryFtsTable.part_id,
            set: { kind: w.kind, tool_name: w.tool_name, body: w.body, time_created: w.time },
          })
          .run()
      }
    })
  })
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/History.Backfill") {}

export const layer: Layer.Layer<Service, never, Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    return Service.of({
      init: Effect.fn("History.Backfill.init")(function* () {
        const config = yield* cfg.get()
        const kinds = config.history?.kinds ?? DEFAULT_KINDS
        const enabled = new Set<Kind>(kinds as readonly Kind[])
        // Fire-and-forget: do not block bootstrap on the potentially long scan.
        yield* backfillAll(enabled).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.warn("backfill aborted", { cause: String(cause) })),
          ),
          Effect.forkDetach,
        )
      }),
    })
  }),
)
