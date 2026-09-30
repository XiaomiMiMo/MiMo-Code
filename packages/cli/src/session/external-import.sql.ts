import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"
import type { SessionID, MessageID } from "./schema"

export type ExternalSource = "cc" | "codex" | "opencode"

export const ExternalImportTable = sqliteTable(
  "external_import",
  {
    source: text().$type<ExternalSource>().notNull(),
    source_key: text().notNull(),
    session_id: text().$type<SessionID>().notNull(),
    source_path: text().notNull(),
    source_mtime: integer().notNull(),
    time_imported: integer().notNull(),
    message_ids: text({ mode: "json" }).$type<MessageID[]>(),
  },
  (table) => [primaryKey({ columns: [table.source, table.source_key] })],
)
