import { test, expect } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { tryAcquireSchedulerLock, releaseSchedulerLock } from "@/cron/cron-lock"

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e as Effect.Effect<A, E, never>)
const fresh = () => mkdtempSync(join(tmpdir(), "cron-lock-"))
const cleanup = (d: string) => rmSync(d, { recursive: true, force: true })

test("acquire returns true on fresh dir and writes lock file", async () => {
  const dir = fresh()
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(true)
  expect(existsSync(join(dir, ".mimocode", ".cron-lock"))).toBe(true)
  cleanup(dir)
})

test("acquire is idempotent for the same process", async () => {
  const dir = fresh()
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(true)
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(true)
  cleanup(dir)
})

test("acquire returns false when a different live pid owns the lock", async () => {
  const dir = fresh()
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  writeFileSync(join(dir, ".mimocode", ".cron-lock"), JSON.stringify({ pid: 1, startedAt: 0 }))
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(false)
  cleanup(dir)
})

test("acquire takes over when previous owner is dead (ESRCH)", async () => {
  const dir = fresh()
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  writeFileSync(join(dir, ".mimocode", ".cron-lock"), JSON.stringify({ pid: 999_999, startedAt: 0 }))
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(true)
  cleanup(dir)
})

test("acquire overwrites malformed lock file", async () => {
  const dir = fresh()
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  writeFileSync(join(dir, ".mimocode", ".cron-lock"), "garbage{not json")
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(true)
  cleanup(dir)
})

test("release removes our own lock", async () => {
  const dir = fresh()
  await run(tryAcquireSchedulerLock({ dir }))
  await run(releaseSchedulerLock({ dir }))
  expect(existsSync(join(dir, ".mimocode", ".cron-lock"))).toBe(false)
  cleanup(dir)
})

test("release no-ops if lock file is missing", async () => {
  const dir = fresh()
  await run(releaseSchedulerLock({ dir }))
  cleanup(dir)
})
