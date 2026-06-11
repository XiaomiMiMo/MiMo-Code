import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import type { SessionID, MessageID } from "./schema"

export const ClaudeImportTable = sqliteTable("claude_import", {
  source_uuid: text().primaryKey(),
  session_id: text().$type<SessionID>().notNull(),
  source_path: text().notNull(),
  source_mtime: integer().notNull(),
  time_imported: integer().notNull(),
  // Message rows this import created, so a re-sync only removes its own rows and
  // never destroys mimocode-native continuation messages in the same session.
  message_ids: text({ mode: "json" }).$type<MessageID[]>(),
})
