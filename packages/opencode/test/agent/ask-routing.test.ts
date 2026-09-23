import { describe, expect, test } from "bun:test"
import {
  decideAskRouting,
  resolveInvalidOutputPolicy,
  SYSTEM_INVALID_OUTPUT_POLICIES,
  SYSTEM_SPAWNED_AGENT_TYPES,
} from "../../src/agent/config"

describe("invalid-output policy", () => {
  test("every system-spawned agent declares a policy", () => {
    expect(Object.keys(SYSTEM_INVALID_OUTPUT_POLICIES).sort()).toEqual([...SYSTEM_SPAWNED_AGENT_TYPES].sort())
  })

  test("system policy takes precedence over main agentID", () => {
    expect(resolveInvalidOutputPolicy({ agentName: "checkpoint-writer", agentID: "main" })).toBe("checkpoint")
    expect(resolveInvalidOutputPolicy({ agentName: "dream", agentID: "main" })).toBe("actor")
  })

  test("primary and ordinary actors use role-specific policies", () => {
    expect(resolveInvalidOutputPolicy({ agentName: "build", agentID: "main" })).toBe("primary")
    expect(resolveInvalidOutputPolicy({ agentName: "general", agentID: "general-1" })).toBe("actor")
  })
})

describe("decideAskRouting", () => {
  test("system agent (by actor) -> non-interactive without inheritance", () => {
    const r = decideAskRouting({
      askActor: { agent: "checkpoint-writer", background: true, mode: "subagent" },
      sessionParentID: "ses_parent",
      sessionID: "ses_main",
      agentName: "checkpoint-writer",
    })
    expect(r).toEqual({ interactive: false })
  })

  test("system agent (by name, no actor row) -> non-interactive", () => {
    const r = decideAskRouting({ sessionParentID: undefined, agentName: "dream" })
    expect(r).toEqual({ interactive: false })
  })

  test("background peer WITH parent -> non-interactive + inherit parent session", () => {
    const r = decideAskRouting({
      askActor: { agent: "build", background: true, mode: "peer", parentActorID: "main" },
      sessionParentID: "ses_parent",
      sessionID: "ses_peer",
      agentName: "build",
    })
    expect(r).toEqual({ interactive: false, inherit: { parentSessionID: "ses_parent" } })
  })

  test("background subagent WITH parent -> interactive + inherit parent session", () => {
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: "ses_parent",
      sessionID: "ses_child",
      agentName: "general",
    })
    expect(r).toEqual({ interactive: true, inherit: { parentSessionID: "ses_parent" } })
  })

  test("same-session background subagent -> interactive + inherit current session", () => {
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: undefined,
      sessionID: "ses_main",
      agentName: "general",
    })
    expect(r).toEqual({ interactive: true, inherit: { parentSessionID: "ses_main" } })
  })

  test("background subagent without session ids -> interactive, no inherit", () => {
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: undefined,
      agentName: "general",
    })
    expect(r).toEqual({ interactive: true })
  })

  test("normal foreground -> interactive", () => {
    const r = decideAskRouting({ sessionParentID: undefined, agentName: "build" })
    expect(r).toEqual({ interactive: true })
  })

  test("foreground actor -> interactive + inherit current session", () => {
    const r = decideAskRouting({
      askActor: { agent: "general", background: false, mode: "subagent" },
      sessionParentID: undefined,
      sessionID: "ses_main",
      agentName: "general",
    })
    expect(r).toEqual({ interactive: true, inherit: { parentSessionID: "ses_main" } })
  })

  test("peer WITHOUT a parent session -> non-interactive, no self-inherit", () => {
    const r = decideAskRouting({
      askActor: { agent: "build", background: true, mode: "peer" },
      sessionParentID: undefined,
      sessionID: "ses_peer",
      agentName: "build",
    })
    expect(r).toEqual({ interactive: false })
  })
})
