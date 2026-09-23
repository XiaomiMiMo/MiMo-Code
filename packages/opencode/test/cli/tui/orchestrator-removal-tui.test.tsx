/** @jsxImportSource @opentui/solid */
import { describe, expect, spyOn, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import { Effect } from "effect"
import { onMount } from "solid-js"
import { Agent } from "../../../src/agent/agent"
import { Instance } from "../../../src/project/instance"
import { App } from "../../../src/cli/cmd/tui/app"
import { UserMessageView, sessionViewContext } from "../../../src/cli/cmd/tui/routes/session/index"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { LanguageProvider } from "../../../src/cli/cmd/tui/context/language"
import { LocalProvider, useLocal } from "../../../src/cli/cmd/tui/context/local"
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
import { buildTipKeys } from "../../../src/cli/cmd/tui/feature-plugins/home/tips-view"
import { TuiPluginRuntime } from "../../../src/cli/cmd/tui/plugin"
import { setupSlots } from "../../../src/cli/cmd/tui/plugin/slots"
import { renderActorNotification } from "../../../src/inbox/render"
import type { Part, UserMessage as UserMessageT } from "@mimo-ai/sdk/v2"
import type { ThinkingMode } from "../../../src/cli/cmd/tui/context/thinking"

// C6 Path A: production App / UserMessageView. -s is NOT pre-routed; App must
// navigate. Mode switch goes through local.agent.move. History + submit hit the
// production prompt/SDK path.

const DIR = "/tmp/tui-orch-removal"
const HIST = "HIST_MARKER_LOGIN_PAGE"
const SUBMIT = "FOLLOWUP_MARKER_SUBMIT"

async function wait(fn: () => boolean | Promise<boolean>, timeout = 8000) {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

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
  { name: "orchestrator", mode: "primary", hidden: false, permission: [], options: {}, color: "#fff" },
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

function requestDirectory(request: Request) {
  // Real SDK client (packages/sdk/js/src/v2/client.ts): GET/HEAD rewrite the
  // directory into the query string; every other method keeps it on the
  // x-mimocode-directory header, URI-encoded. Reading only the query therefore
  // misses every POST.
  const url = new URL(request.url)
  if (request.method === "GET" || request.method === "HEAD") return url.searchParams.get("directory") ?? undefined
  const header = request.headers.get("x-mimocode-directory")
  if (header == null) return undefined
  return decodeURIComponent(header)
}

function createFetch(input: { sessions?: Record<string, string[]>; includeOrchestrator?: boolean } = {}) {
  const sessions = input.sessions ?? {}
  const posts: { method: string; path: string; body?: unknown; directory?: string }[] = []
  const gets: { path: string; search: string; directory?: string }[] = []
  const agents = input.includeOrchestrator === false ? AGENTS.filter((a) => a.name !== "orchestrator") : AGENTS
  const fetcher = (async (request: Request) => {
    const url = new URL(request.url)
    const directory = requestDirectory(request)
    gets.push({ path: url.pathname, search: url.search, directory })
    if (request.method !== "GET") {
      let body: unknown
      try {
        body = await request.clone().json()
      } catch {}
      posts.push({ method: request.method, path: url.pathname, body, directory })
    }
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    if (url.pathname === "/path")
      return ok({ home: "/home", state: "/state", config: "/config", worktree: "", directory: DIR })
    if (url.pathname === "/project/current") return ok({ id: "p" })
    if (url.pathname === "/config/providers") return ok({ providers: PROVIDERS, default: {} })
    if (url.pathname === "/provider") return ok({ all: PROVIDERS, default: {}, connected: [], authenticated: [] })
    if (url.pathname === "/vcs") return ok({ branch: "main" })
    if (url.pathname === "/agent") return ok(agents)
    if (url.pathname === "/command") return ok([])
    if (url.pathname === "/experimental/workspace" || url.pathname === "/experimental/workspace/status") return ok([])
    if (url.pathname === "/session" && request.method === "POST") {
      const id = `ses_created_${Date.now()}`
      sessions[DIR] = [...(sessions[DIR] ?? []), id]
      return ok(sessionRow(id, DIR, Date.now()))
    }
    if (url.pathname === "/session") return ok((sessions[DIR] ?? []).map((id, i) => sessionRow(id, DIR, 100 + i)))
    // GET /session/:id
    const sessionGet = url.pathname.match(/^\/session\/([^/]+)$/)
    if (sessionGet && request.method === "GET") {
      const id = sessionGet[1]
      return ok(sessionRow(id, DIR, 100))
    }
    // GET /session/:id/message — production history, keyed to the requested session
    const msgList = url.pathname.match(/^\/session\/([^/]+)\/message$/)
    if (msgList && request.method === "GET") {
      return ok([historyMessage("msg_hist", msgList[1])])
    }
    // POST /session/:id/message — production promptAsync submit
    if (/^\/session\/[^/]+\/message$/.test(url.pathname) && request.method === "POST") {
      return ok({ info: { id: "msg_new", role: "user" }, parts: [] })
    }
    if (url.pathname.match(/^\/session\/[^/]+\/(todo|diff|actors|task|children|recovery)$/)) return ok([])
    return ok({})
  }) as typeof fetch
  return { fetch: fetcher, posts, gets, sessions }
}

function createEvents() {
  let fn: ((event: never) => void) | undefined
  return {
    subscribe: async (handler: (event: never) => void) => {
      fn = handler
      return () => {
        if (fn === handler) fn = undefined
      }
    },
  } as never
}

const tuiConfig = { theme: "mimocode", keybind: {} } as never

function Providers(props: {
  args?: Record<string, unknown>
  http: ReturnType<typeof createFetch>
  children: JSX.Element
}) {
  // Match production tui(): RouteProvider gets a dummy session route ONLY for
  // continue. -s must be navigated by App's onMount, never pre-routed here.
  const initialRoute = props.args?.continue ? { type: "session" as const, sessionID: "dummy" } : undefined
  return (
    <ArgsProvider {...(props.args ?? {})}>
      <ExitProvider onBeforeExit={async () => {}} onExit={async () => {}}>
        <KVProvider>
          <LanguageProvider>
            <ToastProvider>
              <RouteProvider initialRoute={initialRoute}>
                <TuiConfigProvider config={tuiConfig}>
                  <SDKProvider url="http://test" directory={DIR} fetch={props.http.fetch} events={createEvents()}>
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
  local: ReturnType<typeof useLocal>
  promptRef: ReturnType<typeof usePromptRef>
  sdk: ReturnType<typeof useSDK>
}

async function mountApp(http: ReturnType<typeof createFetch>, args: { continue?: boolean; sessionID?: string; failMount?: boolean }) {
  // App.ready() flips only after TuiPluginRuntime.init settles. Stub the heavy
  // plugin load but still run setupSlots — without it Slot stays `empty` and
  // drops children, so production Prompt (and PromptRef) never mounts.
  // C7: restore the spy on mount failure here (callers never receive `restore`)
  // and again in every teardown, independent of renderer.destroy().
  const initSpy = spyOn(TuiPluginRuntime, "init").mockImplementation(async (input) => {
    setupSlots(input.api)
  })
  const restore = () => {
    initSpy.mockRestore()
  }
  let ctx!: AppCtx
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })
  function Probe() {
    const route = useRoute()
    const sync = useSync()
    const local = useLocal()
    const promptRef = usePromptRef()
    const sdk = useSDK()
    onMount(() => {
      ctx = { route, sync, local, promptRef, sdk }
      done()
    })
    return <App />
  }
  try {
    // C7 regression seam: same catch path as a failed testRender/ready, entered
    // after the spy is live. Solid render throws hang testRender rather than
    // rejecting, so force the failure inside this try instead.
    if (args.failMount) throw new Error("forced mount failure")
    const app = await testRender(() => (
      <Providers http={http} args={args}>
        <Probe />
      </Providers>
    ))
    await ready
    return {
      app,
      ...ctx,
      http,
      restore,
    }
  } catch (error) {
    restore()
    throw error
  }
}

async function mountUserMessage(parts: Part[]) {
  const message = {
    id: "msg_1",
    role: "user",
    sessionID: "ses_x",
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
    time: { created: 1 },
  } as unknown as UserMessageT
  const viewCtx = {
    width: 80,
    sessionID: "ses_x",
    conceal: () => false,
    thinkingMode: () => "hide" as ThinkingMode,
    showThinking: () => false,
    showTimestamps: () => false,
    showDetails: () => false,
    showGenericToolOutput: () => false,
    diffWrapMode: () => "none" as const,
    providers: () => new Map(),
    sync: { data: { message: {} } } as never,
    tui: { ready: true } as never,
    freeApiSunset: () => false,
  }
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })
  function Probe() {
    onMount(done)
    return (
      <sessionViewContext.Provider value={viewCtx}>
        <UserMessageView message={message} parts={parts} onMouseUp={() => {}} index={0} />
      </sessionViewContext.Provider>
    )
  }
  const http = createFetch()
  const app = await testRender(() => (
    <Providers http={http}>
      <Probe />
    </Providers>
  ))
  await ready
  return app
}

