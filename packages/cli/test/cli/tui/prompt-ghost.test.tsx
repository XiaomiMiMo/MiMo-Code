/** @jsxImportSource @opentui/solid */
import { beforeAll, describe, expect, spyOn, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import { onMount } from "solid-js"
import path from "path"
import { Global } from "../../../src/global"
import { App } from "../../../src/cli/cmd/tui/app"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { LanguageProvider } from "../../../src/cli/cmd/tui/context/language"
import { LocalProvider } from "../../../src/cli/cmd/tui/context/local"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { RouteProvider, useRoute } from "../../../src/cli/cmd/tui/context/route"
import { SDKProvider, useSDK } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"
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

// Ghost-suggestion lifecycle: the predicted prompt shows as placeholder in the
// empty input, typing hides it, and erasing back to empty must bring the SAME
// cached suggestion back without a second session.predict call.

const DIR = "/tmp/tui-ghost"
const HIST = "HIST_MARKER_USER_TURN"
const GHOST = "GHOST_MARKER_PREDICTION"
const SESSION = "ses_ghost"

async function wait(fn: () => boolean | Promise<boolean>, timeout = 8000) {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

beforeAll(async () => {
  // Pre-accept the one-time ToS dialog: it opens over the prompt on fresh
  // state and steals keyboard focus from the textarea.
  const file = path.join(Global.Path.state, "kv.json")
  let data: Record<string, unknown> = {}
  if (await Bun.file(file).exists()) data = await Bun.file(file).json()
  data.agreement_accepted = true
  await Bun.write(file, JSON.stringify(data))
})

function sessionRow(id: string, directory: string, updated: number) {
  return {
    id,
    projectID: "p",
    directory,
    title: "t",
    version: "test",
    parentID: undefined,
    time: { created: updated, updated },
  }
}

const AGENTS = [
  { name: "build", mode: "primary", hidden: false, permission: [], options: {}, color: "#fff" },
  { name: "plan", mode: "primary", hidden: false, permission: [], options: {}, color: "#fff" },
  { name: "compose", mode: "primary", hidden: false, permission: [], options: {}, color: "#fff" },
]

const PROVIDERS = [
  {
    id: "test",
    name: "Test",
    source: "config",
    env: [],
    options: { apiKey: "k", baseURL: "http://127.0.0.1:0" },
    models: {
      "test-model": {
        id: "test-model",
        providerID: "test",
        name: "Test Model",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: true,
        limit: { context: 100000, output: 10000 },
        cost: { input: 0, output: 0 },
        options: {},
      },
    },
  },
]

function historyMessage(id: string, sessionID: string) {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      time: { created: 1 },
    },
    parts: [{ id: "prt_1", type: "text", text: HIST, synthetic: false }],
  }
}

function createFetch() {
  const posts: { method: string; path: string }[] = []
  const fetcher = (async (request: Request) => {
    const url = new URL(request.url)
    if (request.method !== "GET") posts.push({ method: request.method, path: url.pathname })
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    if (url.pathname === "/path")
      return ok({ home: "/home", state: "/state", config: "/config", worktree: "", directory: DIR })
    if (url.pathname === "/project/current") return ok({ id: "p" })
    if (url.pathname === "/config/providers") return ok({ providers: PROVIDERS, default: {} })
    if (url.pathname === "/provider") return ok({ all: PROVIDERS, default: {}, connected: [], authenticated: [] })
    if (url.pathname === "/vcs") return ok({ branch: "main" })
    if (url.pathname === "/agent") return ok(AGENTS)
    if (url.pathname === "/command") return ok([])
    if (url.pathname === "/experimental/workspace" || url.pathname === "/experimental/workspace/status") return ok([])
    if (url.pathname === "/session" && request.method === "POST") return ok(sessionRow(SESSION, DIR, Date.now()))
    if (url.pathname === "/session") return ok([sessionRow(SESSION, DIR, 100)])
    if (url.pathname.match(/^\/session\/[^/]+$/) && request.method === "GET") return ok(sessionRow(SESSION, DIR, 100))
    if (url.pathname.match(/^\/session\/[^/]+\/message$/) && request.method === "GET")
      return ok([historyMessage("msg_hist", SESSION)])
    if (url.pathname.match(/^\/session\/[^/]+\/predict$/)) return ok({ prediction: GHOST })
    if (url.pathname.match(/^\/session\/[^/]+\/(todo|diff|actors|task|children|recovery)$/)) return ok([])
    return ok({})
  }) as typeof fetch
  return { fetch: fetcher, posts }
}

