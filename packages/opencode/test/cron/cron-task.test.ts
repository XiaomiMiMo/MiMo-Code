import { test, expect } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  readCronTasks,
  writeCronTasks,
  addSessionCronTask,
  getSessionCronTasks,
  removeSessionCronTasks,
  findMissedTasks,
  getCronFilePath,
} from "@/cron/cron-task"

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e as Effect.Effect<A, E, never>)

test("getCronFilePath joins .mimocode/scheduled_tasks.json", () => {
  expect(getCronFilePath("/tmp/x").endsWith("/.mimocode/scheduled_tasks.json")).toBe(true)
})

test("readCronTasks returns [] on missing file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-"))
  expect(await run(readCronTasks(dir))).toEqual([])
  rmSync(dir, { recursive: true, force: true })
})

test("write then read roundtrips", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-"))
  const t = { id: "abc", cron: "*/5 * * * *", prompt: "hi", createdAt: 1, recurring: true }
  await run(writeCronTasks([t], dir))
  const back = await run(readCronTasks(dir))
  expect(back).toEqual([t])
  rmSync(dir, { recursive: true, force: true })
})

// Regression for PR #1479 finding #1: durable: true must survive round-trip.
// Previously stripRuntime deleted `durable` on write, so a file-loaded task
// came back with `durable: undefined` and the scheduler's cleanup branch
// mis-routed it through the session-store removal path — leaving the task on
// disk to re-fire every tick.
test("durable: true survives write/read round-trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-"))
  const t = {
    id: "d1",
    cron: "*/5 * * * *",
    prompt: "hi",
    createdAt: 1,
    recurring: true,
    durable: true,
  }
  await run(writeCronTasks([t], dir))
  const back = await run(readCronTasks(dir))
  expect(back[0]?.durable).toBe(true)
  rmSync(dir, { recursive: true, force: true })
})

test("session store add/get/remove", () => {
  addSessionCronTask({ id: "s1", cron: "*/5 * * * *", prompt: "x", createdAt: 1 })
  expect(getSessionCronTasks().find((t) => t.id === "s1")).toBeDefined()
  removeSessionCronTasks(["s1"])
  expect(getSessionCronTasks().find((t) => t.id === "s1")).toBeUndefined()
})

test("findMissedTasks returns one-shot past fire time, ignores recurring", () => {
  const past = { id: "p1", cron: "30 14 27 2 *", prompt: "x", createdAt: 0, recurring: false }
  const recurring = { id: "r1", cron: "*/5 * * * *", prompt: "x", createdAt: 0, recurring: true }
  const future = { id: "f1", cron: "30 14 27 2 *", prompt: "x", createdAt: Date.now() + 1e10, recurring: false }
  const now = Date.now()
  const missed = findMissedTasks([past, recurring, future], now)
  expect(missed.map((t) => t.id)).toEqual(["p1"])
})

test("malformed cron in file is silently dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-"))
  const fs = await import("fs/promises")
  await fs.mkdir(join(dir, ".mimocode"), { recursive: true })
  await fs.writeFile(
    getCronFilePath(dir),
    JSON.stringify({
      tasks: [
        { id: "ok", cron: "*/5 * * * *", prompt: "x", createdAt: 1 },
        { id: "bad", cron: "garbage", prompt: "x", createdAt: 2 },
      ],
    }),
  )
  const back = await run(readCronTasks(dir))
  expect(back.map((t) => t.id)).toEqual(["ok"])
  rmSync(dir, { recursive: true, force: true })
})

test("writeCronTasks drops tasks with malformed cron", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-"))
  const good = { id: "g1", cron: "*/5 * * * *", prompt: "ok", createdAt: 1 }
  const bad = { id: "b1", cron: "garbage", prompt: "no", createdAt: 2 }
  await run(writeCronTasks([good, bad as any], dir))
  const back = await run(readCronTasks(dir))
  expect(back.map((t) => t.id)).toEqual(["g1"])
  rmSync(dir, { recursive: true, force: true })
})
