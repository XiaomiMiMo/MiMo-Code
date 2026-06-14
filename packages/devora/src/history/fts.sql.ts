import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const HistoryFtsTable = sqliteTable(
  "history_fts",
  {
    part_id: text().primaryKey(),
    session_id: text().notNull(),
    message_id: text().notNull(),
    project_id: text().notNull(),
    kind: text().notNull(),
    tool_name: text(),
    body: text().notNull(),
    time_created: integer().notNull(),
  },
  (t) => [
    index("history_fts_session_idx").on(t.session_id, t.time_created),
    index("history_fts_project_idx").on(t.project_id, t.time_created),
    index("history_fts_message_idx").on(t.message_id),
  ],
)