function createEvents() {
  let handler: ((event: never) => void) | undefined
  return {
    subscribe: async (fn: (event: never) => void) => {
      handler = fn
      return () => {
        if (handler === fn) handler = undefined
      }
    },
    emit: (event: unknown) => handler?.(event as never),
  }
}

const tuiConfig = { theme: "mimocode", keybind: {} } as never

function Providers(props: {
  http: ReturnType<typeof createFetch>
  events: ReturnType<typeof createEvents>
  children: JSX.Element
}) {
  return (
    <ArgsProvider continue>
      <ExitProvider onBeforeExit={async () => {}} onExit={async () => {}}>
        <KVProvider>
          <LanguageProvider>
            <ToastProvider>
              <RouteProvider initialRoute={{ type: "session" as const, sessionID: "dummy" }}>
                <TuiConfigProvider config={tuiConfig}>
                  <SDKProvider url="http://test" directory={DIR} fetch={props.http.fetch} events={props.events}>
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

type AppCtx = {
  route: ReturnType<typeof useRoute>
  sync: ReturnType<typeof useSync>
  promptRef: ReturnType<typeof usePromptRef>
  sdk: ReturnType<typeof useSDK>
}

async function mountApp(http: ReturnType<typeof createFetch>, events: ReturnType<typeof createEvents>) {
  const initSpy = spyOn(TuiPluginRuntime, "init").mockImplementation(async (input) => {
    setupSlots(input.api)
  })
  const restore = () => initSpy.mockRestore()
  let ctx!: AppCtx
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })
  function Probe() {
    const route = useRoute()
    const sync = useSync()
    const promptRef = usePromptRef()
    const sdk = useSDK()
    onMount(() => {
      ctx = { route, sync, promptRef, sdk }
      done()
    })
    return <App />
  }
  try {
    const app = await testRender(() => (
      <Providers http={http} events={events}>
        <Probe />
      </Providers>
    ))
    await ready
    return { app, ...ctx, http, events, restore }
  } catch (error) {
    restore()
    throw error
  }
}

describe("prompt ghost suggestion lifecycle", () => {
  test("typing hides the suggestion and erasing restores it without re-predicting", async () => {
    const http = createFetch()
    const events = createEvents()
    const h = await mountApp(http, events)
    try {
      // Continue navigates to the seeded root session.
      await wait(() => h.route.data.type === "session" && h.route.data.sessionID === SESSION)
      // Messages loaded → lastUserMessage exists for fetchGhost.
      await wait(async () => {
        await h.app.renderOnce()
        return h.app.captureCharFrame().includes(HIST)
      })
      await wait(() => h.sync.status === "complete")
      await wait(async () => {
        await h.app.renderOnce()
        return h.promptRef.current != null
      })

      // Drive an idle transition — the production trigger for a prediction.
      // Events are GlobalEvent envelopes ({directory, payload}) and the SDK
      // batches flushes for up to 16ms, so let each one land before the next.
      events.emit({
        directory: DIR,
        payload: { type: "session.status", properties: { sessionID: SESSION, status: { type: "working" } } },
      })
      await Bun.sleep(30)
      events.emit({
        directory: DIR,
        payload: { type: "session.status", properties: { sessionID: SESSION, status: { type: "idle" } } },
      })
      await Bun.sleep(30)

      await wait(async () => {
        await h.app.renderOnce()
        return h.app.captureCharFrame().includes(GHOST)
      }, 5000)
      const predicts = () => http.posts.filter((p) => p.path.endsWith("/predict"))
      expect(predicts().length).toBe(1)

      // Typing hides the cached suggestion.
      await h.app.mockInput.typeText("hello")
      await h.app.renderOnce()
      expect(h.app.captureCharFrame()).not.toContain(GHOST)

      // Erasing back to empty must restore the same suggestion — no second
      // predict call, the cache is still valid.
      await h.app.mockInput.pressKeys(["BACKSPACE", "BACKSPACE", "BACKSPACE", "BACKSPACE", "BACKSPACE"])
      await h.app.renderOnce()
      expect(h.app.captureCharFrame()).toContain(GHOST)
      expect(predicts().length).toBe(1)
    } finally {
      h.app.renderer.destroy()
      h.restore()
    }
  })
})
