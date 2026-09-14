import { eq } from "drizzle-orm"
import { Database } from "../../../src/storage"
import { migrateIndexBatch, stopIndexMigration } from "../../../src/history/migration"
import { HistoryIndexMigrationTable } from "../../../src/history/fts.sql"

const db = Database.Client()
stopIndexMigration(db)
const before = db.select().from(HistoryIndexMigrationTable).where(eq(HistoryIndexMigrationTable.version, 3)).get()
let batches = 0
const limit = Number(process.env.HISTORY_BATCH_LIMIT ?? Infinity)
while (batches < limit && migrateIndexBatch(db)) batches++
const after = db.select().from(HistoryIndexMigrationTable).where(eq(HistoryIndexMigrationTable.version, 3)).get()
console.log(JSON.stringify({ before, after, batches }))
Database.close()
