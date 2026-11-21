import { test, expect } from "bun:test"
import {
  getLoopState,
  setLoopState,
  deleteLoopState,
  deleteAllLoopStates,
  listLoopStates,
  clearAllLoopStates,
  resetStrikes,
  incrementStrikes,
  getStrikes,
} from "../../src/cron/loop-state"

const seed = (session: string, startedAt: number) =>
  setLoopState({
    prompt: "shared",
    startedAt,
    lastScheduledFor: 2,
    keepaliveStrikes: 0,
    createdBySessionId: session,
  })

test("loops with identical prompts from different sessions keep independent entries", () => {
  clearAllLoopStates()
  seed("sess-a", 1)
  seed("sess-b", 3)
  const owners = listLoopStates()
    .filter((s) => s.prompt === "shared")
    .map((s) => s.createdBySessionId)
    .sort()
  expect(owners).toEqual(["sess-a", "sess-b"])
  expect(getLoopState("shared", "sess-a")?.startedAt).toBe(1)
  expect(getLoopState("shared", "sess-b")?.startedAt).toBe(3)
})

test("keepalive strikes are tracked per owning session for identical prompts", () => {
  clearAllLoopStates()
  seed("sess-a", 1)
  seed("sess-b", 3)
  expect(incrementStrikes("shared", "sess-a")).toBe(1)
  expect(incrementStrikes("shared", "sess-b")).toBe(1)
  expect(incrementStrikes("shared", "sess-a")).toBe(2)
  expect(getStrikes("shared", "sess-a")).toBe(2)
  expect(getStrikes("shared", "sess-b")).toBe(1)
  resetStrikes("shared", "sess-a")
  expect(getStrikes("shared", "sess-a")).toBe(0)
  expect(getStrikes("shared", "sess-b")).toBe(1)
})

test("deleting a loop state for one session keeps the other session's entry", () => {
  clearAllLoopStates()
  seed("sess-a", 1)
  seed("sess-b", 3)
  deleteLoopState("shared", "sess-a")
  expect(getLoopState("shared", "sess-a")).toBe(null)
  expect(getLoopState("shared", "sess-b")?.createdBySessionId).toBe("sess-b")
})

test("single-owner prompts still resolve without a session argument", () => {
  clearAllLoopStates()
  seed("sess-a", 1)
  expect(getLoopState("shared")?.createdBySessionId).toBe("sess-a")
  expect(getStrikes("shared")).toBe(0)
})

test("prompt-wide teardown removes every owner's entry (session-less endLoop)", () => {
  // endLoop without session_id removes ALL loop tasks for the prompt; state
  // teardown must be just as wide. If only one entry were deleted, the
  // orphaned row would let the keepalive sweep re-arm a loop that was ended.
  clearAllLoopStates()
  seed("sess-a", 1)
  seed("sess-b", 3)
  deleteAllLoopStates("shared")
  expect(getLoopState("shared", "sess-a")).toBe(null)
  expect(getLoopState("shared", "sess-b")).toBe(null)
  expect(listLoopStates().filter((s) => s.prompt === "shared")).toEqual([])
})
