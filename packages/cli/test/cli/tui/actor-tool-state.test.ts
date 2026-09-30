import { describe, expect, test } from "bun:test"
import { isActorToolRunning } from "@/cli/cmd/tui/routes/session/actor-tool-state"

describe("actor tool running state", () => {
  test("keeps a completed spawn active while its background actor runs", () => {
    expect(isActorToolRunning({ partStatus: "completed", action: "spawn", actorStatus: "running" })).toBe(true)
    expect(isActorToolRunning({ partStatus: "completed", action: "spawn", actorStatus: "pending" })).toBe(true)
  })

  test("does not reactivate completed snapshot and blocking actions on a later actor turn", () => {
    for (const action of ["run", "wait", "status", "cancel"]) {
      expect(isActorToolRunning({ partStatus: "completed", action, actorStatus: "running" })).toBe(false)
    }
  })

  test("uses the tool part state while an action is still executing", () => {
    expect(isActorToolRunning({ partStatus: "running", action: "wait", actorStatus: "idle" })).toBe(true)
    expect(isActorToolRunning({ partStatus: "running", action: "status" })).toBe(true)
    expect(isActorToolRunning({ partStatus: "completed", action: "spawn", actorStatus: "idle" })).toBe(false)
  })
})
