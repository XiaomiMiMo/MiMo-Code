/** @jsxImportSource @opentui/solid */
import { beforeAll, expect, test } from "bun:test"
import path from "path"
import { Global } from "../../../src/global"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { BashDeleteBody, PermissionPrompt } from "../../../src/cli/cmd/tui/routes/session/permission"
import type { PermissionRequest } from "@mimo-ai/sdk/v2"
import { createSignal } from "solid-js"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider } from "../../../src/cli/cmd/tui/context/sync"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { LanguageProvider } from "../../../src/cli/cmd/tui/context/language"
import { KeybindProvider } from "../../../src/cli/cmd/tui/context/keybind"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"
import { DialogProvider } from "../../../src/cli/cmd/tui/ui/dialog"

beforeAll(async () => {
  const file = Bun.file(path.join(Global.Path.state, "kv.json"))
  if (!(await file.exists())) await Bun.write(file, "{}")
})

function request(permission: string): PermissionRequest {
  return {
    id: `per_${permission}`,
    sessionID: "ses_permission",
    permission,
    patterns: ["*"],
    always: ["*"],
    metadata: {},
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("PermissionPrompt did not reach the expected state")
    await Bun.sleep(10)
  }
}

async function mountPermission(permission: string) {
  const replies: { method: string; path: string; body: unknown }[] = []
  const [current, setRequest] = createSignal(request(permission))
  const fetcher = (async (input: Request) => {
    const url = new URL(input.url)
    if (url.pathname.startsWith("/permission/")) {
      replies.push({ method: input.method, path: url.pathname, body: await input.json() })
      return Response.json(true)
    }
    if (url.pathname === "/path") return Response.json({ directory: "/tmp/permission", worktree: "" })
    if (url.pathname === "/project/current") return Response.json({ id: "permission-project" })
    if (url.pathname === "/config/providers") return Response.json({ providers: [], default: {} })
    if (url.pathname === "/provider") return Response.json({ all: [], default: {}, connected: [], authenticated: [] })
    if (["/session", "/agent", "/command", "/experimental/workspace", "/experimental/workspace/status", "/lsp", "/formatter"].includes(url.pathname)) {
      return Response.json([])
    }
    return Response.json({})
  }) as typeof fetch
  const app = await testRender(() => (
    <SDKProvider url="http://test" directory="/tmp/permission" fetch={fetcher} events={{ subscribe: async () => () => {} }}>
      <ProjectProvider>
        <ArgsProvider>
          <ExitProvider>
            <SyncProvider>
              <KVProvider>
                <TuiConfigProvider config={{ keybinds: { app_exit: "ctrl+c" } }}>
                  <ThemeProvider mode="dark">
                    <LanguageProvider>
                      <ToastProvider>
                        <DialogProvider>
                          <KeybindProvider>
                            <PermissionPrompt request={current()} />
                          </KeybindProvider>
                        </DialogProvider>
                      </ToastProvider>
                    </LanguageProvider>
                  </ThemeProvider>
                </TuiConfigProvider>
              </KVProvider>
            </SyncProvider>
          </ExitProvider>
        </ArgsProvider>
      </ProjectProvider>
    </SDKProvider>
  ), { width: 100, height: 24 })
  try {
    await waitFor(() => app.renderer.root.getChildren().length > 0)
    await waitFor(async () => {
      await app.renderOnce()
      return app.captureCharFrame().includes("Permission required")
    })
  } catch (error) {
    app.renderer.destroy()
    throw error
  }
  return { app, replies, setRequest }
}

for (const permission of ["computer", "bash_delete"]) {
  test(`${permission} PermissionPrompt offers only once and reject`, async () => {
    const { app } = await mountPermission(permission)
    try {
      expect(app.captureCharFrame()).toContain("Allow once")
      expect(app.captureCharFrame()).toContain("Reject")
      expect(app.captureCharFrame()).not.toContain("Allow always")
    } finally {
      app.renderer.destroy()
    }
  })

  for (const action of [
    { keys: ["RETURN"], reply: "once" },
    { keys: ["ARROW_RIGHT", "RETURN"], reply: "reject" },
    { keys: ["ARROW_LEFT", "RETURN"], reply: "reject" },
    { keys: ["l", "RETURN"], reply: "reject" },
    { keys: ["h", "RETURN"], reply: "reject" },
    { keys: ["ESCAPE"], reply: "reject" },
  ]) {
    test(`${permission} PermissionPrompt ${action.keys.join("+")} sends ${action.reply}`, async () => {
      const { app, replies } = await mountPermission(permission)
      try {
        await app.mockInput.pressKeys(action.keys)
        await app.renderOnce()
        expect(app.captureCharFrame()).not.toContain("until MiMoCode is restarted")
        await waitFor(() => replies.length > 0)
        expect(replies).toEqual([{
          method: "POST",
          path: `/permission/per_${permission}/reply`,
          body: { reply: action.reply },
        }])
      } finally {
        app.renderer.destroy()
      }
    })
  }

  test(`${permission} PermissionPrompt app-exit shortcut rejects`, async () => {
    const { app, replies } = await mountPermission(permission)
    try {
      app.mockInput.pressCtrlC()
      await app.renderOnce()
      await waitFor(() => replies.length > 0)
      expect(replies).toEqual([{
        method: "POST",
        path: `/permission/per_${permission}/reply`,
        body: { reply: "reject" },
      }])
    } finally {
      app.renderer.destroy()
    }
  })
}

for (const permission of ["bash", "edit"]) {
  test(`${permission} PermissionPrompt preserves always confirmation and reply`, async () => {
    const { app, replies } = await mountPermission(permission)
    try {
      expect(app.captureCharFrame()).toContain("Allow always")
      await app.mockInput.pressKeys(["ARROW_RIGHT", "RETURN"])
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("until MiMoCode is restarted")
      expect(replies).toEqual([])
      app.mockInput.pressEnter()
      await app.renderOnce()
      await waitFor(() => replies.length > 0)
      expect(replies).toEqual([{
        method: "POST",
        path: `/permission/per_${permission}/reply`,
        body: { reply: "always" },
      }])
    } finally {
      app.renderer.destroy()
    }
  })
}

for (const stage of ["selected", "confirmation"]) {
  for (const reply of ["once", "reject"]) {
    test(`switching ${stage} bash always to computer resets selection before ${reply}`, async () => {
      const { app, replies, setRequest } = await mountPermission("bash")
      try {
        app.mockInput.pressArrow("right")
        if (stage === "confirmation") app.mockInput.pressEnter()
        await app.renderOnce()
        if (stage === "confirmation") expect(app.captureCharFrame()).toContain("until MiMoCode is restarted")
        setRequest(request("computer"))
        await app.renderOnce()
        expect(app.captureCharFrame()).toContain("Tool: computer")
        expect(app.captureCharFrame()).not.toContain("Allow always")
        expect(app.captureCharFrame()).not.toContain("until MiMoCode is restarted")
        expect(replies).toEqual([])
        if (reply === "reject") app.mockInput.pressArrow("right")
        app.mockInput.pressEnter()
        await app.renderOnce()
        await waitFor(() => replies.length > 0)
        expect(replies).toEqual([{
          method: "POST",
          path: "/permission/per_computer/reply",
          body: { reply },
        }])
      } finally {
        app.renderer.destroy()
      }
    })
  }
}

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
