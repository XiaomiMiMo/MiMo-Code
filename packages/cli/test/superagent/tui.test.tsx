/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { ActorRegistry } from "../../src/actor/registry"
import { TaskRegistry } from "../../src/task/registry"
import { testRender } from "@opentui/solid"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { KVProvider } from "../../src/cli/cmd/tui/context/kv"
import { LanguageProvider, useLanguage } from "../../src/cli/cmd/tui/context/language"
import { RouteProvider } from "../../src/cli/cmd/tui/context/route"
import { SDKProvider } from "../../src/cli/cmd/tui/context/sdk"
import { TuiConfigProvider } from "../../src/cli/cmd/tui/context/tui-config"
import { ThemeProvider } from "../../src/cli/cmd/tui/context/theme"
import { ExitProvider } from "../../src/cli/cmd/tui/context/exit"
import { KeybindProvider } from "../../src/cli/cmd/tui/context/keybind"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { ArgsProvider } from "../../src/cli/cmd/tui/context/args"
import { ProjectProvider } from "../../src/cli/cmd/tui/context/project"
import { SyncProvider } from "../../src/cli/cmd/tui/context/sync"
import { LocalProvider } from "../../src/cli/cmd/tui/context/local"
import { ToastProvider } from "../../src/cli/cmd/tui/ui/toast"
import { DialogProvider } from "../../src/cli/cmd/tui/ui/dialog"
import { CommandProvider } from "../../src/cli/cmd/tui/component/dialog-command"
import { FrecencyProvider } from "../../src/cli/cmd/tui/component/prompt/frecency"
import { PromptHistoryProvider } from "../../src/cli/cmd/tui/component/prompt/history"
import { PromptStashProvider } from "../../src/cli/cmd/tui/component/prompt/stash"
import { PromptRefProvider, usePromptRef } from "../../src/cli/cmd/tui/context/prompt"
import { Global } from "../../src/global"
import * as Runtime from "../../src/superagent/runtime"
import { textStopResponse } from "../lib/scripted-llm-server"
import * as D from "../../src/superagent/dispatcher"
import { Database, eq } from "../../src/storage"
import { ActionTable } from "../../src/superagent/superagent.sql"
import { tmpdir } from "../fixture/fixture"

import { App } from "../../src/cli/cmd/tui/app"
import { TuiPluginRuntime } from "../../src/cli/cmd/tui/plugin"

