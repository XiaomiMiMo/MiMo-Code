import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { MemoryFtsTable } from "../../src/memory/fts.sql"
import { Database } from "../../src/storage"

/**
 * Reset the process-wide memory state: the memory root on disk and every
 * `memory_fts` row. `bun test` shares both across all files in a shard, and
 * other suites (checkpoint, session) leave indexed memory files behind, so a
 * memory test must reset both halves before it runs — clearing only one leaves
 * rows that the next reconcile reports as pruned.
 */
export async function resetMemory(): Promise<void> {
  await fs.rm(path.join(Global.Path.data, "memory"), { recursive: true, force: true })
  Database.use((db) => db.delete(MemoryFtsTable).run())
}
