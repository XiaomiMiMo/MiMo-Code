/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import type { Part } from "@mimo-ai/sdk/v2"
import { AgentInboxMessages } from "../../../src/cli/cmd/tui/routes/session/agent-inbox-messages"
import { parseAgentInboxPart, renderInboxRow } from "../../../src/inbox/render"
import { SessionID } from "../../../src/session/schema"
import { dict as en } from "../../../src/cli/cmd/tui/i18n/en"
import { dict as zh } from "../../../src/cli/cmd/tui/i18n/zh"

function inbox(text: string, sender = "build"): Extract<Part, { type: "text" }> {
  return {
    id: `part_${sender}`,
    messageID: "msg_inbox",
    sessionID: "ses_example",
    type: "text",
    synthetic: true,
    text: renderInboxRow({
      id: `inbox_${sender}`,
      receiver_session_id: SessionID.make("ses_example"),
      receiver_actor_id: "explore-1",
      sender_session_id: SessionID.make("ses_example"),
      sender_actor_id: sender,
      type: "text",
      content: { text },
      created_at: Date.parse("2026-01-01T00:00:00.000Z"),
    }),
  }
}

const colors = {
  color: RGBA.fromHex("#eeeeee"),
  borderColor: RGBA.fromHex("#88aaff"),
  backgroundColor: RGBA.fromHex("#111111"),
  hoverColor: RGBA.fromHex("#222222"),
}

for (const [language, dict, expected] of [["en", en, "Message from ses_example:build"], ["zh", zh, "来自 ses_example:build 的消息"]] as const) {
  test(`persisted inbox messages render sender and all bodies in ${language}`, async () => {
    const parts = [inbox("Resume the task.\nReport findings."), inbox("Check tests too.", "reviewer")]
    const before = JSON.stringify(parts)
    const app = await testRender(() => (
      <AgentInboxMessages agentID="explore-1" messageID="msg_inbox" parts={parts}
        label={(from) => dict["tui.session.inbox.from"].replace("{{from}}", from)} {...colors} />
    ), { width: 80, height: 16 })
    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain(expected)
      expect(frame).toContain("Resume the task.")
      expect(frame).toContain("Report findings.")
      expect(frame).toContain("ses_example:reviewer")
      expect(frame).toContain("Check tests too.")
      expect(frame).not.toContain("<inbox")
      expect(frame).not.toContain("</inbox>")
      expect(frame).toContain("┃")
      const spans = app.captureSpans().lines.flatMap((line) => line.spans)
      const body = spans.find((span) => span.text.includes("Resume the task."))!
      const border = spans.find((span) => span.text.includes("┃"))!
      expect(Array.from(body.bg!.buffer)).toEqual(Array.from(colors.backgroundColor.buffer))
      expect(Array.from(border.fg!.buffer)).toEqual(Array.from(colors.borderColor.buffer))
      expect(JSON.stringify(parts)).toBe(before)
    } finally { app.renderer.destroy() }
  })
}

test("live inbox delivery becomes visible and main view keeps it hidden", async () => {
  const [parts, setParts] = createSignal<Part[]>([])
  const [agentID, setAgentID] = createSignal("explore-1")
  const app = await testRender(() => (
    <AgentInboxMessages agentID={agentID()} messageID="msg_inbox" parts={parts()}
      label={(from) => `From ${from}`} {...colors} />
  ), { width: 32, height: 12 })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("")
    setParts([inbox("Continue work.")])
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Continue work.")
    setAgentID("main")
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("")
  } finally { app.renderer.destroy() }
})

test("system reminders, notifications, ignored parts and ordinary user text are not inbox cards", async () => {
  const base = inbox("Continue work.")
  const parts: Part[] = [
    { ...base, synthetic: false },
    { ...base, ignored: true },
    { ...base, text: "<system-reminder>INTERNAL</system-reminder>" },
    { ...base, text: "<actor-notification>INTERNAL</actor-notification>" },
    { ...base, text: '<inbox from="ses_example:build" sent_at="invalid">\nINTERNAL\n</inbox>' },
  ]
  for (const part of parts) expect(parseAgentInboxPart(part)).toBeUndefined()
  const app = await testRender(() => (
    <AgentInboxMessages agentID="explore-1" messageID="msg_inbox" parts={parts}
      label={(from) => `From ${from}`} {...colors} />
  ), { width: 80, height: 10 })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("")
  } finally { app.renderer.destroy() }
})
