/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { ActorNotificationWarnings } from "../../../src/cli/cmd/tui/routes/session/actor-notification-warnings"
import { parseActorNotification, renderActorNotification } from "../../../src/inbox/render"

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
      expect(frame).toContain("detail line")
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
