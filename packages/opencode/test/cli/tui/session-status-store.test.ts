import { describe, test, expect } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { nextSessionStatus } from "../../../src/cli/cmd/tui/context/sync"

// The TUI stores every `session.status` event in a solid store keyed by session.
// Solid MERGES plain objects into the existing node, so a status that omits a
// field used to inherit it from the previous status — that is how the /rebuild
// outcome sentence latched into the following turn's spinner.
function harness() {
  return createRoot((dispose) => {
    const [store, setStore] = createStore<{ session_status: Record<string, unknown> }>({ session_status: {} })
    return {
      store,
      apply: (sessionID: string, status: Parameters<typeof nextSessionStatus>[0]) =>
        setStore("session_status", sessionID, nextSessionStatus(status)),
      dispose,
    }
  })
}

describe("nextSessionStatus", () => {
  const REBUILT =
    "Context rebuilt from the latest checkpoint. Recent messages are preserved; earlier context is now summarized."

  test("a following turn's bare busy status does not inherit the rebuild message", () => {
    const h = harness()
    h.apply("ses_1", { type: "busy", message: REBUILT })
    expect(h.store.session_status["ses_1"]).toEqual({ type: "busy", message: REBUILT })

    // /rebuild settles to idle immediately after emitting its outcome.
    h.apply("ses_1", { type: "idle" })
    expect(h.store.session_status["ses_1"]).toEqual({ type: "idle" })

    // The next turn: the runner emits a bare busy (session/run-state.ts:74).
    h.apply("ses_1", { type: "busy" })
    expect((h.store.session_status["ses_1"] as { message?: string }).message).toBeUndefined()
    h.dispose()
  })

  test("idle clears a busy message", () => {
    const h = harness()
    h.apply("ses_2", { type: "busy", message: "Writing checkpoint\u2026" })
    h.apply("ses_2", { type: "idle" })
    expect(h.store.session_status["ses_2"]).toEqual({ type: "idle" })
    h.dispose()
  })

  test("busy replaces an earlier busy message instead of keeping it", () => {
    const h = harness()
    h.apply("ses_3", { type: "busy", message: "Rebuilding context\u2026" })
    h.apply("ses_3", { type: "busy", message: "Writing checkpoint\u2026" })
    expect(h.store.session_status["ses_3"]).toEqual({ type: "busy", message: "Writing checkpoint\u2026" })
    h.dispose()
  })

  test("retry fields do not survive into the next status", () => {
    const h = harness()
    h.apply("ses_4", { type: "retry", attempt: 2, message: "boom", next: 1000 })
    h.apply("ses_4", { type: "busy" })
    expect(h.store.session_status["ses_4"]).toEqual({ type: "busy" })
    h.dispose()
  })

  test("first status for an unseen session is stored as-is", () => {
    const h = harness()
    h.apply("ses_5", { type: "busy", message: "Rebuilding context\u2026" })
    expect(h.store.session_status["ses_5"]).toEqual({ type: "busy", message: "Rebuilding context\u2026" })
    h.dispose()
  })
})
