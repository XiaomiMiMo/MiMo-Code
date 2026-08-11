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
  test("system agent (by actor) -> non-interactive, no forward", () => {
    const r = decideAskRouting({
      askActor: { agent: "checkpoint-writer", background: true, mode: "subagent" },
      sessionParentID: "ses_parent",
      agentName: "checkpoint-writer",
    })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
  })

  test("system agent (by name, no actor row) -> non-interactive", () => {
    const r = decideAskRouting({ sessionParentID: undefined, agentName: "dream" })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
  })

  test("orchestrator peer (background + mode:peer + parent) -> forward", () => {
    const r = decideAskRouting({
      askActor: { agent: "build", background: true, mode: "peer", parentActorID: "main" },
      sessionParentID: "ses_orchestrator",
      agentName: "build",
    })
    expect(r.interactive).toBe(true)
    expect(r.forward).toEqual({ parentSessionID: "ses_orchestrator" })
  })

  test("background subagent WITH parent (mode:subagent) -> non-interactive + inherit", () => {
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: "ses_parent",
      agentName: "general",
    })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
    expect(r.inherit).toEqual({ parentSessionID: "ses_parent" })
  })

  test("background subagent WITHOUT parent -> non-interactive, no inherit (auto-deny)", () => {
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: undefined,
      agentName: "general",
    })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
    expect(r.inherit).toBeUndefined()
  })

  test("normal foreground (no actor, not system) -> interactive, no forward", () => {
    const r = decideAskRouting({ sessionParentID: undefined, agentName: "build" })
    expect(r.interactive).toBe(true)
    expect(r.forward).toBeUndefined()
  })

  test("peer WITHOUT a parent -> not forwarded (falls to background auto-deny)", () => {
    const r = decideAskRouting({
      askActor: { agent: "build", background: true, mode: "peer" },
      sessionParentID: undefined,
      agentName: "build",
    })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
  })

  test("orchestrator disabled (flag off) -> peer does NOT forward, auto-denies", () => {
    const r = decideAskRouting({
      askActor: { agent: "build", background: true, mode: "peer", parentActorID: "main" },
      sessionParentID: "ses_orchestrator",
      agentName: "build",
      orchestratorEnabled: false,
    })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
  })
})
