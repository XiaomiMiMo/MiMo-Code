import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "../../src/storage"
import type { UpgradeAttempt, UpgradeResult } from "../fixture/sqlite-upgrade-worker"

type Behavior = "deferred" | "immediate" | "exclusive"

// Records which BEGIN variant bun:sqlite is asked for by wrapping the client's
// transaction factory for the duration of one call.
function beginsWith(run: () => void) {
  const client = Database.Client().$client
  const original = client.transaction
  const seen: string[] = []
  client.transaction = function (this: typeof client, fn: Parameters<typeof original>[0]) {
    const wrapped = original.call(this, fn)
    return new Proxy(wrapped, {
      get(target, prop, receiver) {
        if (prop === "deferred" || prop === "immediate" || prop === "exclusive") seen.push(prop)
        return Reflect.get(target, prop, receiver)
      },
    })
  } as typeof original
  try {
    run()
  } finally {
    client.transaction = original
  }
  return seen
}

function isUpgradeResult(value: unknown): value is UpgradeResult {
  if (typeof value !== "object" || value === null) return false
  if (!("ok" in value) || typeof value.ok !== "boolean") return false
  if (!("elapsedMs" in value) || typeof value.elapsedMs !== "number") return false
  return true
}

function attempt(worker: Worker, input: UpgradeAttempt) {
  return new Promise<UpgradeResult>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      worker.removeEventListener("message", onMessage)
      if (isUpgradeResult(event.data)) resolve(event.data)
      else reject(new Error("worker returned an unexpected result"))
    }
    worker.addEventListener("message", onMessage)
    worker.postMessage(input)
  })
}

describe("Database.transaction behavior", () => {
  test("takes the write lock at BEGIN unless the caller asks otherwise", () => {
    expect(beginsWith(() => Database.transaction(() => 1))).toEqual(["immediate"])
    for (const behavior of ["deferred", "immediate", "exclusive"] satisfies Behavior[]) {
      expect(beginsWith(() => Database.transaction(() => 1, { behavior }))).toEqual([behavior])
    }
  })

  test("a nested call joins the open transaction without a second BEGIN", () => {
    const seen = beginsWith(() => Database.transaction(() => Database.transaction(() => 1)))
    expect(seen).toEqual(["immediate"])
  })
})

describe("read-then-write transaction under a competing writer", () => {
  test(
    "deferred fails at once despite the busy timeout; immediate waits for the lock",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "mimo-tx-upgrade-"))
      const file = path.join(dir, "upgrade.db")
      const holder = new SQLite(file, { create: true })
      const worker = new Worker(path.join(import.meta.dir, "../fixture/sqlite-upgrade-worker.ts"))
      try {
        holder.run("PRAGMA journal_mode = WAL")
        holder.run("CREATE TABLE t (id INTEGER PRIMARY KEY)")

        holder.run("BEGIN IMMEDIATE")
        holder.run("INSERT INTO t (id) VALUES (1)")
        const releaseDeferred = setTimeout(() => holder.run("COMMIT"), 800)
        const deferred = await attempt(worker, { file, id: 2, busyTimeoutMs: 2000, behavior: "deferred" })
        clearTimeout(releaseDeferred)
        if (holder.inTransaction) holder.run("COMMIT")
        expect(deferred.ok).toBe(false)
        expect(deferred.code).toMatch(/^SQLITE_BUSY/)
        expect(deferred.elapsedMs).toBeLessThan(500)

        holder.run("BEGIN IMMEDIATE")
        holder.run("INSERT INTO t (id) VALUES (3)")
        const releaseImmediate = setTimeout(() => holder.run("COMMIT"), 800)
        const immediate = await attempt(worker, { file, id: 4, busyTimeoutMs: 2000, behavior: "immediate" })
        clearTimeout(releaseImmediate)
        expect(immediate).toMatchObject({ ok: true })
        expect(immediate.elapsedMs).toBeGreaterThanOrEqual(500)
        expect(immediate.elapsedMs).toBeLessThan(2000)

        const rows = holder.query<{ id: number }, []>("SELECT id FROM t ORDER BY id").all()
        expect(rows.map((row) => row.id)).toEqual([1, 3, 4])
      } finally {
        holder.close()
        worker.terminate()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    10000,
  )
})
