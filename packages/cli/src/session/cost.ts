import { eq, sql } from "drizzle-orm"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import type { SessionID } from "./schema"
import { MessageTable, SessionTable } from "./session.sql"

export function readSessionCost<T>(db: Pick<BaseSQLiteDatabase<"sync", T>, "select">, sessionID: SessionID) {
  // Keep the outer session column qualified inside the message subquery.
  return db
    .select({
      cost: sql<number>`(
        select coalesce(sum(json_extract(${MessageTable.data}, '$.cost')), 0)
        from ${MessageTable}
        where ${MessageTable.session_id} = ${SessionTable}.${sql.identifier("id")}
          and json_extract(${MessageTable.data}, '$.role') = 'assistant'
      )`,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
}
