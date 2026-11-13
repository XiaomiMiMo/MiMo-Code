/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { ExitMessage } from "../../../src/cli/cmd/tui/component/exit-message"
import { ExitProvider, useExit } from "../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { LanguageProvider } from "../../../src/cli/cmd/tui/context/language"
import { RouteProvider, useRoute } from "../../../src/cli/cmd/tui/context/route"

test("exit hint follows session loading and navigation to and from Super-agent", async () => {
  let route: ReturnType<typeof useRoute> | undefined
  let exit: ReturnType<typeof useExit> | undefined
  let update: ((session: { id: string; title: string } | undefined) => void) | undefined
  const Probe = () => {
    route = useRoute()
    exit = useExit()
    const [session, setSession] = createSignal<{ id: string; title: string }>()
    update = setSession
    return <ExitMessage session={(id) => (session()?.id === id ? session() : undefined)} />
  }
  const app = await testRender(
    () => (
      <KVProvider>
        <LanguageProvider>
          <RouteProvider initialRoute={{ type: "session", sessionID: "ses_example" }}>
            <ExitProvider>
              <Probe />
            </ExitProvider>
          </RouteProvider>
        </LanguageProvider>
      </KVProvider>
    ),
    { width: 80, height: 20, exitOnCtrlC: false },
  )
  const hint = async () => {
    const until = Date.now() + 3000
    while (!exit && Date.now() < until) {
      await app.renderOnce()
      await Bun.sleep(10)
    }
    await app.renderOnce()
    return exit!.message.get()
  }
  try {
    expect(await hint()).toBeUndefined()
    update!({ id: "ses_example", title: "Example session" })
    expect(await hint()).toContain("mimo -s ses_example")
    route!.navigate({ type: "superagent" })
    expect(await hint()).toContain("/super-agent")
    expect(await hint()).not.toContain("mimo -s")
    expect(await hint()).not.toContain("undefined")
    // A late session update must not overwrite the workbench hint.
    update!(undefined)
    expect(await hint()).toContain("/super-agent")
    route!.navigate({ type: "home" })
    expect(await hint()).toBeUndefined()
    route!.navigate({ type: "session", sessionID: "ses_other" })
    expect(await hint()).toBeUndefined()
    update!({ id: "ses_other", title: "Another example" })
    expect(await hint()).toContain("mimo -s ses_other")
    route!.navigate({ type: "plugin", id: "example" })
    expect(await hint()).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
  expect(exit!.message.get()).toBeUndefined()
})
