/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ContextSidebar } from "../../../src/cli/cmd/tui/feature-plugins/sidebar/context"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

test("sidebar reports only recorded semantic hits and injections for its session", async () => {
  const messages = [
    { id: "mem", role: "user" },
    { id: "hist", role: "user" },
    { id: "lexical", role: "user" },
    { id: "injected", role: "user" },
    { id: "rebuilt", role: "user" },
    { id: "ignored", role: "user" },
  ] as never
  const parts: Record<string, unknown[]> = {
    mem: [
      { type: "tool", tool: "memory", state: { status: "completed", metadata: { vectorSemanticHits: 2, output: "private query text" } } },
    ],
    hist: [
      { type: "tool", tool: "history", state: { status: "completed", metadata: { vectorSemanticHits: 1 } } },
    ],
    lexical: [
      { type: "tool", tool: "memory", state: { status: "completed", metadata: { count: 4 } } },
    ],
    injected: [
      { type: "text", synthetic: true, metadata: { retrievalOrigin: "history.hybridSearch" }, text: "private snippet" },
    ],
    rebuilt: [
      { type: "text", synthetic: true, metadata: { retrievalOrigin: "memory.rebuild", untrusted: true }, text: "private rebuild evidence" },
    ],
    other: [
      { type: "tool", tool: "memory", state: { status: "completed", metadata: { vectorSemanticHits: 99 } } },
      { type: "text", synthetic: true, metadata: { retrievalOrigin: "memory.hybridSearch" }, text: "other-session" },
    ],
    ignored: [
      { type: "text", synthetic: true, ignored: true, metadata: { retrievalOrigin: "memory.hybridSearch" }, text: "ignored" },
    ],
  }
  const api = createTuiPluginApi({
    state: {
      session: { messages: (sessionID) => sessionID === "ses_active" ? messages : ([{ id: "other" }] as never) },
      part: (messageID) => (parts[messageID] ?? []) as never,
    },
  })
  const app = await testRender(() => <ContextSidebar api={api} session_id="ses_active" />, { width: 42, height: 20 })
  await app.renderOnce()

  const frame = app.captureCharFrame()
  expect(frame).toContain("Vector hits / injections")
  expect(frame).toContain("Mem 2 · Hist 1 · Inject 2")
  expect(frame).not.toContain("private query text")
  expect(frame).not.toContain("private snippet")
  expect(frame).not.toContain("private rebuild evidence")
  expect(frame).not.toContain("other-session")
  const rows = frame.split("\n")
  const heading = rows.findIndex((line) => line.includes("Vector hits / injections"))
  expect(heading).toBeGreaterThanOrEqual(0)
  expect(rows[heading + 1]).toContain("Mem 2 · Hist 1 · Inject 2")
  expect(rows[heading + 2]).not.toContain("Vector")
  expect(rows[heading]!.length).toBeLessThanOrEqual(42)
  expect(rows[heading + 1]!.length).toBeLessThanOrEqual(42)
})

test("sidebar shows zero for disabled or lexical fallback and bounds large counters", async () => {
  const api = createTuiPluginApi({
    state: {
      session: { messages: () => [{ id: "lexical", role: "user" }] as never },
      part: () => [
        { type: "tool", tool: "history", state: { status: "completed", metadata: { count: 2, truncated: false } } },
        { type: "tool", tool: "memory", state: { status: "completed", metadata: { vectorSemanticHits: 1_000_000 } } },
      ] as never,
    },
  })
  const app = await testRender(() => <ContextSidebar api={api} session_id="ses_active" />, { width: 42, height: 20 })
  await app.renderOnce()
  const rows = app.captureCharFrame().split("\n")
  expect(rows.some((line) => line.includes("Mem 99+ · Hist 0 · Inject 0"))).toBe(true)
  expect(rows.every((line) => line.length <= 42)).toBe(true)
})
