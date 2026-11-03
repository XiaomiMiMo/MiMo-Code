import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const MemoryFtsTable = sqliteTable(
  "memory_fts",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    path: text().notNull().unique(),
    scope: text().notNull(),
    scope_id: text().notNull().default(""),
    type: text().notNull(),
    body: text().notNull(),
    body_idx: text().notNull(),
    fingerprint: text().notNull(),
    last_indexed_at: integer().notNull(),
  },
  (table) => [
    index("memory_fts_scope_idx").on(table.scope, table.scope_id),
    index("memory_fts_type_idx").on(table.type),
  ],
)

export const MemoryIndexMigrationTable = sqliteTable("memory_index_migration", {
  version: integer().primaryKey(),
  cursor: integer().notNull().default(0),
})