let modelServer: ReturnType<typeof Bun.serve> | undefined
afterEach(async () => {
  await TuiPluginRuntime.dispose()
  await Runtime.stop()
  await Instance.disposeAll()
  await modelServer?.stop(true)
})
test("task center opens complete native conversations, streams messages and returns to tasks", async () => {
  modelServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(textStopResponse("One task is waiting for your branch confirmation.").join(""), {
        headers: { "Content-Type": "text/event-stream" },
      }),
  })
  await using tmp = await tmpdir({
    git: true,
    config: {
      model: "test/model",
      small_model: "test/model",
      enabled_providers: ["test"],
      provider: {
        test: {
          npm: "@ai-sdk/openai-compatible",
          name: "Test",
          options: { baseURL: `${modelServer.url.origin}/v1`, apiKey: "test-key" },
          models: {
            model: {
              name: "Test model",
              tool_call: true,
              limit: { context: 100000, output: 8000 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
    },
  })
  await Bun.write(`${Global.Path.state}/kv.json`, JSON.stringify({ locale: "zh", agreement_accepted: true }))
  const input = D.request(
    tmp.path,
    { channel: "local", eventId: "ui-example", threadId: "ui-thread", senderId: "user" },
    "Review example change",
  )
  const ticket = D.create(tmp.path, input.id, "检查并修复示例变更")
  const seeded = await Runtime.at(
    tmp.path,
    Effect.gen(function* () {
      const sessions = yield* Session.Service,
        actors = yield* ActorRegistry.Service,
        tasks = yield* TaskRegistry.Service
      const session = yield* sessions.create({ title: "Example task Worker" })
      yield* actors.updateAgent(session.id, "main", "superagent-worker")
      yield* actors.updateStatus(session.id, "main", { status: "idle" })
      const todo = yield* tasks.create({ session_id: session.id, summary: "复现问题并运行检查", owner: "main" })
      yield* tasks.start({ session_id: session.id, id: todo.id })
      const mid = MessageID.ascending()
      yield* sessions.updateMessage({
        id: mid,
        sessionID: session.id,
        agentID: "main",
        role: "user",
        time: { created: Date.now() },
        agent: "superagent-worker",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("model") },
      })
      const aid = MessageID.ascending(),
        part = PartID.ascending()
      yield* sessions.updateMessage({
        id: aid,
        parentID: mid,
        sessionID: session.id,
        agentID: "main",
        role: "assistant",
        agent: "superagent-worker",
        mode: "superagent-worker",
        path: { cwd: tmp.path, root: tmp.path },
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("model"),
        cost: 0,
        tokens: { input: 30, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now(), completed: Date.now() },
      })
      yield* sessions.updatePart({
        id: part,
        messageID: aid,
        sessionID: session.id,
        type: "text",
        text: "我已检查变更，正在等待你确认目标分支。",
      })
      return { session, aid, part }
    }),
  )
  ticket.workerSessionId = seeded.session.id
  ticket.workerActorId = "main"
  ticket.worktree = tmp.path
  D.save(ticket)
  D.report(ticket, 0, { state: "blocked", summary: "等待目标分支", humanAction: "请确认修改应该提交到哪个分支？" })
  Database.use((db) => db.update(ActionTable).set({ state: "done" }).where(eq(ActionTable.ticket_id, ticket.id)).run())
  Database.use((db) =>
    db
      .update(ActionTable)
      .set({ state: "done" })
      .where(eq(ActionTable.key, `route:${input.id}`))
      .run(),
  )
  const transport = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(request, init)
    return Server.Default().app.request(req)
  }) as typeof fetch
  const subscriptions: (() => void)[] = []
  let language: ReturnType<typeof useLanguage> | undefined
  let promptRef: ReturnType<typeof usePromptRef> | undefined
  const Probe = () => {
    language = useLanguage()
    promptRef = usePromptRef()
    return <App />
  }
  const app = await testRender(
    () => (
      <ArgsProvider>
        <ExitProvider onExit={async () => {}}>
          <KVProvider>
            <LanguageProvider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "superagent" }}>
                  <TuiConfigProvider config={{ keybinds: { app_exit: "ctrl+c" } }}>
                    <SDKProvider
                      url="http://example.test"
                      directory={tmp.path}
                      fetch={transport}
                      events={{
                        subscribe: async (handler) => {
                          const listener = (event: GlobalEvent) =>
                            handler({ ...event, directory: event.directory ?? tmp.path })
                          GlobalBus.on("event", listener)
                          const unsubscribe = () => {
                            GlobalBus.off("event", listener)
                          }
                          subscriptions.push(unsubscribe)
                          return unsubscribe
                        },
                      }}
                    >
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
                                          <PromptRefProvider>
                                            <Probe />
                                          </PromptRefProvider>
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
    ),
    { width: 180, height: 60, exitOnCtrlC: false },
  )

  try {
    const frame = async (...texts: string[]) => {
      const end = Date.now() + 8000
      while (Date.now() < end) {
        await app.renderOnce()
        if (texts.every((t) => app.captureCharFrame().includes(t))) return app.captureCharFrame()
        await Bun.sleep(30)
      }
      throw new Error(`Expected ${texts.join(", ")}\n${app.captureCharFrame()}`)
    }
    const click = async (text: string) => {
      const rows = app.captureCharFrame().split("\n"),
        row = rows.findIndex((x) => x.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      const prefix = rows[row].slice(0, rows[row].indexOf(text))
      const column = Bun.stringWidth(prefix)
      await app.mockMouse.click(column + 1, row)
    }
    const capture = async (name: string) => {
      if (!process.env.MIMOCODE_SUPERAGENT_CAPTURE_DIR) return
      const c = app.captureSpans()
      await Bun.write(
        `${process.env.MIMOCODE_SUPERAGENT_CAPTURE_DIR}/${name}.json`,
        JSON.stringify({
          cols: c.cols,
          rows: c.rows,
          lines: c.lines.map((l) =>
            l.spans.map((s) => ({ text: s.text, width: s.width, fg: s.fg.toInts(), bg: s.bg.toInts() })),
          ),
        }),
      )
    }
    await frame("任务中心", "请确认修改应该提交到哪个分支？", "复现问题并运行检查")
    await capture("task-center")
    await click("进入 Worker 对话")
    await frame("任务中心 Esc", "我已检查变更", "原 Worker 继续处理")
    await Runtime.at(
      tmp.path,
      Session.Service.use((s) =>
        s.updatePart({
          id: seeded.part,
          messageID: seeded.aid,
          sessionID: seeded.session.id,
          type: "text",
          text: "我已检查变更，实时更新已收到。",
        }),
      ),
    )
    await frame("实时更新已收到")
    await capture("worker-native")
    app.mockInput.pressEscape()
    await frame("MiMo · 任务中心", "请确认修改应该提交到哪个分支？")
    await app.mockInput.typeText("How many tasks are active?")
    app.mockInput.pressEnter()
    await frame("Router 负责归属", "任务中心 Esc")
    await frame("One task is waiting for your branch confirmation.")
    const settled = Date.now() + 8000
    while (app.captureCharFrame().includes("QUEUED") && Date.now() < settled) {
      await app.renderOnce()
      await Bun.sleep(30)
    }
    expect(app.captureCharFrame()).not.toContain("QUEUED")
    await capture("router-native")
    expect(promptRef?.current?.current.input).toBe("")
    app.mockInput.pressEscape()
    await frame("MiMo · 任务中心")
  } finally {
    app.renderer.destroy()
    for (const off of subscriptions) off()
  }
}, 40000)
