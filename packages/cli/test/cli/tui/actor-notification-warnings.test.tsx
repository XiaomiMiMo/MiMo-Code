/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { ActorNotificationWarnings } from "../../../src/cli/cmd/tui/routes/session/actor-notification-warnings"
import { parseActorNotification, renderActorNotification } from "../../../src/inbox/render"
import { dict as en } from "../../../src/cli/cmd/tui/i18n/en"
import { dict as zh } from "../../../src/cli/cmd/tui/i18n/zh"

test("[TP-R14-01] status labels describe subagents in both languages, not sub-sessions", async () => {
  const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()
  expect(source).not.toContain("sub-session {style().label}")
  for (const status of ["completed", "failed", "cancelled", "stalled", "ended"] as const) {
    const key = `tui.session.actor_status.${status}` as const
    expect(source).toContain(`t("${key}")`)
    expect(en[key]).toStartWith("Subagent ")
    expect(zh[key]).toStartWith("子代理")
  }
})

for (const [language, dict, expected] of [["en", en, "Subagent completed"], ["zh", zh, "子代理已完成"]] as const) {
  test(`[TP-R14-01] ${language} completed label renders in the terminal`, async () => {
    const app = await testRender(() => <text>{dict["tui.session.actor_status.completed"]}</text>, { width: 40, height: 4 })
    try { await app.renderOnce(); expect(app.captureCharFrame()).toContain(expected) }
    finally { app.renderer.destroy() }
  })
}

const warningColor = RGBA.fromHex("#e0af68")

for (const width of [32, 80]) {
  test(`[TP-R14-12] warning metadata renders visibly at ${width} columns`, async () => {
    const note = parseActorNotification(
      renderActorNotification({
        actorID: "child",
        description: "task",
        status: "completed",
        result: "MAIN-RESULT",
        warnings: ["postStop failed\n  detail line", "gate unavailable"],
      }),
    )!
    const app = await testRender(
      () => (
        <text>
          completed task
          <ActorNotificationWarnings warnings={note.warnings} label="Warning" color={warningColor} />
        </text>
      ),
      { width, height: 12 },
    )
    try {
      await app.renderOnce()
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("completed task")
      expect(frame).toContain("Warning: postStop failed")
      expect(frame).not.toContain("detail line")
      expect(frame).toContain("Warning: gate unavailable")
      const span = app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes("postStop failed"))!
      expect(Array.from(span.fg.buffer)).toEqual(Array.from(warningColor.buffer))
    } finally {
      app.renderer.destroy()
    }
  })
}

test("[TP-R14-12] no warnings adds no label or extra text", async () => {
  const app = await testRender(
    () => (
      <text>
        completed task
        <ActorNotificationWarnings label="Warning" color={warningColor} />
      </text>
    ),
    { width: 32, height: 5 },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("completed task")
  } finally {
    app.renderer.destroy()
  }
})

test("[TP-R14-12] Chinese warning label is rendered", async () => {
  const app = await testRender(
    () => (
      <text>
        task
        <ActorNotificationWarnings warnings={["hook failed"]} label="警告" color={warningColor} />
      </text>
    ),
    { width: 32, height: 5 },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("警告: hook failed")
  } finally {
    app.renderer.destroy()
  }
})
