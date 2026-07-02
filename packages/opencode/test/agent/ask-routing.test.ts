import { describe, expect, test } from "bun:test"
import { decideAskRouting } from "../../src/agent/config"

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

  test("compose subagent (background + mode:subagent) -> non-interactive, no forward", () => {
    const r = decideAskRouting({
      askActor: { agent: "general", background: true, mode: "subagent" },
      sessionParentID: "ses_parent",
      agentName: "general",
    })
    expect(r.interactive).toBe(false)
    expect(r.forward).toBeUndefined()
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
})
