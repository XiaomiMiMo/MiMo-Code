import { expect, test } from "bun:test"
import path from "node:path"
import { createTitleReader, createTitleReviewGate, runTitleSteps } from "../../src/session/title-runner"
import { Effect, Stream } from "effect"
import { tmpdir } from "../fixture/fixture"
import type { ModelMessage } from "ai"

test("title read rejects unreferenced, binary and directory resources and bounds text", async () => {
  await using tmp = await tmpdir({ init: async dir => {
    await Bun.write(path.join(dir, "text.txt"), "a".repeat(20000))
    await Bun.write(path.join(dir, "binary.bin"), new Uint8Array([0, 255, 12]))
  } })
  const text = path.join(tmp.path, "text.txt")
  const binary = path.join(tmp.path, "binary.bin")
  const read = createTitleReader([{ name: "text", path: text }, { name: "binary", path: binary }, { name: "directory", path: tmp.path }])
  await expect(read(path.join(tmp.path, "other.txt"))).rejects.toThrow("not authorized")
  await expect(read(binary)).rejects.toThrow()
  await expect(read(tmp.path)).rejects.toThrow()
  const fresh = createTitleReader([{ name: "text", path: text }])
  expect(Buffer.byteLength(await fresh(text))).toBe(16384)
  expect(Buffer.byteLength(await fresh(text))).toBe(16384)
  await expect(fresh(text)).rejects.toThrow("budget")
})

test("in-memory title steps carry read results into a second structured-output step", async () => {
  const messages: ModelMessage[] = [{ role: "user", content: "Summarize referenced text" }]
  let calls = 0
  const result = await Effect.runPromise(runTitleSteps(messages, current => {
    calls++
    if (calls === 1) return Stream.fromIterable([
      { type: "tool-call" as const, toolCallId: "read-1", toolName: "read", input: { path: "/fixture" } },
      { type: "tool-result" as const, toolCallId: "read-1", toolName: "read", input: { path: "/fixture" }, output: "Fixture topic" },
    ])
    expect(JSON.stringify(current)).toContain("Fixture topic")
    return Stream.fromIterable([{ type: "tool-call" as const, toolCallId: "out", toolName: "StructuredOutput", input: { title: "Fixture topic" } }])
  }, () => calls === 2 ? { title: "Fixture topic" } : undefined))
  expect(result).toEqual({ title: "Fixture topic" })
  expect(calls).toBe(2)
  expect(messages).toHaveLength(1)
})

test("review requires two distinct consecutive signaled turns at the same title revision", () => {
  const observe = createTitleReviewGate()
  expect(observe("s", "u1", 2, true)).toBe(false)
  expect(observe("s", "u1", 2, true)).toBe(false)
  expect(observe("s", "u2", 2, true)).toBe(true)
  expect(observe("s", "u3", 2, true)).toBe(false)
  expect(observe("s", "u4", 2, false)).toBe(false)
  expect(observe("s", "u5", 2, true)).toBe(false)
  expect(observe("s", "u6", 3, true)).toBe(false)
  expect(observe("s", "u7", 3, true)).toBe(true)
  expect(observe("other", "u8", 3, true)).toBe(false)
})

test("title loop stops at four steps and fails closed on read errors",  async () => {
  let calls = 0
  const output = await Effect.runPromise(runTitleSteps([], () => {
    calls++
    return Stream.fromIterable([{ type: "tool-call" as const, toolCallId: String(calls), toolName: "read", input: {} }])
  }, () => undefined))
  expect(output).toBeUndefined()
  expect(calls).toBe(4)
  expect(await Effect.runPromise(runTitleSteps([], () => Stream.fromIterable([{ type: "tool-error" as const }]), () => ({ title: "Do not accept" })))).toBeUndefined()
})
