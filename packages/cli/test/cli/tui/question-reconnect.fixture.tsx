/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { createSignal, onMount, Show } from "solid-js"
import { Schema } from "effect"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Global } from "../../../src/global"
import { Instance } from "../../../src/project/instance"
import { Question } from "../../../src/question"
import { QuestionID } from "../../../src/question/schema"
import { Session } from "../../../src/session"
import { Server } from "../../../src/server/server"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider, useSDK } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { LanguageProvider } from "../../../src/cli/cmd/tui/context/language"
import { KeybindProvider } from "../../../src/cli/cmd/tui/context/keybind"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"
import { DialogProvider } from "../../../src/cli/cmd/tui/ui/dialog"
import { QuestionPrompt } from "../../../src/cli/cmd/tui/routes/session/question"
import { tmpdir } from "../../fixture/fixture"

const questionID = Schema.encodeSync(QuestionID)

async function waitFor(fn: () => boolean | Promise<boolean>, label: string, timeout = 8000) {
  const until = Date.now() + timeout
  while (!(await fn())) {
    if (Date.now() > until) throw new Error(`Timed out: ${label}`)
    await Bun.sleep(10)
  }
}

function faultTransport() {
  const requests: { method: string; path: string; status: number; result?: unknown }[] = []
  let blocked = false
  let unblock: (() => void) | undefined
  let disconnect: (() => void) | undefined
  let connections = 0
  let stopped = false
  let pendingHttp = 0
  const controllers = new Set<AbortController>()

  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const pathname = new URL(request.url).pathname
      if (pathname !== "/global/event") {
        pendingHttp += 1
        try {
          const response = await fetch(request)
          const copy = response.clone()
          const result = pathname.startsWith("/question") ? await copy.json() : await copy.arrayBuffer()
          requests.push({
            method: request.method,
            path: pathname,
            status: response.status,
            ...(pathname.startsWith("/question") ? { result } : {}),
          })
          return response
        } finally {
          pendingHttp -= 1
        }
      }

      if (blocked)
        await new Promise<void>((resolve) => {
          unblock = resolve
        })
      if (stopped) throw new DOMException("Test transport stopped", "AbortError")
      const controller = new AbortController()
      controllers.add(controller)
      const signal = AbortSignal.any([request.signal, controller.signal])
      signal.addEventListener("abort", () => controllers.delete(controller), { once: true })
      const response = await fetch(new Request(request, { signal }))
      connections += 1
      disconnect = () => controller.abort()
      return response
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch

  return {
    fetch: fetcher,
    requests,
    get connections() {
      return connections
    },
    pause() {
      blocked = true
      disconnect?.()
    },
    resume() {
      blocked = false
      unblock?.()
      unblock = undefined
    },
    async idleHttp() {
      await waitFor(async () => {
        if (pendingHttp !== 0) return false
        // Flush SDK response parsing and any follow-up bootstrap requests.
        await new Promise<void>((resolve) => setImmediate(resolve))
        return pendingHttp === 0
      }, "HTTP requests finish before SDK cleanup")
    },
    close() {
      stopped = true
      this.resume()
      for (const controller of controllers) controller.abort()
    },
  }
}

