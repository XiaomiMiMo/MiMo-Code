import { describe, expect, test } from "bun:test"
import {
  actorToolBody,
  actorToolCompleteKey,
  actorToolLabel,
  actorToolOutcomeFailed,
  actorToolPendingLabel,
  isActorToolRunning,
} from "@/cli/cmd/tui/routes/session/actor-tool-state"
import { Locale } from "@/util"

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

describe("actor tool pending label", () => {
  test("does not call every action a delegation", () => {
    expect(actorToolPendingLabel("send")).toBe("Sending message...")
    expect(actorToolPendingLabel("wait")).toBe("Waiting...")
    expect(actorToolPendingLabel("status")).toBe("Checking status...")
    expect(actorToolPendingLabel("cancel")).toBe("Cancelling...")
    expect(actorToolPendingLabel("models")).toBe("Listing models...")
    expect(actorToolPendingLabel("spawn")).toBe("Delegating...")
    expect(actorToolPendingLabel("run")).toBe("Delegating...")
    expect(actorToolPendingLabel(undefined)).toBe("Delegating...")
  })
})

describe("actor tool complete key", () => {
  test("send leaves the pending fallback via to_actor_id, not description", () => {
    // Regression: actor send has no description field. Falling back to
    // description alone left InlineTool on "~ Delegating..." forever.
    expect(actorToolCompleteKey({ action: "send", toActorId: "general-2" })).toBe("general-2")
    expect(actorToolCompleteKey({ action: "send", toActorId: "general-2" })).toBeTruthy()
    expect(actorToolCompleteKey({ action: "send", title: "Sent to general-2" })).toBe("Sent to general-2")
    expect(actorToolCompleteKey({ action: "send", toActorId: "general-2", description: "ignored" })).toBe("ignored")
  })

  test("snapshot actions key off actor_id when no description is present", () => {
    for (const action of ["wait", "status", "cancel"]) {
      expect(actorToolCompleteKey({ action, actorId: "explore-1" })).toBe("explore-1")
      expect(actorToolCompleteKey({ action, title: "Actor wait: completed" })).toBe("Actor wait: completed")
    }
    expect(actorToolCompleteKey({ action: "models", title: "Available models" })).toBe("Available models")
    expect(actorToolCompleteKey({ action: "models" })).toBe(true)
  })

  test("spawn/run still prefer description and stay pending without one", () => {
    expect(actorToolCompleteKey({ action: "spawn", description: "Review fix" })).toBe("Review fix")
    expect(actorToolCompleteKey({ action: "run", description: "Tiny lookup" })).toBe("Tiny lookup")
    expect(actorToolCompleteKey({ action: "spawn" })).toBeUndefined()
    expect(actorToolCompleteKey({ action: "run" })).toBeUndefined()
  })
})

