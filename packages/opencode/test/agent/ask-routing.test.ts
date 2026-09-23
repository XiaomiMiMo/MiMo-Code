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
  test("system agent (by actor) -> non-interactive", () => {
    const r = decideAskRouting({
      askActor: { agent: "checkpoint-writer", background: true, mode: "subagent" },
      sessionParentID: "ses_parent",
      agentName: "checkpoint-writer",
    })
    expect(r.interactive).toBe(false)
  })

  test("system agent (by name, no actor row) -> non-interactive", () => {
    const r = decideAskRouting({ sessionParentID: undefined, agentName: "dream" })
    expect(r.interactive).toBe(false)
  })

  test("background peer WITH parent -> non-interactive + inherit parent session", () => {
    // After Orchestrator removal this is the SAME shape that used to forward:
    // background + mode:peer + parentActorID + sessionParentID. It must now
    // inherit the parent's held grants and fail closed on ungranted paths —
    // never forward, never hang.
    const r = decideAskRouting({
      askActor: { agent: "build", background: true, mode: "peer", parentActorID: "main" },
      sessionParentID: "ses_parent",
      sessionID: "ses_peer",
      agentName: "build",
    })
    expect(r.interactive).toBe(false)
    expect(r.inherit).toEqual({ parentSessionID: "ses_parent" })
  })

  test("background subagent WITH parent (mode:subagent) -> non-interactive + inherit parent session", () => {
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: "ses_parent",
      sessionID: "ses_child",
      agentName: "general",
    })
    expect(r.interactive).toBe(false)
    expect(r.inherit).toEqual({ parentSessionID: "ses_parent" })
  })

  test("same-session background subagent (root session, no parentID) -> inherit current session", () => {
    // Actor spawn/run subagents share the parent session. Grants are
    // published under the current session id, not session.parentID.
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: undefined,
      sessionID: "ses_main",
      agentName: "general",
    })
    expect(r.interactive).toBe(false)
    expect(r.inherit).toEqual({ parentSessionID: "ses_main" })
  })

  test("background subagent with neither parent id nor sessionID -> non-interactive, no inherit (auto-deny)", () => {
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: undefined,
      agentName: "general",
    })
    expect(r.interactive).toBe(false)
    expect(r.inherit).toBeUndefined()
  })

  test("normal foreground (no actor, not system) -> interactive", () => {
    const r = decideAskRouting({ sessionParentID: undefined, agentName: "build" })
    expect(r.interactive).toBe(true)
  })

  test("peer WITHOUT a parent session -> not inherited (falls to background auto-deny)", () => {
    const r = decideAskRouting({
      askActor: { agent: "build", background: true, mode: "peer" },
      sessionParentID: undefined,
      sessionID: "ses_peer",
      agentName: "build",
    })
    expect(r.interactive).toBe(false)
    // sessionID fallback is subagent-only; a peer must not inherit its own session.
    expect(r.inherit).toBeUndefined()
  })
})