async function mountQuestionTui() {
  const [active, setActive] = createSignal(true)
  const tmp = await tmpdir({ git: true, config: { enabled_providers: [] } })
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0, advertise: false })
  const transport = faultTransport()
  const within = <A,>(fn: () => Promise<A>) => Instance.provide({ directory: tmp.path, fn })
  const session = await within(() => AppRuntime.runPromise(Session.Service.use((svc) => svc.create({}))))
  const pending = () => within(() => AppRuntime.runPromise(Question.Service.use((svc) => svc.list())))
  const questions = [
    {
      question: "Choose an example action?",
      header: "Example",
      options: [{ label: "Continue", description: "Continue the example" }],
      custom: false,
    },
  ]
  let sync!: ReturnType<typeof useSync>
  let sdk!: ReturnType<typeof useSDK>
  let mounted!: () => void
  let connected = 0
  const receivedEvents: string[] = []
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })
  const askResults: Promise<unknown>[] = []
  const stateFile = path.join(Global.Path.state, "kv.json")
  if (!(await Bun.file(stateFile).exists())) await Bun.write(stateFile, "{}")

  function Probe() {
    sync = useSync()
    sdk = useSDK()
    sdk.event.on("event", (event) => {
      receivedEvents.push(event.payload.type)
      if (event.payload.type === "server.connected") connected += 1
    })
    onMount(mounted)
    return (
      <Show when={sync.data.question[session.id]?.[0]} fallback={<text>NO_PENDING_QUESTION</text>}>
        {(request) => <QuestionPrompt request={request()} />}
      </Show>
    )
  }

  const app = await testRender(
    () => (
      <Show when={active()}>
        <SDKProvider url={server.url.toString()} directory={tmp.path} fetch={transport.fetch}>
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
                                <Probe />
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
      </Show>
    ),
    { width: 100, height: 25 },
  )
  async function unmount() {
    const destroyed = new Promise<void>((resolve) => app.renderer.once("destroy", resolve))
    // Stop client requests while the server is alive, then release native nodes.
    setActive(false)
    transport.close()
    await new Promise<void>((resolve) => setImmediate(resolve))
    // Destruction may wait for an active render; Solid's destroy listener also
    // schedules nextTick node cleanup. Finish both before tmpdir forces GC.
    app.renderer.destroy()
    await destroyed
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  try {
    await ready
    // The initial connected packet can arrive before ready-gated children mount.
    await waitFor(() => transport.connections >= 1, "initial real SSE connection")
    await waitFor(() => sync.status === "complete", "real HTTP bootstrap")
  } catch (error) {
    await unmount()
    await server.stop(false)
    await Instance.disposeAll()
    await tmp[Symbol.asyncDispose]()
    throw error
  }

  async function wire(route: string, body?: unknown) {
    const response = await fetch(new URL(route, server.url), {
      method: "POST",
      headers: { "x-mimocode-directory": tmp.path, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, result: await response.json() }
  }

  return {
    app,
    session,
    transport,
    pending: async () => (await pending()).map((request) => ({ id: questionID(request.id) })),
    wire,
    get sync() {
      return sync
    },
    get receivedEvents() {
      return receivedEvents
    },
    get connected() {
      return connected
    },
    async ask() {
      const result = within(() =>
        AppRuntime.runPromise(Question.Service.use((svc) => svc.ask({ sessionID: session.id, questions }))),
      ).then(
        (value) => ({ outcome: "answered", value }),
        () => ({ outcome: "rejected" }),
      )
      askResults.push(result)
      await waitFor(async () => (await pending()).length === 1, "server pending question")
      const [request] = await pending()
      await waitFor(
        () => sync.data.question[session.id]?.[0]?.id === questionID(request.id),
        "asked event reached actual SyncProvider",
      )
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Choose an example action?")
      return { id: questionID(request.id) }
    },
    async close() {
      transport.resume()
      for (const request of await pending()) await wire(`/question/${questionID(request.id)}/reject`)
      await Promise.all(askResults)
      await transport.idleHttp()
      await unmount()
      await server.stop(false)
      await Instance.disposeAll()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("an actual pending modal survives HTTP instance dispose and remains answerable", async () => {
  const h = await mountQuestionTui()
  try {
    const question = await h.ask()
    expect(await h.wire("/instance/dispose")).toEqual({ status: 200, result: true })
    expect((await h.pending()).map((q) => q.id)).toEqual([question.id])
    expect(h.sync.data.question[h.session.id]?.[0]?.id).toBe(question.id)
    h.app.mockInput.pressEnter()
    await waitFor(
      () =>
        h.transport.requests.some(
          (r) =>
            r.method === "POST" && r.path === `/question/${question.id}/reply` && r.status === 200 && r.result === true,
        ),
      "answer HTTP response completes before teardown",
    )
    await waitFor(
      () => h.receivedEvents.includes("server.instance.disposed"),
      "deferred disposal triggers the TUI bootstrap",
    )
    await waitFor(async () => (await h.pending()).length === 0, "valid answer removes backend request")
    await waitFor(() => !h.sync.data.question[h.session.id]?.length, "valid answer closes actual modal")
    await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("NO_PENDING_QUESTION")
  } finally {
    await h.close()
  }
}, 30000)

test("a rejection lost during SSE disconnection is reconciled after reconnect and closes the modal", async () => {
  const h = await mountQuestionTui()
  try {
    const question = await h.ask()
    const connectedBefore = h.connected
    h.transport.pause()
    expect(await h.wire(`/question/${question.id}/reject`)).toEqual({ status: 200, result: true })
    expect(await h.pending()).toHaveLength(0)
    // The stale question stays visible while its terminal event is lost.
    expect(h.sync.data.question[h.session.id]?.[0]?.id).toBe(question.id)
    const readsBefore = h.transport.requests.filter((r) => r.path === "/question").length
    h.transport.resume()
    await waitFor(() => h.connected > connectedBefore, "real SSE reconnect after lost rejection")
    await waitFor(() => !h.sync.data.question[h.session.id]?.length, "reconnect clears the orphaned modal")
    await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("NO_PENDING_QUESTION")
    expect(h.receivedEvents).not.toContain("question.rejected")
    expect(h.transport.requests.filter((r) => r.path === "/question").slice(readsBefore)).toContainEqual({
      method: "GET",
      path: "/question",
      status: 200,
      result: [],
    })
  } finally {
    await h.close()
  }
}, 30000)

test("a still-pending modal survives a real SSE reconnect and can be rejected", async () => {
  const h = await mountQuestionTui()
  try {
    const question = await h.ask()
    const connectedBefore = h.connected
    h.transport.pause()
    expect((await h.pending()).map((q) => q.id)).toEqual([question.id])
    h.transport.resume()
    await waitFor(() => h.connected > connectedBefore, "actual SDK SSE reconnect")
    expect(h.sync.data.question[h.session.id]?.[0]?.id).toBe(question.id)
    await h.app.mockInput.pressKeys(["ESCAPE"])
    await waitFor(async () => (await h.pending()).length === 0, "valid rejection removes backend request")
    await waitFor(() => !h.sync.data.question[h.session.id]?.length, "valid rejection closes actual modal")
    await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("NO_PENDING_QUESTION")
  } finally {
    await h.close()
  }
}, 30000)
