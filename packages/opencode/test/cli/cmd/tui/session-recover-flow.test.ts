import { describe, expect, test } from "bun:test"
import {
  recoverErrorMessage,
  runSessionRecover,
  shouldClearRecoveryActiveOnError,
  shouldClearRecoveryActiveOnIdle,
  type RecoverCandidate,
} from "../../../../src/cli/cmd/tui/routes/session/recover-flow"

// [C006] TUI /recover entry automation against real SDK throwOnError shapes
// (parsed JSON objects, not Error instances).

const parentUser: RecoverCandidate = {
  kind: "parent-user",
  userMessageID: "msg_u2",
  created: 2,
}
const assistant: RecoverCandidate = {
  kind: "assistant",
  assistantMessageID: "msg_a1",
  parentMessageID: "msg_u1",
  created: 1,
}

/** Real SDK throwOnError payload shapes (client.gen.ts JSON.parse of response body). */
const sdkNotFound = {
  data: {
    name: "NotFoundError",
    data: { message: "No resumable trailing user found for message msg_u2 (stale at runner admission)" },
  },
}
const sdkBusy = {
  data: {
    name: "BusyError",
    data: { message: "Session is busy" },
  },
}

function deps(overrides: Partial<Parameters<typeof runSessionRecover>[0]> = {}) {
  const calls: { resumeUser: string[]; resumeAssistant: string[]; active: string[] } = {
    resumeUser: [],
    resumeAssistant: [],
    active: [],
  }
  const base = {
    listCandidates: async () => [parentUser] as RecoverCandidate[],
    resumeUser: async (input: { userMessageID: string }) => {
      calls.resumeUser.push(input.userMessageID)
    },
    resumeAssistant: async (input: { assistantMessageID: string }) => {
      calls.resumeAssistant.push(input.assistantMessageID)
    },
    setActive: (id: string) => {
      calls.active.push(id)
    },
    ...overrides,
  }
  return { calls, base }
}

describe("runSessionRecover (TUI /recover entry)", () => {
  test("parent-user 202: resumeUser + active badge + started", async () => {
    const { calls, base } = deps()
    const out = await runSessionRecover(base)
    expect(out).toEqual({ type: "started", kind: "parent-user", id: "msg_u2" })
    expect(calls.resumeUser).toEqual(["msg_u2"])
    expect(calls.resumeAssistant).toEqual([])
    expect(calls.active).toEqual(["msg_u2"])
  })

  test("assistant recovery regression: explicit id selects assistant path", async () => {
    const { calls, base } = deps({
      listCandidates: async () => [parentUser, assistant],
      assistantMessageID: "msg_a1",
    })
    const out = await runSessionRecover(base)
    expect(out).toEqual({ type: "started", kind: "assistant", id: "msg_a1" })
    expect(calls.resumeAssistant).toEqual(["msg_a1"])
    expect(calls.resumeUser).toEqual([])
    expect(calls.active).toEqual(["msg_a1"])
  })

  test("no candidate → none, no dispatch", async () => {
    const { calls, base } = deps({ listCandidates: async () => [] })
    const out = await runSessionRecover(base)
    expect(out).toEqual({ type: "none" })
    expect(calls.resumeUser).toEqual([])
    expect(calls.active).toEqual([])
  })

  test("busy/retry status short-circuits to busy toast path", async () => {
    const { calls, base } = deps({ status: { type: "busy" } })
    expect(await runSessionRecover(base)).toEqual({ type: "busy" })
    const { calls: c2, base: b2 } = deps({ status: { type: "retry" } })
    expect(await runSessionRecover(b2)).toEqual({ type: "busy" })
    expect(calls.resumeUser).toEqual([])
    expect(c2.resumeUser).toEqual([])
  })

  test("real SDK 404 JSON reject maps to human message, no active badge", async () => {
    const { calls, base } = deps({
      resumeUser: async () => {
        throw sdkNotFound
      },
    })
    const out = await runSessionRecover(base)
    expect(out.type).toBe("error")
    if (out.type === "error") {
      expect(out.variant).toBe("error")
      expect(out.message).toContain("stale at runner admission")
      expect(out.message).not.toContain("[object Object]")
    }
    expect(calls.active).toEqual([])
  })

  test("real SDK 409 BusyError JSON maps to busy variant", async () => {
    const { base } = deps({
      resumeUser: async () => {
        throw sdkBusy
      },
    })
    const out = await runSessionRecover(base)
    expect(out.type).toBe("error")
    if (out.type === "error") {
      expect(out.variant).toBe("busy")
      expect(out.message).toBe("Session is busy")
    }
  })

  test("recoverErrorMessage maps structured SDK shapes", () => {
    expect(recoverErrorMessage(sdkBusy).variant).toBe("busy")
    expect(recoverErrorMessage(sdkNotFound).message).toContain("stale at runner admission")
    expect(recoverErrorMessage(sdkNotFound).variant).toBe("error")
    expect(recoverErrorMessage({ data: { name: "NotFoundError", data: { message: "x" } }, statusCode: 409 }).variant).toBe("busy")
    expect(recoverErrorMessage(new Error("conflict 409")).variant).toBe("busy")
    expect(recoverErrorMessage(new Error("stale")).variant).toBe("error")
    expect(recoverErrorMessage("plain string 409").variant).toBe("busy")
  })
})

describe("session_recovery_active clear (idle/error)", () => {
  test("idle clears the badge", () => {
    expect(shouldClearRecoveryActiveOnIdle({ type: "idle" })).toBe(true)
    expect(shouldClearRecoveryActiveOnIdle({ type: "busy" })).toBe(false)
  })

  test("error clears only when not mid-turn", () => {
    expect(shouldClearRecoveryActiveOnError(undefined)).toBe(true)
    expect(shouldClearRecoveryActiveOnError({ type: "idle" })).toBe(true)
    expect(shouldClearRecoveryActiveOnError({ type: "busy" })).toBe(false)
    expect(shouldClearRecoveryActiveOnError({ type: "retry" })).toBe(false)
  })
})
