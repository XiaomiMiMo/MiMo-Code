import { Effect } from "effect"
import { Database } from "../../../src/storage"
import { backfillOnce } from "../../../src/history/backfill"
import { DEFAULT_KINDS } from "../../../src/history/extract"
import { HistoryBackfillTable } from "../../../src/history/fts.sql"

const db = Database.Client()
let scans = 0
db.select = new Proxy(db.select, {
  apply(target, self, args) {
    const fields = args[0]
    if (fields && "project_id" in fields) scans++
    if (fields && "data" in fields && process.env.HISTORY_FAIL_SCAN === "1") throw new Error("interrupted scan")
    return Reflect.apply(target, self, args)
  },
})
await Effect.runPromise(backfillOnce(new Set(DEFAULT_KINDS)))
await Effect.runPromise(backfillOnce(new Set(["reasoning"])))
console.log(JSON.stringify({ scans, completed: db.select().from(HistoryBackfillTable).get()?.completed }))
Database.close()
