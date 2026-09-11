/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { BashDeleteBody } from "../../../src/cli/cmd/tui/routes/session/permission"

const WARNING = RGBA.fromHex("#e0af68")

const theme = {
  text: RGBA.fromHex("#eeeeee"),
  textMuted: RGBA.fromHex("#808080"),
  warning: WARNING,
  background: RGBA.fromHex("#0a0a0a"),
  borderActive: RGBA.fromHex("#484848"),
  selectedListItemText: RGBA.fromHex("#141414"),
  _hasSelectedListItemText: true,
} as never

const command = [
  "cd packages/opencode",
  "bun install --frozen-lockfile",
  "bun run build:local --target darwin-arm64",
  "rm -rf dist/tmp",
  "rm -rf node_modules/.cache",
  "bun test src/tool --coverage",
  "echo done",
].join(" && ")

const text = RGBA.fromHex("#eeeeee")

// Mirrors the Prompt shell in permission.tsx: hard maxHeight, header and
// footer pinned with flexShrink=0, body squeezed in between.
function Shell(props: { maxHeight: number; deletes: string[] }) {
  return (
    <box maxHeight={props.maxHeight}>
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
        <box paddingLeft={0} flexShrink={0}>
          <text fg={text}>Permission required</text>
          <text fg={text}>Confirm irreversible deletion</text>
        </box>
        <BashDeleteBody command={command} deletes={props.deletes} theme={theme} />
      </box>
      <box flexShrink={0} paddingTop={1} paddingBottom={1} paddingLeft={2}>
        <text fg={text}>Allow once</text>
      </box>
    </box>
  )
}

function sameColor(a: RGBA | undefined, b: RGBA) {
  if (!a) return false
  const buf = (c: RGBA) => [0, 1, 2].map((i) => Math.round(c.buffer[i] * 255))
  return buf(a).join(",") === buf(b).join(",")
}

function deletionRows(frame: string) {
  // deletion lines render as " - rm -rf ..." at the body indent; the wrapped
  // command never starts a row with this exact prefix
  return frame.split("\n").filter((l) => /^\s+- rm -rf /.test(l))
}

function expectFooterIntact(frame: string) {
  const footer = frame.split("\n").filter((l) => l.includes("Allow once"))
  expect(footer.length).toBe(1)
  expect(footer[0]!.trim()).toBe("Allow once")
}

test("squeezed prompt keeps deletion lines intact and off the footer", async () => {
  const deletes = Array.from({ length: 6 }, (_, i) => `rm -rf packages/opencode/artifact-dir-${i}`)
  const app = await testRender(() => <Shell maxHeight={15} deletes={deletes} />, { width: 100, height: 20 })
  await app.renderOnce()
  await app.renderOnce()

  const frame = app.captureCharFrame()
  const rows = deletionRows(frame)
  // at least the guaranteed minimum is visible, scrolled from the top, each
  // row complete (the old body silently dropped interleaved rows instead)
  expect(rows.length).toBeGreaterThanOrEqual(4)
  rows.forEach((row, i) => {
    expect(row).toContain(`- rm -rf packages/opencode/artifact-dir-${i} `)
  })
  expect(frame).toContain("Detected deletions")
  expectFooterIntact(frame)
})

test("many deletions never overpaint the footer", async () => {
  const deletes = Array.from({ length: 14 }, (_, i) => `rm -rf packages/opencode/artifact-dir-${i}`)
  const app = await testRender(() => <Shell maxHeight={15} deletes={deletes} />, { width: 100, height: 20 })
  await app.renderOnce()
  await app.renderOnce()

  const frame = app.captureCharFrame()
  expect(deletionRows(frame).length).toBeGreaterThanOrEqual(4)
  expectFooterIntact(frame)
})

