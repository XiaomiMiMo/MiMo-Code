import { test, expect } from "bun:test"
import { Database } from "../../src/storage"
import { SessionTable } from "../../src/session/session.sql"

test("older clients can still select the inactive worktree marker after migrations", () => {
  expect(() => Database.use((db) => db.select({ marker: SessionTable.auto_worktree_hint_sent }).from(SessionTable).limit(1).all())).not.toThrow()
})
