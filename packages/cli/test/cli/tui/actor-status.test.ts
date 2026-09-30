import { expect, test } from "bun:test"
import { actorStatusFromEvent } from "../../../src/cli/cmd/tui/context/sync"
import { mount } from "./actor-status.fixture"

test("idle actors without an outcome render stopped on reopening and after live updates", async () => {
  for (let reopen = 0; reopen < 2; reopen++) {
    const view = await mount({ status: "idle" })
    try {
      await view.app.renderOnce()
      expect(view.app.captureCharFrame().trim()).toBe("stopped")
      await view.status("running")
      expect(view.app.captureCharFrame().trim()).toBe("running")
      await view.status("idle", "success")
      expect(view.app.captureCharFrame().trim()).toBe("completed")
      await view.status("running")
      expect(view.app.captureCharFrame().trim()).toBe("running")
      await view.status("idle", "cancelled")
      expect(view.app.captureCharFrame().trim()).toBe("cancelled")
      await view.status("running")
      await view.status("idle", "failure")
      expect(view.app.captureCharFrame().trim()).toBe("failed")
      await view.status("idle")
      expect(view.app.captureCharFrame().trim()).toBe("stopped")
      expect(view.requests.every((method) => method === "GET")).toBe(true)
    } finally {
      view.app.renderer.destroy()
    }
  }
})

test("explicit stopped execution overrides a persisted running status on load", async () => {
  const view = await mount({ status: "running", executionActive: false, executionState: "stopped" })
  try {
    await view.app.renderOnce()
    expect(view.app.captureCharFrame().trim()).toBe("stopped")
    await view.status("running")
    expect(view.app.captureCharFrame().trim()).toBe("running")
    await view.status("idle", "success")
    expect(view.app.captureCharFrame().trim()).toBe("completed")
  } finally {
    view.app.renderer.destroy()
  }
})

test("runtime snapshots take precedence without conflating stopped and terminal outcomes", () => {
  expect(actorStatusFromEvent({ status: "pending" })).toBe("pending")
  expect(actorStatusFromEvent({ status: "running", lastOutcome: "success" })).toBe("running")
  expect(actorStatusFromEvent({ status: "pending", lastOutcome: "failure" })).toBe("pending")
  expect(actorStatusFromEvent({ status: "running", executionActive: false })).toBe("stopped")
  expect(actorStatusFromEvent({ status: "idle", lastOutcome: "success", executionActive: true })).toBe("running")
  expect(actorStatusFromEvent({ status: "idle", executionState: "completed", executionActive: true })).toBe("running")
  expect(actorStatusFromEvent({ status: "running", lastOutcome: "success", executionState: "stopped" })).toBe("stopped")
  for (const executionState of ["running", "stopped", "completed", "failed", "cancelled"] as const) {
    expect(actorStatusFromEvent({ status: "idle", executionState })).toBe(executionState)
  }
  for (const [lastOutcome, expected] of [
    ["success", "completed"],
    ["failure", "failed"],
    ["cancelled", "cancelled"],
  ] as const) {
    expect(actorStatusFromEvent({ status: "idle", lastOutcome })).toBe(expected)
    expect(actorStatusFromEvent({ status: "running", executionActive: false, lastOutcome })).toBe(expected)
  }
})
