/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import fs from "fs/promises"
import path from "path"
import { TaskItem } from "../../../src/cli/cmd/tui/component/task-item"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { Global } from "../../../src/global"

async function waitForText(app: { captureCharFrame: () => string; renderOnce: () => Promise<void> }, text: string) {
  const start = Date.now()
  while (!app.captureCharFrame().includes(text)) {
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${text}`)
    await app.renderOnce()
    await Bun.sleep(10)
  }
}

test("TaskItem updates its glyph when status changes to done", async () => {
  let setStatus!: (status: string) => void
  await fs.mkdir(Global.Path.state, { recursive: true })
  await Bun.write(path.join(Global.Path.state, "kv.json"), "{}")

  const App = () => {
    const [status, updateStatus] = createSignal("open")
    setStatus = updateStatus
    return (
      <TuiConfigProvider config={{}}>
        <KVProvider>
          <ThemeProvider mode="dark" plain>
            <TaskItem id="T1" status={status()} summary="Ship fix" depth={0} />
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    )
  }

  const app = await testRender(() => <App />, { width: 80, height: 10 })
  try {
    await waitForText(app, "[ ] T1 Ship fix")
    setStatus("done")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("[✓] T1 Ship fix")
  } finally {
    app.renderer.destroy()
  }
})
