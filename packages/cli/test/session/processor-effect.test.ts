import { NodeFileSystem } from "@effect/platform-node"
import { beforeEach, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { appendFile, readFile } from "node:fs/promises"
import { EffectBridge } from "../../src/effect"
import { SyncEvent } from "../../src/sync"
import { Database, eq } from "../../src/storage"
import { EventSequenceTable } from "../../src/sync/event.sql"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionRunState } from "../../src/session/run-state"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { resetAllMonitors } from "../../src/session/try-best-detector"

void Log.init({ print: false })

beforeEach(() => {
  resetAllMonitors()
})

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  SessionRunState.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps)),
)

const it = testEffect(env)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// [TP-SR-R21-32]
it.live("execution proof precedes effects, rejects duplicate execution, and survives stale writes", () =>
  provideTmpdirServer(({ dir }) => Effect.gen(function* () {
    const { processors, session, provider } = yield* boot()
    const bridge = yield* EffectBridge.make()
    const chat = yield* session.create({})
    const parent = yield* user(chat.id, "write once")
    const message = yield* assistant(chat.id, parent.id, dir)
    const model = yield* provider.getModel(ref.providerID, ref.modelID)
    const handle = yield* processors.create({ assistantMessage: message, sessionID: chat.id, model })
    handle.registerTool("write")
    const file = path.join(dir, "effects.txt")
    const body = Effect.gen(function* () {
      const part = MessageV2.parts(message.id).find((part) => part.type === "tool")
      expect(part).toMatchObject({ execution: "started", state: { status: "running", input: { content: "once" } } })
      yield* Effect.promise(() => appendFile(file, "once\n"))
      return { title: "written", output: "saved", metadata: {} }
    })
    yield* handle.replay({
      toolCalls: [{ toolName: "write", toolCallId: "write-once", input: { content: "once" } }],
      finishReason: "tool-calls", messages: [],
      tools: { write: { execute: async () => {
        const results = await Promise.allSettled([
          bridge.promise(handle.executeTool("write", "write-once", body)),
          bridge.promise(handle.executeTool("write", "write-once", body)),
        ])
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        return results.find((result) => result.status === "fulfilled")!.value
      } } },
    })
    expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("once\n")
    const part = MessageV2.parts(message.id).find((part) => part.type === "tool")!
    if (part.type !== "tool") throw new Error("missing tool")
    const stale = { ...part, execution: "not-started" as const, state: { status: "pending" as const, input: {}, raw: "" } }
    yield* session.updatePart(stale)
    const saved = yield* session.getPart({ sessionID: chat.id, messageID: message.id, partID: part.id })
    expect(saved).toMatchObject({ execution: "started", state: part.state })
    const late = yield* handle.executeTool("write", "write-once", body).pipe(Effect.exit)
    expect(Exit.isFailure(late)).toBe(true)
    expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("once\n")
  }), { git: true, config: (url) => providerCfg(url) }),
)

// [TP-SR-R21-32]
it.live("closing a processor cancels execution awaiting input and missing persistence prevents effects", () =>
  provideTmpdirServer(({ dir }) => Effect.gen(function* () {
    const { processors, session, provider } = yield* boot()
    const bridge = yield* EffectBridge.make()
    const chat = yield* session.create({})
    const parent = yield* user(chat.id, "do not execute")
    const model = yield* provider.getModel(ref.providerID, ref.modelID)
    let effects = 0
    for (const scenario of ["waiting", "removed"] as const) {
      const message = yield* assistant(chat.id, parent.id, dir)
      const handle = yield* processors.create({ assistantMessage: message, sessionID: chat.id, model })
      handle.registerTool("write")
      const body = Effect.sync(() => { effects++; return { title: "", output: "unexpected", metadata: {} } })
      if (scenario === "waiting") {
        const waiting = yield* handle.executeTool("write", "missing", body).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* handle.replay({ toolCalls: [], finishReason: "stop", messages: [], tools: {} })
        expect(Exit.isFailure(yield* Fiber.await(waiting))).toBe(true)
      } else {
        yield* handle.replay({
          toolCalls: [{ toolName: "write", toolCallId: "removed", input: {} }],
          finishReason: "tool-calls", messages: [],
          tools: { write: { execute: () => bridge.promise(Effect.gen(function* () {
            const part = MessageV2.parts(message.id).find((part) => part.type === "tool")!
            yield* session.removePart({ sessionID: chat.id, messageID: message.id, partID: part.id })
            return yield* handle.executeTool("write", "removed", body)
          })) } },
        })
      }
    }
    expect(effects).toBe(0)
  }), { git: true, config: (url) => providerCfg(url) }),
)

