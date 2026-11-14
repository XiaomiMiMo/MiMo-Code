import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"
import { readSessionCost } from "../../../src/session/cost"
import { SessionID } from "../../../src/session/schema"

const sqlite = new DatabaseSync(":memory:")
try {
  sqlite.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT, data TEXT NOT NULL);
    INSERT INTO session VALUES ('ses_example'), ('ses_empty'), ('ses_other');
  `)
  const insert = sqlite.prepare("INSERT INTO message VALUES (?, ?, ?, ?)")
  for (let i = 0; i < 101; i++) {
    insert.run(`msg_${i}`, "ses_example", "main", JSON.stringify({ role: "assistant", cost: 1 }))
  }
  insert.run("msg_actor", "ses_example", "general-1", JSON.stringify({ role: "assistant", cost: 2 }))
  insert.run("msg_other", "ses_other", "main", JSON.stringify({ role: "assistant", cost: 100 }))
  insert.run("msg_user", "ses_example", "main", JSON.stringify({ role: "user", cost: 1000 }))
  const db = drizzle({ client: sqlite })
  assert.deepEqual(readSessionCost(db, SessionID.make("ses_example")), { cost: 103 })
  assert.deepEqual(readSessionCost(db, SessionID.make("ses_empty")), { cost: 0 })
  assert.equal(readSessionCost(db, SessionID.make("ses_missing")), undefined)
  console.log(JSON.stringify({ ok: true, cost: 103 }))
} finally {
  sqlite.close()
}
