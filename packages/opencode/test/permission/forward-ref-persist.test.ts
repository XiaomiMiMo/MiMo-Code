import { afterEach, describe, expect, test } from "bun:test"
import { forwardRef } from "../../src/permission/permission-forward-ref"
import { PermissionGrantTable } from "../../src/permission/permission.sql"
import { Database, eq } from "../../src/storage"

// Gap B regression: a `grant-approval all` (or specific child) by a parent
// orchestrator must be honored by an isolated (separate-process) child created
// AFTER the grant, AND survive restart. Separate processes do NOT share the
// in-memory `grants` map — they share the on-disk SQLite `permission_grant`
// table. These tests exercise the PERSISTED path by asserting against the DB
// and by proving grantAllowed reads from the DB even when the in-memory cache
// has no entry for the parent (which is exactly a child process's situation).

function clearDb(parentSessionID: string) {
  Database.use((db) => db.delete(PermissionGrantTable).where(eq(PermissionGrantTable.parent_session_id, parentSessionID as any)).run())
}

describe("forwardRef persistence (Gap B)", () => {
  afterEach(() => {
    for (const p of ["pPersist", "pStar", "pChild", "pRestart"]) {
      forwardRef.clearGrantsForParent(p)
    }
  })

  test("setGrant writes through to SQLite", () => {
    forwardRef.setGrant("pPersist", "childA")
    const rows = Database.use((db) =>
      db.select().from(PermissionGrantTable).where(eq(PermissionGrantTable.parent_session_id, "pPersist" as any)).all(),
    )
    expect(rows.map((r) => r.target)).toContain("childA")
  })

  test("a parent's persisted grant is visible to a child lookup via the DB (cache miss)", () => {
    // Simulate the PARENT process persisting the grant, then a fresh CHILD
    // process whose in-memory map is empty: write straight to the DB (no
    // setGrant → no in-memory cache entry), then look it up.
    clearDb("pChild")
    Database.use((db) =>
      db.insert(PermissionGrantTable).values({ parent_session_id: "pChild" as any, target: "childXYZ", created_at: Date.now() }).run(),
    )
    // grantAllowed must consult the DB (there is no in-memory grant for pChild).
    expect(forwardRef.grantAllowed("pChild", "childXYZ")).toBe(true)
    expect(forwardRef.grantAllowed("pChild", "someOtherChild")).toBe(false)
  })

  test("'*' persisted grant matches a child created AFTER the grant, via the DB (cache miss)", () => {
    clearDb("pStar")
    // Parent persisted `grant-approval all` (target "*") BEFORE any child exists.
    Database.use((db) =>
      db.insert(PermissionGrantTable).values({ parent_session_id: "pStar" as any, target: "*", created_at: Date.now() }).run(),
    )
    // A child created afterwards, in a separate process (empty in-memory map),
    // must be auto-approved by the persisted "*".
    expect(forwardRef.grantAllowed("pStar", "childCreatedLater")).toBe(true)
    expect(forwardRef.grantAllowed("pStar", "anotherLateChild")).toBe(true)
    // Never leaks to a DIFFERENT parent session (scoped, not global).
    expect(forwardRef.grantAllowed("pUnrelated", "childCreatedLater")).toBe(false)
  })

  test("grant survives 'restart' — a fresh read finds the persisted row", () => {
    forwardRef.setGrant("pRestart", "*")
    // Drop the in-memory cache to simulate a process restart; the DB row remains.
    forwardRef.grants.delete("pRestart")
    expect(forwardRef.grantAllowed("pRestart", "childAfterRestart")).toBe(true)
  })

  test("clearGrantsForParent removes the persisted row too", () => {
    forwardRef.setGrant("pStar", "*")
    forwardRef.clearGrantsForParent("pStar")
    const rows = Database.use((db) =>
      db.select().from(PermissionGrantTable).where(eq(PermissionGrantTable.parent_session_id, "pStar" as any)).all(),
    )
    expect(rows.length).toBe(0)
    expect(forwardRef.grantAllowed("pStar", "anyChild")).toBe(false)
  })
})