// [TP-SR-R21-32]
it.live("fork preserves idle execution proof and revokes unexecuted proof while its slice is busy", () =>
  provideTmpdirServer(({ dir }) => Effect.gen(function* () {
    const { session } = yield* boot()
    const runs = yield* SessionRunState.Service
    const chat = yield* session.create({})
    const parent = yield* user(chat.id, "fork interrupted tools")
    const message = yield* assistant(chat.id, parent.id, dir)
    for (const execution of ["not-started", "started"] as const) {
      const id = PartID.ascending()
      yield* session.mutateToolPart({ sessionID: chat.id, messageID: message.id, partID: id }, () => ({
        id, sessionID: chat.id, messageID: message.id, type: "tool", tool: "write", callID: execution, execution,
        state: { status: "error", input: {}, inputComplete: execution === "started", error: "interrupted",
          metadata: { interrupted: true }, time: { start: 1, end: 2 } },
      }))
    }
    const idle = yield* session.fork({ sessionID: chat.id })
    const idleTools = (yield* session.messages({ sessionID: idle.id })).flatMap((message) => message.parts).filter((part) => part.type === "tool")
    expect(idleTools.map((part) => part.execution)).toEqual(["not-started", "started"])
    yield* runs.start(chat.id, "main", Effect.succeed({ info: message, parts: [] }), Effect.never)
    yield* Effect.addFinalizer(() => runs.cancel(chat.id))
    const active = yield* session.fork({ sessionID: chat.id })
    const activeTools = (yield* session.messages({ sessionID: active.id })).flatMap((message) => message.parts).filter((part) => part.type === "tool")
    expect(activeTools.map((part) => part.execution)).toEqual([undefined, "started"])
  }), { git: true, config: (url) => providerCfg(url) }),
)

