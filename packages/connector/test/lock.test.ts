import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { InstanceLock } from "../src/lock"

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "lock-"))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("instance lock", () => {
  test("only one holder at a time, and release lets the next one in", () =>
    withDir(async (dir) => {
      const file = path.join(dir, "state.lock")
      const first = new InstanceLock(file)
      const second = new InstanceLock(file)
      expect(await first.acquire()).toBe(true)
      expect(await second.acquire()).toBe(false)
      await first.release()
      expect(await second.acquire()).toBe(true)
    }))

  test("a lock left by a process that is gone is taken over", () =>
    withDir(async (dir) => {
      const file = path.join(dir, "state.lock")
      await writeFile(file, "999999:old")
      const lock = new InstanceLock(file, () => false)
      expect(await lock.acquire()).toBe(true)
      expect(await readFile(file, "utf8")).not.toBe("999999:old")
    }))

  test("a lock being written right now is respected", () =>
    withDir(async (dir) => {
      const file = path.join(dir, "state.lock")
      await writeFile(file, "")
      expect(await new InstanceLock(file).acquire()).toBe(false)
    }))

  test("release never removes someone else's lock", () =>
    withDir(async (dir) => {
      const file = path.join(dir, "state.lock")
      const lock = new InstanceLock(file)
      expect(await lock.acquire()).toBe(true)
      await writeFile(file, `${process.pid}:other`)
      await lock.release()
      expect(await readFile(file, "utf8")).toBe(`${process.pid}:other`)
    }))
})