describe("orchestrator removal TUI receipt (production paths)", () => {
  test("mode list has no orchestrator when disabled; Tab tip does not mention it", async () => {
    const fs = await import("fs/promises")
    const path = await import("path")
    const os = await import("os")
    const dir = await fs.mkdtemp(path.join(process.env.HOME || os.homedir(), "tui-orch-agent-"))
    try {
      await Instance.provide({
        directory: dir,
        fn: async () => {
          await Effect.runPromise(
            Agent.Service.use((svc) =>
              svc.list().pipe(
                Effect.map((agents) => {
                  const names = agents.map((a) => a.name)
                  expect(names).not.toContain("orchestrator")
                  expect(names).toContain("build")
                }),
              ),
            ).pipe(Effect.provide(Agent.defaultLayer)),
          )
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
    const tips = buildTipKeys("darwin")
    expect(tips).toContain("tui.tips.tab_agent")
    expect(tips).not.toContain("tui.tips.tab_agent_orchestrator")
  })

  test("production App -c continues the existing root (history + same-session submit + stable dir)", async () => {
    const http = createFetch({ sessions: { [DIR]: ["ses_existing_root"] } })
    const h = await mountApp(http, { continue: true })
    try {
      // Production continue effect navigates off the dummy route to the newest root.
      await wait(() => h.route.data.type === "session" && h.route.data.sessionID === "ses_existing_root", 8000)
      expect(h.route.data.type).toBe("session")
      if (h.route.data.type === "session") expect(h.route.data.sessionID).toBe("ses_existing_root")

      // History from the production message load path must appear in the frame.
      await wait(async () => {
        await h.app.renderOnce()
        return h.app.captureCharFrame().includes(HIST)
      }, 5000)

      // Production PromptRef: set input + submit() — the same path the user hits.
      await wait(async () => {
        await h.app.renderOnce()
        return h.promptRef.current != null
      }, 8000)
      const prompt = h.promptRef.current!
      prompt.set({ input: SUBMIT, parts: [] })
      prompt.submit()
      await wait(() => http.posts.some((p) => p.method === "POST" && p.path.includes("prompt_async")), 3000)
      const submitPosts = http.posts.filter((p) => p.method === "POST" && p.path.includes("prompt_async"))
      expect(submitPosts.length).toBeGreaterThan(0)
      // Target is the RESTORED session, chosen by production Prompt — not a
      // sessionID we passed into the SDK call.
      expect(submitPosts[0]!.path).toContain("ses_existing_root")
      expect(JSON.stringify(submitPosts[0]!.body)).toContain(SUBMIT)
      // Real SDK directory + request directory stay on the launch dir.
      // POST directory is the x-mimocode-directory header — no `?? DIR` fallback.
      expect(h.sdk.directory).toBe(DIR)
      expect(submitPosts[0]!.directory).toBe(DIR)
      expect(http.posts.filter((p) => p.method === "POST" && p.path === "/session").length).toBe(0)
    } finally {
      try {
        h.app.renderer.destroy()
      } finally {
        h.restore()
      }
    }
  }, 20000)

  test("production App -s navigates itself to the requested session (no pre-set route)", async () => {
    const http = createFetch({ sessions: { [DIR]: ["ses_target", "ses_other"] } })
    // No initialRoute for -s: production tui() only pre-routes continue.
    const h = await mountApp(http, { sessionID: "ses_target" })
    try {
      // App onMount must navigate from home → session.
      await wait(() => h.route.data.type === "session")
      expect(h.route.data.type).toBe("session")
      if (h.route.data.type === "session") expect(h.route.data.sessionID).toBe("ses_target")
      await wait(() => h.app.captureCharFrame().includes(HIST))
      expect(h.sdk.directory).toBe(DIR)
      expect(http.posts.filter((p) => p.method === "POST" && p.path === "/session").length).toBe(0)
    } finally {
      try {
        h.app.renderer.destroy()
      } finally {
        h.restore()
      }
    }
  })

  test("C7 mount failure restores TuiPluginRuntime.init", async () => {
    const original = TuiPluginRuntime.init
    const http = createFetch()
    await expect(mountApp(http, { failMount: true })).rejects.toThrow("forced mount failure")
    expect(TuiPluginRuntime.init).toBe(original)
  })

  test("mode cycle actually switches among build/plan/compose only — no orchestrator", async () => {
    // Backend /agent no longer returns orchestrator (feature deleted). Cycle the
    // production local.agent.move. With history present the free-switch lock
    // only allows build↔plan — assert a real transition inside that rule.
    const http = createFetch({ sessions: { [DIR]: ["ses_m"] }, includeOrchestrator: false })
    const h = await mountApp(http, { sessionID: "ses_m" })
    try {
      await wait(() => h.sync.data.agent.length > 0)
      await wait(() => h.local.agent.current() !== undefined)
      await wait(() => h.app.captureCharFrame().includes(HIST))
      const start = h.local.agent.current()!.name
      expect(["build", "plan", "compose"]).toContain(start)
      const seen = new Set<string>([start])
      for (let i = 0; i < 4; i++) {
        h.local.agent.move(1)
        await Bun.sleep(5)
        const cur = h.local.agent.current()?.name
        if (cur) seen.add(cur)
      }
      expect(seen.has("orchestrator")).toBe(false)
      expect([...seen].every((n) => ["build", "plan", "compose"].includes(n))).toBe(true)
      // Real state change: at least one successful switch away from start.
      expect(seen.size).toBeGreaterThan(1)
      expect(h.route.data.type).toBe("session")
      if (h.route.data.type === "session") expect(h.route.data.sessionID).toBe("ses_m")
      expect(h.sdk.directory).toBe(DIR)
    } finally {
      try {
        h.app.renderer.destroy()
      } finally {
        h.restore()
      }
    }
  })

  test("UserMessageView: synthetic actor-notification card vs same XML with synthetic:false", async () => {
    const xml = renderActorNotification({
      actorID: "child",
      description: "task",
      status: "completed",
      result: "MAIN-RESULT",
    })
    const synthetic = await mountUserMessage([{ type: "text", text: xml, synthetic: true } as Part])
    try {
      await synthetic.renderOnce()
      const frame = synthetic.captureCharFrame()
      expect(frame).toContain("Subagent completed")
      expect(frame).toContain("task")
      expect(frame).not.toContain("<actor-notification")
    } finally {
      synthetic.renderer.destroy()
    }
    const plain = await mountUserMessage([{ type: "text", text: xml, synthetic: false } as Part])
    try {
      await plain.renderOnce()
      const frame = plain.captureCharFrame()
      expect(frame).not.toContain("Subagent completed")
      expect(frame).toContain("actor-notification")
    } finally {
      plain.renderer.destroy()
    }
  })
})