describe("actor tool body", () => {
  test("send matches wait's Label — actor desc shape", () => {
    // Desktop: "Send message to subtask" / "Sending message to subtask".
    // TUI wait: `Waiting for — ${desc}` / `Waited for — ${desc}`.
    expect(
      actorToolBody({
        action: "send",
        partStatus: "running",
        actorDescription: "Review final unmount-only footer fix",
      }),
    ).toBe("Sending message to — Review final unmount-only footer fix")
    expect(
      actorToolBody({
        action: "send",
        partStatus: "completed",
        actorDescription: "Review final unmount-only footer fix",
      }),
    ).toBe("Sent message to — Review final unmount-only footer fix")
    // No registry description yet — fall back to to_actor_id, still same shape.
    expect(actorToolBody({ action: "send", partStatus: "completed", toActorId: "general-2" })).toBe(
      "Sent message to — general-2",
    )
  })

  test("wait/cancel/status fall back to actor id when no description exists", () => {
    expect(actorToolBody({ action: "wait", partStatus: "running", actorId: "explore-1" })).toBe(
      "Waiting for — explore-1",
    )
    expect(actorToolBody({ action: "wait", partStatus: "completed", description: "Review fix" })).toBe(
      "Waited for — Review fix",
    )
    expect(actorToolBody({ action: "cancel", partStatus: "running", description: "Review fix" })).toBe(
      "Cancelling — Review fix",
    )
    expect(actorToolBody({ action: "status", partStatus: "completed", actorId: "explore-1" })).toBe(
      "Status — explore-1",
    )
    expect(actorToolBody({ action: "models", partStatus: "completed" })).toBe("List models")
  })

  test("spawn/run keep the description header shape", () => {
    // TUI callers pass Locale.titlecase(subagent_type) through as subagentType.
    expect(
      actorToolBody({ action: "spawn", partStatus: "completed", description: "Review fix", subagentType: "General" }),
    ).toBe("Background General Task — Review fix")
    expect(
      actorToolBody({ action: "run", partStatus: "running", description: "Tiny lookup", subagentType: "Explore" }),
    ).toBe("Explore Task — Tiny lookup")
  })

  test("does not claim success when the tool failed", () => {
    // Regression from review: send can finish with a completed tool state and
    // title "Send failed: …" — past-tense "Sent message to" must not cover that.
    expect(actorToolOutcomeFailed({ partStatus: "error" })).toBe(true)
    expect(actorToolOutcomeFailed({ partStatus: "completed", title: "Send failed: receiver not found" })).toBe(true)
    expect(actorToolOutcomeFailed({ partStatus: "completed", title: "Sent to general-2" })).toBe(false)
    expect(actorToolOutcomeFailed({ partStatus: "completed", title: "Sent message to general-2" })).toBe(false)
    // Target name must not flip a successful send into a failure.
    expect(actorToolOutcomeFailed({ partStatus: "completed", title: "Sent to failed-agent" })).toBe(false)
    expect(actorToolOutcomeFailed({ partStatus: "running" })).toBe(false)

    expect(
      actorToolBody({
        action: "send",
        partStatus: "completed",
        actorDescription: "Review fix",
        title: "Send failed: receiver not found",
      }),
    ).toBe("Send message failed — Review fix")
    expect(
      actorToolBody({
        action: "send",
        partStatus: "error",
        toActorId: "general-2",
      }),
    ).toBe("Send message failed — general-2")
    expect(actorToolBody({ action: "wait", partStatus: "error", description: "Review fix" })).toBe(
      "Wait failed — Review fix",
    )
    expect(actorToolBody({ action: "cancel", partStatus: "error", actorId: "explore-1" })).toBe(
      "Cancel failed — explore-1",
    )
  })

  test("non-success wait/cancel terminals are not success past-tense", () => {
    // Titles ActorTool.execute emits without the word "fail".
    for (const title of [
      "Actor wait: timeout",
      "Actor wait: interrupted by user message",
      "Actor wait: unknown",
      "Actor run: timeout",
      "Actor run: interrupted by user message",
      "Actor status: unknown",
      "Actor cancel: unknown",
      "Actor wait: idle/failed",
    ]) {
      expect(actorToolOutcomeFailed({ partStatus: "completed", title })).toBe(true)
    }
    for (const title of ["Actor wait: idle", "Actor wait: idle/success", "Actor cancel: cancelled", "Actor cancel: idle"]) {
      expect(actorToolOutcomeFailed({ partStatus: "completed", title })).toBe(false)
    }

    // Same `Label — desc` shape as wait — not the raw tool title.
    expect(
      actorToolBody({
        action: "wait",
        partStatus: "completed",
        actorDescription: "Review fix",
        title: "Actor wait: timeout",
      }),
    ).toBe("Wait failed — Review fix")
    expect(
      actorToolBody({
        action: "cancel",
        partStatus: "completed",
        actorId: "explore-1",
        title: "Actor cancel: unknown",
      }),
    ).toBe("Cancel failed — explore-1")
    expect(
      actorToolBody({ action: "wait", partStatus: "completed", description: "Review fix", title: "Actor wait: idle" }),
    ).toBe("Waited for — Review fix")
  })
})

describe("actor tool label", () => {
  test("uses the healthy string values", () => {
    expect(actorToolLabel("explore", undefined)).toBe("explore")
    expect(actorToolLabel("general", "explore")).toBe("general")
    expect(actorToolLabel(undefined, "explore")).toBe("explore")
    expect(actorToolLabel(undefined, undefined)).toBe("General")
  })

  test("rejects persisted values that are not strings", () => {
    // subagent_type is model-emitted and stored verbatim, so every JSON type can
    // arrive here on a replay of an older session.
    for (const bad of [["general", "general"], 71, true, { type: "general" }, null]) {
      expect(actorToolLabel(bad, undefined)).toBe("General")
      expect(actorToolLabel(undefined, bad)).toBe("General")
      expect(actorToolLabel(bad, bad)).toBe("General")
    }
  })

  test("does not crash the header, which titlecases the label", () => {
    // index.tsx: Locale.titlecase(actorToolLabel(input().subagent_type, actorEntry()?.agent))
    // Locale.titlecase calls .replace, so an array label threw here before the guard.
    expect(() => Locale.titlecase(actorToolLabel(["general", "general"], undefined))).not.toThrow()
    expect(Locale.titlecase(actorToolLabel(["general", "general"], undefined))).toBe("General")
  })

  test("keeps a malformed subagent_type out of the task body", () => {
    const body = actorToolBody({
      action: "spawn",
      partStatus: "running",
      description: "Map the provider registry",
      subagentType: ["general", "general"],
    })
    expect(body).not.toContain("general,general")
    expect(body).toBe("Background General Task — Map the provider registry")
  })
})
