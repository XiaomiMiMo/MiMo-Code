import { describe, expect, test } from "bun:test"
import { parseActorNotification, renderActorNotification } from "../../src/inbox/render"

describe("parseActorNotification", () => {
  test("parses a completed notification with reported status + summary", () => {
    const text = renderActorNotification({
      actorID: "explore-1",
      description: "Find error recovery",
      status: "completed",
      reportedStatus: "success",
      reportedSummary: "Located 3 recovery sites",
      result: "full body here",
    })
    expect(parseActorNotification(text)).toEqual({
      status: "completed",
      description: "Find error recovery",
      summary: "Located 3 recovery sites",
    })
  })

  test("completed without a summary falls back to the Result line", () => {
    const text = renderActorNotification({
      actorID: "explore-2",
      description: "Scan repo",
      status: "completed",
      reportedStatus: "success",
      result: "42 files scanned",
    })
    expect(parseActorNotification(text)).toEqual({
      status: "completed",
      description: "Scan repo",
      summary: "42 files scanned",
    })
  })

  test("completed without a summary does not mistake an embedded Summary: line in the Result body", () => {
    const text = renderActorNotification({
      actorID: "explore-3",
      description: "Draft report",
      status: "completed",
      reportedStatus: "success",
      result: "Here is the outline:\nSummary: this is inside the result body\nmore text",
    })
    expect(parseActorNotification(text)).toEqual({
      status: "completed",
      description: "Draft report",
      summary: "Here is the outline:",
    })
  })

  test("parses a failed notification with the Error line as summary", () => {
    const text = renderActorNotification({
      actorID: "general-9",
      description: "Type checker review",
      status: "failed",
      error: "process exited 1",
    })
    expect(parseActorNotification(text)).toEqual({
      status: "failed",
      description: "Type checker review",
      summary: "process exited 1",
    })
  })

  test("completed lifecycle but reportedStatus=failed reads as failed, never completed", () => {
    const text = renderActorNotification({
      actorID: "general-4",
      description: "Fix the flaky test",
      status: "completed",
      reportedStatus: "failed",
      reportedSummary: "could not reproduce",
      result: "full body",
    })
    // Top line states the outcome and must never imply success.
    expect(text).toContain("finished (status: failed)")
    expect(text).not.toContain("completed")
    expect(parseActorNotification(text)).toEqual({
      status: "failed",
      description: "Fix the flaky test",
      summary: "could not reproduce",
    })
  })

  test("completed lifecycle but reportedStatus=blocked reads as failed", () => {
    const text = renderActorNotification({
      actorID: "general-5",
      description: "Wire up the API",
      status: "completed",
      reportedStatus: "blocked",
      result: "waiting on credentials",
    })
    expect(text).toContain("finished (status: blocked)")
    expect(parseActorNotification(text)).toEqual({
      status: "failed",
      description: "Wire up the API",
      summary: "waiting on credentials",
    })
  })

  test("completed lifecycle with reportedStatus=unknown reads as neutral ended", () => {
    const text = renderActorNotification({
      actorID: "general-6",
      description: "Do the thing",
      status: "completed",
      reportedStatus: "unknown", // sub-session ran but did not report a task outcome
      result: "some output",
    })
    // Must NOT imply success, and must NOT emit the misleading "Status: unknown".
    expect(text).toContain("ended (status not reported)")
    expect(text).not.toContain("Status: unknown")
    expect(parseActorNotification(text)).toEqual({
      status: "ended",
      description: "Do the thing",
      summary: "some output",
    })
  })

  test("completed lifecycle with no reportedStatus at all reads as a plain completion", () => {
    const text = renderActorNotification({
      actorID: "general-8",
      description: "Plain job",
      status: "completed",
      result: "done",
    })
    expect(text).toContain("completed")
    expect(text).not.toContain("Status:")
    expect(parseActorNotification(text)).toEqual({
      status: "completed",
      description: "Plain job",
      summary: "done",
    })
  })

  test("completed lifecycle with reportedStatus=partial still reads as completed", () => {
    const text = renderActorNotification({
      actorID: "general-7",
      description: "Partial job",
      status: "completed",
      reportedStatus: "partial",
      reportedSummary: "did half",
      result: "body",
    })
    expect(text).toContain("completed")
    expect(parseActorNotification(text)).toEqual({
      status: "completed",
      description: "Partial job",
      summary: "did half",
    })
  })

  test("parses a cancelled notification (no summary)", () => {
    const text = renderActorNotification({
      actorID: "peer-3",
      description: "Long running search",
      status: "cancelled",
    })
    expect(parseActorNotification(text)).toEqual({
      status: "cancelled",
      description: "Long running search",
    })
  })

  test("parses a stalled notification (watchdog variant)", () => {
    const text =
      '<actor-notification>\nBackground sub-session "Wedged agent" (actor_id: general-7) stalled.\nSummary: no output for 10m\n</actor-notification>'
    expect(parseActorNotification(text)).toEqual({
      status: "stalled",
      description: "Wedged agent",
      summary: "no output for 10m",
    })
  })

  test("returns null for non-notification text", () => {
    expect(parseActorNotification("just a normal user message")).toBeNull()
    expect(parseActorNotification("<inbox from=\"x:y\">hello</inbox>")).toBeNull()
    expect(parseActorNotification("")).toBeNull()
  })

  test("returns null when the wrapper is present but the header is malformed", () => {
    expect(parseActorNotification("<actor-notification>\ngarbage\n</actor-notification>")).toBeNull()
  })

  test("backward compat: parses legacy 'Background actor' format as a card", () => {
    const text =
      '<actor-notification>\nBackground actor "Legacy task" (actor_id: explore-1) completed.\nResult: done\n</actor-notification>'
    expect(parseActorNotification(text)).toEqual({
      status: "completed",
      description: "Legacy task",
      summary: "done",
    })
  })
})
