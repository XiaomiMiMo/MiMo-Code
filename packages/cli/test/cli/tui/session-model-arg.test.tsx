/** @jsxImportSource @opentui/solid */
import { describe, expect, spyOn, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import { onMount } from "solid-js"
import { App } from "../../../src/cli/cmd/tui/app"
import { ArgsProvider, type Args } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { LanguageProvider } from "../../../src/cli/cmd/tui/context/language"
import { LocalProvider } from "../../../src/cli/cmd/tui/context/local"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { RouteProvider, useRoute } from "../../../src/cli/cmd/tui/context/route"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider } from "../../../src/cli/cmd/tui/context/sync"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"
import { DialogProvider } from "../../../src/cli/cmd/tui/ui/dialog"
import { CommandProvider } from "../../../src/cli/cmd/tui/component/dialog-command"
import { FrecencyProvider } from "../../../src/cli/cmd/tui/component/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/cli/cmd/tui/component/prompt/history"
import { PromptRefProvider, usePromptRef } from "../../../src/cli/cmd/tui/context/prompt"
import { KeybindProvider } from "../../../src/cli/cmd/tui/context/keybind"
import { PromptStashProvider } from "../../../src/cli/cmd/tui/component/prompt/stash"
import { TuiPluginRuntime } from "../../../src/cli/cmd/tui/plugin"
import { setupSlots } from "../../../src/cli/cmd/tui/plugin/slots"

// Resuming with `-s <id> --model <provider/model>` must keep the --model model
// (as --agent is kept) instead of switching to the session's last message model.

const DIR = "/tmp/tui-session-model-arg"
const SESSION = "ses_resumed"

function model(providerID: string, id: string) {
  return {
    id,
    providerID,
    name: id,
    release_date: "2025-01-01",
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    limit: { context: 100000, output: 10000 },
    cost: { input: 0, output: 0 },
    options: {},
  }
}

const PROVIDERS = [
  {
    id: "alpha",
    name: "Alpha",
    source: "config",
    env: [],
    options: {},
    models: { "model-a": model("alpha", "model-a") },
  },
  { id: "beta", name: "Beta", source: "config", env: [], options: {}, models: { "model-b": model("beta", "model-b") } },
]

const SESSION_ROW = {
  id: SESSION,
  projectID: "p",
  directory: DIR,
  title: "t",
  version: "test",
  time: { created: 1, updated: 1 },
}

async function wait(fn: () => boolean | Promise<boolean>, timeout = 8000) {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

function createFetch() {
  const prompts: { model?: unknown }[] = []
  const fetcher = (async (request: Request) => {
    const url = new URL(request.url)
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    if (request.method === "POST" && url.pathname.includes("prompt_async")) prompts.push(await request.clone().json())
    if (url.pathname === "/path")
      return ok({ home: "/home", state: "/state", config: "/config", worktree: "", directory: DIR })
    if (url.pathname === "/project/current") return ok({ id: "p" })
    if (url.pathname === "/config/providers") return ok({ providers: PROVIDERS, default: {} })
    if (url.pathname === "/provider") return ok({ all: PROVIDERS, default: {}, connected: [], authenticated: [] })
    if (url.pathname === "/vcs") return ok({ branch: "main" })
    if (url.pathname === "/agent")
      return ok([{ name: "build", mode: "primary", hidden: false, permission: [], options: {}, color: "#fff" }])
    if (url.pathname === "/command") return ok([])
    if (url.pathname === "/experimental/workspace" || url.pathname === "/experimental/workspace/status") return ok([])
    if (url.pathname === "/session") return ok([SESSION_ROW])
    if (url.pathname === `/session/${SESSION}` && request.method === "GET") return ok(SESSION_ROW)
    // The session's last user message was sent with alpha/model-a.
    if (url.pathname === `/session/${SESSION}/message` && request.method === "GET")
      return ok([
        {
          info: {
            id: "msg_hist",
            sessionID: SESSION,
            role: "user",
            agent: "build",
            model: { providerID: "alpha", modelID: "model-a" },
            time: { created: 1 },
          },
          parts: [{ id: "prt_1", type: "text", text: "HISTORY_MARKER", synthetic: false }],
        },
      ])
    if (url.pathname.match(/^\/session\/[^/]+\/(todo|diff|actors|task|children|recovery)$/)) return ok([])
    return ok({})
  }) as typeof fetch
  return { fetch: fetcher, prompts }
}

const events = {
  subscribe: async () => () => {},
} as never

function Providers(props: { args: Args; fetch: typeof fetch; children: JSX.Element }) {
  return (
    <ArgsProvider {...props.args}>
      <ExitProvider onBeforeExit={async () => {}} onExit={async () => {}}>
        <KVProvider>
          <LanguageProvider>
            <ToastProvider>
              <RouteProvider>
                <TuiConfigProvider config={{ theme: "mimocode", keybind: {} } as never}>
                  <SDKProvider url="http://test" directory={DIR} fetch={props.fetch} events={events}>
                    <ProjectProvider>
                      <SyncProvider>
                        <ThemeProvider mode="dark">
                          <LocalProvider>
                            <KeybindProvider>
                              <PromptStashProvider>
                                <DialogProvider>
                                  <CommandProvider>
                                    <FrecencyProvider>
                                      <PromptHistoryProvider>
                                        <PromptRefProvider>{props.children}</PromptRefProvider>
                                      </PromptHistoryProvider>
                                    </FrecencyProvider>
                                  </CommandProvider>
                                </DialogProvider>
                              </PromptStashProvider>
                            </KeybindProvider>
                          </LocalProvider>
                        </ThemeProvider>
                      </SyncProvider>
                    </ProjectProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </RouteProvider>
            </ToastProvider>
          </LanguageProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  )
}

// Mounts the production App with `args`, waits for the resumed session and
// submits a prompt through the production Prompt; returns the model it sent.
async function submitAfterResume(args: Args) {
  // Stub the plugin load but keep the slots, so the production Prompt mounts.
  const init = spyOn(TuiPluginRuntime, "init").mockImplementation(async (input) => {
    setupSlots(input.api)
  })
  const http = createFetch()
  const ready = Promise.withResolvers<{
    route: ReturnType<typeof useRoute>
    promptRef: ReturnType<typeof usePromptRef>
  }>()
  function Probe() {
    const route = useRoute()
    const promptRef = usePromptRef()
    onMount(() => ready.resolve({ route, promptRef }))
    return <App />
  }
  try {
    const app = await testRender(() => (
      <Providers args={args} fetch={http.fetch}>
        <Probe />
      </Providers>
    ))
    try {
      const ctx = await ready.promise
      await wait(() => ctx.route.data.type === "session")
      await wait(async () => {
        await app.renderOnce()
        return app.captureCharFrame().includes("HISTORY_MARKER") && ctx.promptRef.current != null
      })
      ctx.promptRef.current!.set({ input: "next", parts: [] })
      ctx.promptRef.current!.submit()
      await wait(() => http.prompts.length > 0, 3000)
      return http.prompts[0]!.model
    } finally {
      app.renderer.destroy()
    }
  } finally {
    init.mockRestore()
  }
}

describe("resuming a session with -s", () => {
  test("keeps the model passed with --model", async () => {
    expect(await submitAfterResume({ sessionID: SESSION, model: "beta/model-b" })).toEqual({
      providerID: "beta",
      modelID: "model-b",
    })
  }, 20000)

  test("uses the session's last model without --model", async () => {
    expect(await submitAfterResume({ sessionID: SESSION })).toEqual({ providerID: "alpha", modelID: "model-a" })
  }, 20000)
})
