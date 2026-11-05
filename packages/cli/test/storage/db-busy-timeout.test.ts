import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { getBusyTimeoutMs } from "../../src/storage/db"
import type { Attempt, AttemptResult } from "../fixture/sqlite-busy-worker"

const KEY = "MIMOCODE_SQLITE_BUSY_TIMEOUT_MS"
const original = process.env[KEY]

afterEach(() => {
  if (original === undefined) delete process.env[KEY]
  else process.env[KEY] = original
})

function isAttemptResult(value: unknown): value is AttemptResult {
  if (typeof value !== "object" || value === null) return false
  if (!("ok" in value) || typeof value.ok !== "boolean") return false
  if (!("elapsedMs" in value) || typeof value.elapsedMs !== "number") return false
  if ("code" in value && value.code !== undefined && typeof value.code !== "string") return false
  if ("message" in value && value.message !== undefined && typeof value.message !== "string") return false
  return true
}

function attempt(worker: Worker, input: Attempt) {
  return new Promise<AttemptResult>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      worker.removeEventListener("message", onMessage)
      if (isAttemptResult(event.data)) resolve(event.data)
      else reject(new Error("worker returned an unexpected result"))
    }
    worker.addEventListener("message", onMessage)
    worker.postMessage(input)
  })
}

describe("MIMOCODE_SQLITE_BUSY_TIMEOUT_MS", () => {
  test("resolves the effective busy timeout from the flag, defaulting to 30000 ms", () => {
    delete process.env[KEY]
    expect(getBusyTimeoutMs()).toBe(30000)

    for (const invalid of ["", "0", "-1", "1.5", "ten"]) {
      process.env[KEY] = invalid
      expect(getBusyTimeoutMs()).toBe(30000)
    }

    process.env[KEY] = "7500"
    expect(getBusyTimeoutMs()).toBe(7500)
  })
})

describe("busy timeout pragma", () => {
  test(
    "waits out a competing writer instead of failing immediately",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "mimo-busy-timeout-"))
      const file = path.join(dir, "busy.db")
      const holder = new Database(file, { create: true })
      const worker = new Worker(path.join(import.meta.dir, "../fixture/sqlite-busy-worker.ts"))
      try {
        holder.run("PRAGMA journal_mode = WAL")
        holder.run("CREATE TABLE t (id INTEGER PRIMARY KEY)")
        holder.run("BEGIN IMMEDIATE")
        holder.run("INSERT INTO t (id) VALUES (1)")

        // The holder commits from this thread's event loop while the worker's
        // connection sits in its busy handler, so the wait is a real one.
        const commit = setTimeout(() => holder.run("COMMIT"), 800)
        const waited = await attempt(worker, { file, id: 2, busyTimeoutMs: 2000 })
        clearTimeout(commit)
        expect(waited).toMatchObject({ ok: true })
        expect(waited.elapsedMs).toBeGreaterThanOrEqual(500)
        expect(waited.elapsedMs).toBeLessThan(2000)

        holder.run("BEGIN IMMEDIATE")
        holder.run("INSERT INTO t (id) VALUES (3)")
        const failed = await attempt(worker, { file, id: 4, busyTimeoutMs: 100 })
        holder.run("COMMIT")
        expect(failed.ok).toBe(false)
        expect(failed.code).toBe("SQLITE_BUSY")
        expect(failed.elapsedMs).toBeGreaterThanOrEqual(100)
        expect(failed.elapsedMs).toBeLessThan(1000)

        const rows = holder.query<{ id: number }, []>("SELECT id FROM t ORDER BY id").all()
        expect(rows.map((row) => row.id)).toEqual([1, 2, 3])
      } finally {
        holder.close()
        worker.terminate()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    10000,
  )
})
