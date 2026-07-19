import { test, expect, beforeEach } from "bun:test"
import {
  getLoopState,
  setLoopState,
  deleteLoopState,
  listLoopStates,
  clearAllLoopStates,
  resetStrikes,
  incrementStrikes,
  getStrikes,
} from "@/cron/loop-state"

beforeEach(() => clearAllLoopStates())

test("set / get / delete roundtrip", () => {
  setLoopState({ prompt: "p1", startedAt: 1, lastScheduledFor: 2, keepaliveStrikes: 0 })
  expect(getLoopState("p1")).toEqual({
    prompt: "p1",
    startedAt: 1,
    lastScheduledFor: 2,
    keepaliveStrikes: 0,
  })
  deleteLoopState("p1")
  expect(getLoopState("p1")).toBe(null)
})

test("listLoopStates returns all entries", () => {
  setLoopState({ prompt: "a", startedAt: 1, lastScheduledFor: 2, keepaliveStrikes: 0 })
  setLoopState({ prompt: "b", startedAt: 3, lastScheduledFor: 4, keepaliveStrikes: 1 })
  expect(listLoopStates().map((s) => s.prompt).sort()).toEqual(["a", "b"])
})

test("resetStrikes on existing prompt sets to 0", () => {
  setLoopState({ prompt: "x", startedAt: 1, lastScheduledFor: 2, keepaliveStrikes: 3 })
  resetStrikes("x")
  expect(getStrikes("x")).toBe(0)
})

test("resetStrikes on missing prompt is a no-op", () => {
  resetStrikes("missing")
  expect(getLoopState("missing")).toBe(null)
})

test("incrementStrikes on existing increments by 1 and returns new value", () => {
  setLoopState({ prompt: "y", startedAt: 1, lastScheduledFor: 2, keepaliveStrikes: 1 })
  expect(incrementStrikes("y")).toBe(2)
  expect(getStrikes("y")).toBe(2)
})

test("incrementStrikes on missing returns 0", () => {
  expect(incrementStrikes("nope")).toBe(0)
})

test("clearAllLoopStates empties the store", () => {
  setLoopState({ prompt: "p", startedAt: 1, lastScheduledFor: 2, keepaliveStrikes: 0 })
  clearAllLoopStates()
  expect(listLoopStates()).toEqual([])
})
