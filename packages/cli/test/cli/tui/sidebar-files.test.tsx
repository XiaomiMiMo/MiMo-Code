/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { FilesView } from "../../../src/cli/cmd/tui/feature-plugins/sidebar/files"

const theme = {
  text: RGBA.fromHex("#eeeeee"),
  textMuted: RGBA.fromHex("#aaaaaa"),
  diffAdded: RGBA.fromHex("#88cc88"),
  diffRemoved: RGBA.fromHex("#ee8888"),
}

test("large sidebar renders a bounded preview and states the full file count", async () => {
  const files = Array.from({ length: 500 }, (_, i) => ({
    file: `file-${String(i).padStart(4, "0")}.ts`,
    additions: 2,
    deletions: 1,
  }))
  const app = await testRender(() => <FilesView files={files} total={100_000} theme={theme} />, {
    width: 64,
    height: 110,
  })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Showing 100 of 100000 files")
    expect(frame).toContain("file-0099.ts")
    expect(frame).not.toContain("file-0100.ts")
    if (process.env.MIMOCODE_SIDEBAR_CAPTURE) await Bun.write(process.env.MIMOCODE_SIDEBAR_CAPTURE, frame)
  } finally {
    app.renderer.destroy()
  }
})