// [TP-SR-R21-32]
it.live("fork rereads completed execution after its initial history snapshot", () =>
  provideTmpdirServer(({ dir }) => Effect.gen(function* () {
    const { session } = yield* boot()
    const runs = yield* SessionRunState.Service
    const chat = yield* session.create({})
    const parent = yield* user(chat.id, "fork concurrent execution")
    const message = yield* assistant(chat.id, parent.id, dir)
    const id = PartID.ascending()
    const identity = { sessionID: chat.id, messageID: message.id, partID: id }
    const initial: MessageV2.ToolPart = {
      id, sessionID: chat.id, messageID: message.id, type: "tool", tool: "write", callID: "fork-concurrent",
      execution: "not-started", state: { status: "pending", input: {}, raw: "" },
    }
    yield* session.mutateToolPart(identity, () => initial)
    const snapshotRead = defer<void>()
    const resumeCopy = defer<void>()
    const execute = defer<void>()
    const file = path.join(dir, "fork-effects.txt")
    const result: MessageV2.ToolStateCompleted = {
      status: "completed", input: { content: "once" }, output: "FORK_LATEST_RESULT", title: "written",
      metadata: { bytes: 5 }, time: { start: 1, end: 2 },
    }
    const owner = yield* runs.startOwned(chat.id, "main", Effect.succeed({ info: message, parts: [] }), Effect.gen(function* () {
      yield* Effect.promise(() => execute.promise)
      yield* session.mutateToolPart(identity, current => ({
        ...current!, execution: "started", state: { status: "running", input: result.input, time: { start: 1 } },
      }))
      yield* Effect.promise(() => appendFile(file, "once\n"))
      const completed = yield* session.mutateToolPart(identity, current => ({ ...current!, state: result }))
      return { info: message, parts: [completed!] }
    }))
    yield* Effect.addFinalizer(() => owner.interruptOwned)
    const originalAssert = runs.assertNotBusy
    const mutableRuns = runs as { assertNotBusy: typeof originalAssert }
    let held = false
    // fork 已读取历史；这里只延迟真实占用检查，复制与持久读取继续使用 Session 实现。
    mutableRuns.assertNotBusy = (sessionID, agentID) => Effect.gen(function* () {
      if (sessionID === chat.id && !held) {
        held = true
        snapshotRead.resolve()
        yield* Effect.promise(() => resumeCopy.promise)
      }
      return yield* originalAssert(sessionID, agentID)
    })
    try {
      const copying = yield* session.fork({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => snapshotRead.promise)
      expect(yield* session.getPart(identity)).toEqual(initial)
      expect(Exit.isFailure(yield* originalAssert(chat.id, "main").pipe(Effect.exit))).toBe(true)
      execute.resolve()
      yield* owner.awaitExit
      yield* originalAssert(chat.id, "main")
      const completed = MessageV2.ToolPart.parse(yield* session.getPart(identity))
      expect(completed).toMatchObject({ execution: "started", state: result })
      expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("once\n")
      resumeCopy.resolve()
      const forked = yield* Fiber.join(copying)
      const messages = yield* session.messages({ sessionID: forked.id })
      const forkUser = messages.find(message => message.info.role === "user")!
      const forkAssistant = messages.find(message => message.info.role === "assistant")!
      const tools = messages.flatMap(message => message.parts).filter(part => part.type === "tool")
      expect(tools).toHaveLength(1)
      expect(tools[0]).toEqual({ ...completed, id: tools[0].id, sessionID: forked.id, messageID: forkAssistant.info.id })
      expect(tools[0].id).not.toBe(id)
      expect(forkAssistant.info).toMatchObject({ parentID: forkUser.info.id })
      const trim = MessageV2.planResumeTrim(messages, forkUser.info.id)
      expect(trim.removeMessages).toEqual([])
      expect(trim.removeParts).toEqual([])
      expect(trim.messages.flatMap(message => message.parts).filter(part => part.type === "tool")).toEqual(tools)
      expect(yield* session.getPart(identity)).toEqual(completed)
      expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("once\n")
    } finally {
      mutableRuns.assertNotBusy = originalAssert
      execute.resolve()
      resumeCopy.resolve()
    }
  }), { git: true, config: (url) => providerCfg(url) }),
)

// [TP-SR-R21-32]
it.live("external part writes and sync replay cannot create unexecuted proof or erase provider facts", () =>
  provideTmpdirServer(({ dir }) => Effect.gen(function* () {
    const { session } = yield* boot()
    const chat = yield* session.create({})
    const parent = yield* user(chat.id, "proof provenance")
    const message = yield* assistant(chat.id, parent.id, dir)
    const part: MessageV2.ToolPart = {
      id: PartID.ascending(), sessionID: chat.id, messageID: message.id,
      type: "tool", tool: "write", callID: "proof", execution: "not-started",
      state: { status: "pending", input: {}, raw: "" },
    }
    expect((yield* session.updatePart(part)).execution).toBeUndefined()
    const identity = { sessionID: chat.id, messageID: message.id, partID: part.id }
    const replay = (value: MessageV2.ToolPart) => Effect.sync(() => {
      const latest = Database.use((db) => db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, chat.id)).get())
      SyncEvent.replay({
        id: `event-${PartID.ascending()}`, aggregateID: chat.id, seq: (latest?.seq ?? -1) + 1,
        type: SyncEvent.versionedType(MessageV2.Event.PartUpdated.type, MessageV2.Event.PartUpdated.version),
        data: { sessionID: chat.id, part: value, time: Date.now() },
      })
    })
    yield* replay(part)
    expect(yield* session.getPart(identity)).not.toHaveProperty("execution")
    yield* session.mutateToolPart(identity, (current) => ({ ...current!, execution: "started", metadata: { providerExecuted: true } }))
    yield* replay({ ...part, metadata: { providerExecuted: false } })
    expect(yield* session.getPart(identity)).toMatchObject({ execution: "started", metadata: { providerExecuted: true } })
    yield* session.updatePart(part)
    expect(yield* session.getPart(identity)).toMatchObject({ execution: "started", metadata: { providerExecuted: true } })
    expect(Exit.isFailure(yield* replay({ ...part, callID: "other" }).pipe(Effect.exit))).toBe(true)
  }), { git: true, config: (url) => providerCfg(url) }),
)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const stop = Date.now() + 500
          while (Date.now() < stop) {
            const text = MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")
            if (text?.time?.start) return
            await Bun.sleep(10)
          }
          throw new Error("timed out waiting for text part")
        })
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("overflow")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is MessageV2.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is MessageV2.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live(
  "session.processor effect tests reset reasoning state across retries",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          yield* llm.push(reply().reason("one").reset(), reply().reason("two").text("ok").stop())

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "reason")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const value = yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "reason" }],
            tools: {},
          })

          const parts = MessageV2.parts(msg.id)
          const reasoning = parts.filter((part): part is MessageV2.ReasoningPart => part.type === "reasoning")

          expect(value).toBe("continue")
          expect(yield* llm.calls).toBe(2)
          expect(reasoning.some((part) => part.text === "two")).toBe(true)
          expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
        }),
      { git: true, config: (url) => providerCfg(url) },
    ),
  // Connection-reset stream retry waits the network/stream backoff (~2–5s) before the second call.
  15_000,
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live(
  "session.processor effect tests publish retry status updates",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()
          const bus = yield* Bus.Service

          yield* llm.error(503, { error: "boom" })
          yield* llm.error(503, { error: "boom" })
          yield* llm.text("ok")

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const retryEvents: Array<{ attempt: number; phaseAttempt: number; maxAttempts: number; phase: string; kind: string; scope: string }> = []
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type === "retry") states.push(evt.properties.status.attempt)
        })
        const offRetry = yield* bus.subscribeCallback(Session.Event.RetryAttempt, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          retryEvents.push({
            attempt: evt.properties.attempt,
            phaseAttempt: evt.properties.phaseAttempt,
            maxAttempts: evt.properties.maxAttempts,
            phase: evt.properties.phase,
            kind: evt.properties.kind,
            scope: evt.properties.scope,
          })
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        off()
        offRetry()

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(3)
        // Recoverable kinds (network/rate_limit/server) use persistent budgets and
        // ignore phase=request / request.maxRetries. Both 503s are absorbed on the
        // llm-side server ladder. Request-phase now publishes session.status{retry}
        // so Desktop can show the reconnect row instead of a dead spinner.
        expect(states).toStrictEqual([1, 2])
      }),
      {
        git: true,
        config: (url) => ({ ...providerCfg(url), retry: { request: { maxRetries: 1 } } }),
      },
    ),
  15_000,
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("overflow")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Effect.promise(async () => {
          const end = Date.now() + 500
          while (Date.now() < end) {
            const parts = await MessageV2.parts(msg.id)
            if (parts.some((part) => part.type === "tool")) return
            await Bun.sleep(10)
          }
        })
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors; idle deferred to onIdle", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* bus.subscribeCallback(Session.Event.Error, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (!evt.properties.error) return
          errs.push(evt.properties.error.name)
          seen.resolve()
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        off()

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        // halt no longer publishes idle (RL-ORPHAN-D01): SessionRunState onIdle
        // does so after work ensuring. This test drives Processor directly, so
        // status stays busy until that lifecycle owner runs.
        expect(state).toMatchObject({ type: "busy" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        // halt no longer publishes idle (RL-ORPHAN-D01); onIdle after ensuring does.
        expect(state).toMatchObject({ type: "busy" })
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live.skip("session.processor pauses after three repeated failed bash commands", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "fix the failing tests")
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const tools = {
          bash: {
            execute: async () => ({
              title: "Run tests",
              metadata: { exit: 1 },
              output: "1 test failed",
            }),
          },
        }
        const call = (id: string) => ({
          reasoning: "run tests",
          toolCalls: [{ toolCallId: id, toolName: "bash", input: { command: "bun test" } }],
          finishReason: "tool-calls",
          tools,
          messages: [],
        })

        const first = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const firstHandle = yield* processors.create({ assistantMessage: first, sessionID: chat.id, model: mdl })
        expect(yield* firstHandle.replay(call("call_first"))).toBe("continue")

        const second = yield* assistant(chat.id, first.id, path.resolve(dir))
        const secondHandle = yield* processors.create({ assistantMessage: second, sessionID: chat.id, model: mdl })
        expect(yield* secondHandle.replay(call("call_second"))).toBe("continue")

        const third = yield* assistant(chat.id, second.id, path.resolve(dir))
        const thirdHandle = yield* processors.create({ assistantMessage: third, sessionID: chat.id, model: mdl })
        expect(yield* thirdHandle.replay(call("call_third"))).toBe("stop")
        expect(
          MessageV2.parts(third.id).some(
            (part) => part.type === "text" && part.synthetic && part.metadata?.origin?.kind === "try_best",
          ),
        ).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live.skip("session.processor preserves try-best blocking when denied tools may continue", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "run the tests")
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const tools = {
          bash: {
            execute: async () => {
              throw new Permission.RejectedError()
            },
          },
        }
        const call = (id: string) => ({
          reasoning: "run tests",
          toolCalls: [{ toolCallId: id, toolName: "bash", input: { command: "bun test" } }],
          finishReason: "tool-calls",
          tools,
          messages: [],
        })

        const first = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const firstHandle = yield* processors.create({ assistantMessage: first, sessionID: chat.id, model: mdl })
        expect(yield* firstHandle.replay(call("call_first"))).toBe("continue")

        const second = yield* assistant(chat.id, first.id, path.resolve(dir))
        const secondHandle = yield* processors.create({ assistantMessage: second, sessionID: chat.id, model: mdl })
        expect(yield* secondHandle.replay(call("call_second"))).toBe("continue")

        const third = yield* assistant(chat.id, second.id, path.resolve(dir))
        const thirdHandle = yield* processors.create({ assistantMessage: third, sessionID: chat.id, model: mdl })
        expect(yield* thirdHandle.replay(call("call_third"))).toBe("stop")
      }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        experimental: { continue_loop_on_deny: true },
      }),
    },
  ),
)
