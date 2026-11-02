import { eq } from "drizzle-orm"
import type { Database } from "../storage"
import { MemoryFtsTable, MemoryIndexMigrationTable } from "./fts.sql"
import { buildSearchIndexText } from "./search-text"

/** Complete the pending content upgrade before any caller can search or reconcile. */
export function migrateMemoryIndex(db: ReturnType<typeof Database.Client>): void {
  db.transaction((tx) => {
    const state = tx.select().from(MemoryIndexMigrationTable).where(eq(MemoryIndexMigrationTable.version, 1)).get()
    if (!state) return
    const rows = tx.select({ id: MemoryFtsTable.id, body: MemoryFtsTable.body }).from(MemoryFtsTable).all()
    for (const row of rows) {
      tx.update(MemoryFtsTable)
        .set({ body_idx: buildSearchIndexText(row.body) })
        .where(eq(MemoryFtsTable.id, row.id))
        .run()
    }
    tx.delete(MemoryIndexMigrationTable).where(eq(MemoryIndexMigrationTable.version, 1)).run()
  }, { behavior: "immediate" })
}