test("narrow terminals with a tall footer keep the footer intact", async () => {
  const deletes = Array.from({ length: 14 }, (_, i) => `rm -rf dir-${i}`)
  const app = await testRender(
    () => (
      <box maxHeight={15}>
        <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
          <box flexShrink={0}>
            <text fg={text}>Permission required</text>
            <text fg={text}>Confirm irreversible deletion</text>
          </box>
          <BashDeleteBody command={command} deletes={deletes} theme={theme} />
        </box>
        {/* below 80 cols the real footer becomes a column layout ~5 rows tall */}
        <box flexShrink={0} paddingTop={1} paddingBottom={1} paddingLeft={2}>
          <text fg={text}>Allow once  Reject</text>
          <text fg={text}>tab select</text>
          <text fg={text}>enter confirm</text>
        </box>
      </box>
    ),
    { width: 60, height: 20 },
  )
  await app.renderOnce()
  await app.renderOnce()

  const frame = app.captureCharFrame()
  expect(deletionRows(frame).length).toBeGreaterThanOrEqual(2)
  const confirmRow = frame.split("\n").filter((l) => l.includes("enter confirm"))
  expect(confirmRow.length).toBe(1)
  expect(confirmRow[0]!.trim()).toBe("enter confirm")
})

test("deletion lines paint every cell with the warning background", async () => {
  const deletes = Array.from({ length: 6 }, (_, i) => `rm -rf packages/opencode/artifact-dir-${i}`)
  const app = await testRender(() => <Shell maxHeight={15} deletes={deletes} />, { width: 100, height: 20 })
  await app.renderOnce()
  await app.renderOnce()

  const captured = app.captureSpans()
  const rows = captured.lines.filter((line) => line.spans.some((s) => s.text.includes("- rm -rf")))
  expect(rows.length).toBeGreaterThanOrEqual(4)

  for (const row of rows) {
    const span = row.spans.find((s) => s.text.includes("- rm -rf"))!
    // one contiguous run: spaces inside the line share the same painted cells
    expect(span.text.startsWith(" - rm -rf ")).toBe(true)
    expect(span.text.endsWith(" ")).toBe(true)
    expect(sameColor(span.bg, WARNING)).toBe(true)
  }
})

test("body hugs a short command instead of filling the panel", async () => {
  const app = await testRender(
    () => (
      <box maxHeight={15}>
        <box gap={1} paddingLeft={1} paddingTop={1} paddingBottom={1} flexGrow={1}>
          <box flexShrink={0}>
            <text fg={text}>Permission required</text>
          </box>
          <BashDeleteBody command="rm -rf dist/tmp" deletes={["rm -rf dist/tmp"]} theme={theme} />
        </box>
        <box flexShrink={0}>
          <text fg={text}>Allow once</text>
        </box>
      </box>
    ),
    { width: 80, height: 20 },
  )
  await app.renderOnce()
  await app.renderOnce()

  const lines = app.captureCharFrame().split("\n")
  const commandRow = lines.findIndex((l) => l.includes("$ rm -rf dist/tmp"))
  const labelRow = lines.findIndex((l) => l.includes("Detected deletions"))
  expect(commandRow).toBeGreaterThan(-1)
  // exactly one gap row between the one-line command and the deletions label
  expect(labelRow).toBe(commandRow + 2)
})

test("a wrapping deletion path does not hide later entries behind the scroll", async () => {
  const deletes = [
    "rm -rf /Users/someone/projects/very/deeply/nested/build-output/artifacts/cache-directory",
    "rm -rf short-1",
    "rm -rf short-2",
  ]
  const app = await testRender(
    () => (
      <box maxHeight={20}>
        <box gap={1} paddingLeft={1} paddingTop={1} paddingBottom={1} flexGrow={1}>
          <box flexShrink={0}>
            <text fg={text}>Permission required</text>
          </box>
          <BashDeleteBody command="rm -rf dist/tmp" deletes={deletes} theme={theme} />
        </box>
        <box flexShrink={0}>
          <text fg={text}>Allow once</text>
        </box>
      </box>
    ),
    { width: 44, height: 24 },
  )
  await app.renderOnce()
  await app.renderOnce()

  const frame = app.captureCharFrame()
  // the long path wraps over several rows; the short entries must still render
  expect(frame).toContain("- rm -rf short-1")
  expect(frame).toContain("- rm -rf short-2")
})
