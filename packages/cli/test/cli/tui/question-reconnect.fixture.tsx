/** @jsxImportSource @opentui/solid */
import { expect } from "bun:test"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { onMount, Show } from "solid-js"
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

export async function waitFor(fn: () => boolean | Promise<boolean>, label: string, timeout = 8000) {
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
  const controllers = new Set<AbortController>()
  const pumps = new Set<Promise<void>>()

  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const pathname = new URL(request.url).pathname
      if (pathname !== "/global/event") {
        const response = await fetch(request)
        requests.push({
          method: request.method,
          path: pathname,
          status: response.status,
          ...(pathname.startsWith("/question") ? { result: await response.clone().json() } : {}),
        })
        return response
      }

      if (blocked)
        await new Promise<void>((resolve) => {
          unblock = resolve
        })
      if (stopped) throw new DOMException("Test transport stopped", "AbortError")
      const controller = new AbortController()
      controllers.add(controller)
      const upstream = await fetch(
        new Request(request, {
          signal: AbortSignal.any([request.signal, controller.signal]),
        }),
      )
      const reader = upstream.body!.getReader()
      connections += 1
      let closed = false
      const stream = new ReadableStream<Uint8Array>({
        start(output) {
          const close = () => {
            if (closed) return
            closed = true
            output.close()
          }
          disconnect = () => {
            close()
            controller.abort()
          }
          const pump = (async () => {
            try {
              while (true) {
                const next = await reader.read()
                if (next.done || closed) break
                output.enqueue(next.value)
              }
            } catch (error) {
              if (!controller.signal.aborted && !request.signal.aborted && !closed) output.error(error)
            } finally {
              close()
              controllers.delete(controller)
            }
          })()
          pumps.add(pump)
          void pump.finally(() => pumps.delete(pump))
        },
        cancel() {
          closed = true
          controller.abort()
        },
      })
      return new Response(stream, { status: upstream.status, headers: upstream.headers })
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
    async close() {
      stopped = true
      this.resume()
      for (const controller of controllers) controller.abort()
      await Promise.all(pumps)
    },
  }
}

export async function mountQuestionTui() {
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
    ),
    { width: 100, height: 25 },
  )
  try {
    await ready
    // The initial connected packet can arrive before ready-gated children mount.
    await waitFor(() => transport.connections >= 1, "initial real SSE connection")
    await waitFor(() => sync.status === "complete", "real HTTP bootstrap")
  } catch (error) {
    await transport.close()
    await server.stop(false)
    app.renderer.destroy()
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
      await transport.close()
      await server.stop(false)
      app.renderer.destroy()
      await Instance.disposeAll()
      await tmp[Symbol.asyncDispose]()
    },
  }
}
