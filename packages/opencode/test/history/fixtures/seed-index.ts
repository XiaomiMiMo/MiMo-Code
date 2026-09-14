// Test-only full index builder. Never used at startup.
import { Effect } from "effect"
import { and, asc, desc, eq, gt, sql } from "drizzle-orm"
import { Database } from "../../../src/storage"
import { PartTable, SessionTable } from "../../../src/session/session.sql"
import { HistoryFtsTable } from "../../../src/history/fts.sql"
import { extract } from "../../../src/history/extract"
import { projection } from "../../../src/history/projection"
import { Log } from "../../../src/util"
import type { MessageV2 } from "../../../src/session/message-v2"

const log = Log.create({ service: "history.backfill" })

const BATCH = 500

/**
 * Walk PartTable newest-session-first.
 * Idempotent — re-running skips already-indexed parts via NOT EXISTS.
 */
export function backfillAll() {
  return Effect.gen(function* () {
    let failed = false
    const sessions = Database.use((db) =>
      db
        .select({ id: SessionTable.id, project_id: SessionTable.project_id })
        .from(SessionTable)
        .orderBy(desc(SessionTable.time_updated))
        .all(),
    )

    for (const session of sessions) {
      yield* scanSession(session).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            failed = true
            log.warn("session scan failed", { session: session.id, cause: String(cause) })
          }),
        ),
      )
      yield* Effect.sleep("50 millis")
    }
    log.info("backfill complete", { sessions: sessions.length, failed })
    return !failed
  })
}

function scanSession(session: { id: string; project_id: string }) {
  return Effect.gen(function* () {
    let cursor = ""
    while (true) {
      const parts = Database.use((db) =>
        db
          .select(projection())
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

      yield* writeBatch(parts, session.project_id)
      cursor = parts[parts.length - 1]!.id
      yield* Effect.sleep("10 millis")
    }
  })
}

function writeBatch(
  parts: Array<{ id: string; session_id: string; message_id: string; data: unknown; time_created: number }>,
  projectID: string,
) {
  return Effect.gen(function* () {
    type ToWrite = {
      part: (typeof parts)[number]
      body: string
      tool_name: string | null
      time: number
    }
    const writes: ToWrite[] = []
    for (const p of parts) {
      // Reconstruct the MessageV2.Part shape that extract() expects.
      // PartTable.data stores everything except id/sessionID/messageID.
      const fullPart = {
        id: p.id,
        sessionID: p.session_id,
        messageID: p.message_id,
        ...(p.data as object),
      } as MessageV2.Part
      const extracted = extract(fullPart)
      if (!extracted) continue
      writes.push({
        part: p,

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

            tool_name: w.tool_name,
            body: w.body,
            time_created: w.time,
          })
          .onConflictDoUpdate({
            target: HistoryFtsTable.part_id,
            set: { tool_name: w.tool_name, body: w.body, time_created: w.time },
          })
          .run()
      }
    })
  })
}
