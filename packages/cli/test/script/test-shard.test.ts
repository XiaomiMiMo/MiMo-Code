import { expect, test } from "bun:test"
import { $ } from "bun"
import path from "node:path"
import { assign, weightsFromJUnit } from "../../script/test-shard"

const script = path.join(import.meta.dir, "../../script/test-shard.ts")

test("every file lands in exactly one shard and heavy files spread out", () => {
  const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts", "test/e.test.ts"]
  const shards = assign(files, 2, {
    "test/a.test.ts": 10,
    "test/b.test.ts": 9,
    "test/c.test.ts": 2,
    "test/d.test.ts": 1,
  })
  expect(shards.flatMap((s) => s.files).sort()).toEqual(files)
  // Unweighted e.test.ts counts as 1s; ties go to the lowest shard index.
  expect(shards.map((s) => s.files)).toEqual([
    ["test/a.test.ts", "test/d.test.ts", "test/e.test.ts"],
    ["test/b.test.ts", "test/c.test.ts"],
  ])
  expect(shards.map((s) => s.load)).toEqual([12, 11])
})

test("near-zero files are floored so they spread across shards", () => {
  const files = Array.from({ length: 4 }, (_, i) => `test/z${i}.test.ts`)
  const shards = assign(files, 2, Object.fromEntries(files.map((f) => [f, 0])))
  expect(shards.map((s) => s.files.length)).toEqual([2, 2])
})

test("assignment does not depend on input order", () => {
  const files = Array.from({ length: 20 }, (_, i) => `test/f${i}.test.ts`)
  const weights = Object.fromEntries(files.map((f, i) => [f, (i * 7) % 5]))
  expect(assign([...files].reverse(), 3, weights)).toEqual(assign(files, 3, weights))
})

test("weights average per-file JUnit time across reports", () => {
  const report = (a: number, b: number) =>
    `<testsuites><testcase name="x" file="test/a.test.ts" time="${a}" /><testcase name="y" file="test/a.test.ts" time="${b}" /><testcase name="z" file="test/b.test.ts" time="1.04" /></testsuites>`
  expect(weightsFromJUnit([report(1, 2), report(3, 4)])).toEqual({ "test/a.test.ts": 5, "test/b.test.ts": 1 })
})

test("reserved seconds keep files off shards that already run isolated suites", () => {
  const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]
  const shards = assign(files, 2, { "test/a.test.ts": 5, "test/b.test.ts": 5, "test/c.test.ts": 5 }, [10, 0])
  expect(shards.map((s) => s.files)).toEqual([["test/c.test.ts"], ["test/a.test.ts", "test/b.test.ts"]])
  expect(shards.map((s) => s.load)).toEqual([15, 10])
})

test("the CLI prints one shard of the stdin file list", async () => {
  const input = () => new Response("test/x-unknown-2.test.ts\ntest/x-unknown-1.test.ts\n")
  expect(await $`bun ${script} 1 2 < ${input()}`.text()).toBe("test/x-unknown-1.test.ts\n")
  expect(await $`bun ${script} 2 2 < ${input()}`.text()).toBe("test/x-unknown-2.test.ts\n")
  expect(await $`bun ${script} 2 2 --reserve 0,5 < ${input()}`.text()).toBe("")
  const exitCode = (args: string[]) =>
    $`bun ${script} ${args} < ${input()}`
      .nothrow()
      .quiet()
      .then((r) => r.exitCode)
  for (const bad of [
    ["3", "2"],
    ["1", "2", "extra"],
    ["1", "2", "--reserve"],
    ["1", "2", "--reserve", ""],
    ["1", "2", "--reserve", "1,,2"],
    ["1", "2", "--reserve", "1,x"],
    ["1", "2", "--reserve", "1,2,3"],
    ["1", "2", "--reserve", "1", "extra"],
  ])
    expect(await exitCode(bad)).not.toBe(0)
})
