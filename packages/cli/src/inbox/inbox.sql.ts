import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import type { SessionID } from "../session/schema"

export const InboxTable = sqliteTable(
  "inbox",
  {
    id: text().primaryKey(),
    receiver_session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    receiver_actor_id: text().notNull(),
    sender_session_id: text().$type<SessionID>(),
    sender_actor_id: text(),
    type: text().notNull().default("text"),
    content: text({ mode: "json" }).$type<unknown>().notNull(),
    created_at: integer().notNull(),
  },
  (t) => [
    index("inbox_receiver_idx").on(t.receiver_session_id, t.receiver_actor_id, t.id),
    index("inbox_created_idx").on(t.created_at),
  ],
)

export type InboxRow = typeof InboxTable.$inferSelect
