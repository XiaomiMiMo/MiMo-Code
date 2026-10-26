import { expect, spyOn } from "bun:test"
import path from "node:path"
import os from "node:os"
import { readFile, realpath, rm } from "node:fs/promises"
import { Filesystem } from "../../src/util"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { Config } from "../../src/config"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SessionPrompt, SESSION_MEMORY_DIR_MARKER } from "../../src/session/prompt"
import { Session } from "../../src/session"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID } from "../../src/session/schema"
import { InboxTable } from "../../src/inbox/inbox.sql"
import { Database, eq } from "../../src/storage"
import { Bus } from "../../src/bus"
import { Question } from "../../src/question"
import { MessageV2 } from "../../src/session/message-v2"
import { ToolGate } from "../../src/tool/gate"
import * as Tool from "../../src/tool/tool"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, textStopResponse, toolCallsResponse } from "../lib/scripted-llm-server"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    Question.defaultLayer,
    Bus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

it.live(
  "a cancelled write queued behind a question in the same step never executes [TP-SR-R21-25]",
  () =>
    Effect.gen(function* () {
      const server = startScriptedLLMServer([
        {
          lines: toolCallsResponse([
            {
              id: "ask-user",
              name: "question",
              args: JSON.stringify({ questions: [{ question: "Continue?", header: "Continue", options: [] }] }),
            },
            {
              id: "call-write",
              name: "write",
              args: JSON.stringify({ file_path: "cancelled.txt", content: "after stop" }),
            },
          ]),
        },
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Cancellation" })
            const bus = yield* Bus.Service
            const questions = yield* Question.Service
            // Observe actual release without replacing the gate implementation.
            const leaving = spyOn(ToolGate.prototype, "leave")
            const entering = spyOn(ToolGate.prototype, "run")
            yield* Effect.addFinalizer(() => Effect.sync(() => leaving.mockRestore()))
            yield* Effect.addFinalizer(() => Effect.sync(() => entering.mockRestore()))
            const asked = yield* Deferred.make<void>()
            const queued = yield* Deferred.make<void>()
            const rejected: Question.Request["id"][] = []
            const unsubscribeRejected = yield* bus.subscribeCallback(Question.Event.Rejected, (event) => {
              if (event.properties.sessionID === session.id) rejected.push(event.properties.requestID)
            })
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribeRejected))
            const unsubscribeAsked = yield* bus.subscribeCallback(Question.Event.Asked, (event) => {
              if (event.properties.sessionID === session.id) Deferred.doneUnsafe(asked, Effect.void)
            })
            const unsubscribeQueued = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
              const part = event.properties.part
              if (
                part.sessionID === session.id &&
                part.type === "tool" &&
                part.callID === "call-write" &&
                part.state.status === "running"
              ) {
                Deferred.doneUnsafe(queued, Effect.void)
              }
            })
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribeAsked))
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribeQueued))
            yield* Effect.addFinalizer(() =>
              questions
                .list()
                .pipe(
                  Effect.flatMap((pending) =>
                    Effect.forEach(pending, (question) => questions.reject(question.id), { discard: true }),
                  ),
                ),
            )
            yield* Effect.addFinalizer(() => prompt.cancel(session.id))
            const running = yield* prompt
              .prompt({
                sessionID: session.id,
                agent: "build",
                harness: "default",
                parts: [{ type: "text", text: "Write the file" }],
              })
              .pipe(Effect.forkChild)
            yield* Deferred.await(asked).pipe(Effect.timeout("10 seconds"))
            yield* Deferred.await(queued).pipe(Effect.timeout("10 seconds"))
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "cancelled.txt")).exists())).toBe(false)
            yield* prompt.cancel(session.id)
            const result = yield* Fiber.join(running)
            expect(result.info.role === "assistant" && result.info.error?.name).toBe("MessageAbortedError")
            expect(
              entering.mock.calls.find(([tool, callID]) => tool === "question" && callID === "ask-user")?.[3]?.signal
                ?.aborted,
            ).toBe(true)
            const pendingAfterStop = yield* questions.list()
            const toolsAfterStop = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(toolsAfterStop).toHaveLength(2)
            expect(toolsAfterStop.every((part) => part.state.status === "error")).toBe(true)
            expect({ pending: pendingAfterStop, rejected }).toEqual({ pending: [], rejected: [expect.any(String)] })
            yield* Effect.promise(async () => {
              while (true) {
                const index = leaving.mock.calls.findIndex(([token]) => token.startsWith("ask-user#"))
                const gate = leaving.mock.contexts[index]
                if (gate instanceof ToolGate && gate.runningCount === 0 && gate.queuedCount === 0) return
                await Bun.sleep(10)
              }
            }).pipe(Effect.timeout("1 second"))
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "cancelled.txt")).exists())).toBe(false)
            const tools = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(tools).toHaveLength(2)
            expect(tools.every((part) => part.state.status === "error")).toBe(true)
          }),
        {
          git: true,
          config: {
            enabled_providers: ["test"],
            model: "test/model",
            provider: {
              test: {
                npm: "@ai-sdk/openai-compatible",
                env: [],
                options: { apiKey: "test-key", baseURL: `${server.origin}/v1` },
                models: {
                  model: {
                    name: "Test",
                    tool_call: true,
                    limit: { context: 32000, output: 2000 },
                    modalities: { input: ["text"], output: ["text"] },
                  },
                },
              },
            },
            agent: { build: { model: "test/model" } },
            permission: { edit: "allow", question: "allow" },
            lsp: false,
            formatter: false,
          },
        },
      )
    }),
  20000,
)

// [TP-SR-R21-32]
for (const boundary of ["body", "before", "after", "file-before-timeout", "file-after-timeout", "abort-reject"] as const) {
  it.live(`Stop waits for registered plugin settlement (${boundary})`, () => Effect.gen(function* () {
    const server = startScriptedLLMServer([
      { lines: toolCallsResponse([{ id: "plugin-call", name: "settlement_probe", args: "{}" }]) },
      { lines: textStopResponse("resumed with the original result") },
    ])
    yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
    yield* provideTmpdirInstance((dir) => Effect.gen(function* () {
      const file = (name: string) => path.join(dir, name)
      const waitFor = (name: string) => Effect.promise(async () => {
        while (!(await Bun.file(file(name)).exists())) await Bun.sleep(10)
      }).pipe(Effect.timeout("10 seconds"))
      const helper = `
import { existsSync, writeFileSync, appendFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import path from "node:path"
const directory = ${JSON.stringify(dir)}
const file = (name) => path.join(directory, name)
async function hold(signal) {
  writeFileSync(file("entered"), "yes")
  if (signal) {
    const aborted = () => writeFileSync(file("aborted"), "yes")
    if (signal.aborted) aborted()
    else signal.addEventListener("abort", aborted, { once: true })
  }
  while (!existsSync(file("release"))) await sleep(10)
}
`
      const hookName = boundary.includes("before") ? "tool.execute.before" : "tool.execute.after"
      const hook = `async (_input, output) => {
  await hold()
  ${boundary.includes("after") ? 'output.output = "hook result"; output.metadata.hook = true' : "output.args = {}"}
}`
      const body = boundary === "abort-reject"
        ? `await new Promise((_, reject) => {
            writeFileSync(file("entered"), "yes")
            const abort = () => { writeFileSync(file("aborted"), "yes"); reject(new Error("plugin cancelled")) }
            if (ctx.abort.aborted) abort()
            else ctx.abort.addEventListener("abort", abort, { once: true })
          })`
        : `${boundary === "body" ? "await hold(ctx.abort)" : ""}
          appendFileSync(file("effects"), "once\\n")
          return { output: "real result", metadata: { actual: true } }`
      yield* Effect.promise(() => Bun.write(path.join(dir, ".mimocode/plugins/settlement.ts"), `${helper}
export default async () => ({
  tool: { settlement_probe: { description: "Controlled asynchronous test tool", args: {},
    execute: async (_args, ctx) => { ${body} }
  } },
  ${boundary === "before" || boundary === "after" ? `${JSON.stringify(hookName)}: ${hook}` : ""}
})`))
      if (boundary.startsWith("file-")) {
        yield* Effect.promise(() => Bun.write(path.join(dir, ".mimocode/hooks/settlement.ts"),
          `${helper}\nexport default { ${JSON.stringify(hookName)}: ${hook} }`))
      }
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const runs = yield* SessionRunState.Service
      const session = yield* sessions.create({ title: "Plugin settlement" })
      yield* Effect.addFinalizer(() => prompt.cancel(session.id))
      yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(file("release"), "yes")))
      const running = yield* prompt.prompt({
        sessionID: session.id, agent: "build", harness: "default",
        parts: [{ type: "text", text: "Execute the controlled tool" }],
      }).pipe(Effect.forkChild)
      yield* waitFor("entered")
      if (boundary.startsWith("file-")) yield* Effect.sleep("5200 millis")
      const tools = () => sessions.messages({ sessionID: session.id }).pipe(Effect.map((messages) =>
        messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")))
      expect(yield* tools()).toMatchObject([{ execution: "started", state: { status: "running" } }])
      let stopped = false
      const stopping = yield* prompt.cancel(session.id).pipe(
        Effect.tap(() => Effect.sync(() => { stopped = true })), Effect.forkChild,
      )
      if (boundary === "body" || boundary === "abort-reject") yield* waitFor("aborted")
      if (boundary !== "abort-reject") {
        yield* Effect.sleep("100 millis")
        expect(stopped).toBe(false)
        expect((yield* runs.assertNotBusy(session.id).pipe(Effect.exit))._tag).toBe("Failure")
        expect(yield* tools()).toMatchObject([{ execution: "started", state: { status: "running" } }])
        expect(yield* Effect.promise(() => Bun.file(file("effects")).exists())).toBe(boundary.includes("after"))
        yield* Effect.promise(() => Bun.write(file("release"), "yes"))
      }
      yield* Fiber.join(stopping)
      yield* Fiber.join(running)
      yield* runs.assertNotBusy(session.id)
      const result = (yield* tools())[0]
      expect(result.execution).toBe("started")
      const completed = boundary === "body" || boundary.includes("after")
      expect(result.state.status).toBe(completed ? "completed" : "error")
      if (completed) {
        expect(result.state).toMatchObject({
          output: boundary === "after" ? "hook result" : "real result",
          metadata: { actual: true, truncated: false },
        })
        if (boundary === "file-after-timeout") expect(result.state).not.toHaveProperty("metadata.hook")
        expect(yield* Effect.promise(() => Bun.file(file("effects")).text())).toBe("once\n")
        yield* prompt.resume({ sessionID: session.id, assistantMessageID: result.messageID,
          model: { providerID: "test", modelID: "model" } })
        expect(server.captures).toHaveLength(2)
        expect(server.captures[1].messages.at(-1)?.role).toBe("tool")
        expect(yield* tools()).toEqual([result])
        expect(yield* Effect.promise(() => Bun.file(file("effects")).text())).toBe("once\n")
      } else {
        expect(yield* Effect.promise(() => Bun.file(file("effects")).exists())).toBe(false)
      }
    }), {
      git: true,
      config: {
        enabled_providers: ["test"], model: "test/model",
        provider: { test: {
          npm: "@ai-sdk/openai-compatible", env: [],
          options: { apiKey: "test-key", baseURL: `${server.origin}/v1` },
          models: { model: { name: "Test", tool_call: true, limit: { context: 32000, output: 2000 },
            modalities: { input: ["text"], output: ["text"] } } },
        } },
        agent: { build: { model: "test/model" } },
        permission: { "*": "allow" }, lsp: false, formatter: false,
      },
    })
  }), 30000)
}

function settlementConfig(origin: string): Partial<Config.Info> {
  return {
    enabled_providers: ["test"], model: "test/model",
    provider: { test: {
      npm: "@ai-sdk/openai-compatible", env: [],
      options: { apiKey: "test-key", baseURL: `${origin}/v1` },
      models: { model: { name: "Test", tool_call: true, limit: { context: 32000, output: 2000 },
        modalities: { input: ["text"], output: ["text"] } } },
    } },
    agent: { build: { model: "test/model" } },
    permission: { "*": "allow" }, lsp: false, formatter: false,
  }
}

// [TP-SR-R21-32]
for (const isError of [false, true]) {
  it.live(`Stop in MCP after hook retains the actual result and attachments (isError=${isError})`, () => Effect.gen(function* () {
    // The scripted model calls the MCP tool directly; tool-search deferral would
    // reject it before tool.execute.after runs.
    const previousSearch = process.env.MIMOCODE_MCP_TOOL_SEARCH
    process.env.MIMOCODE_MCP_TOOL_SEARCH = "false"
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      if (previousSearch === undefined) delete process.env.MIMOCODE_MCP_TOOL_SEARCH
      else process.env.MIMOCODE_MCP_TOOL_SEARCH = previousSearch
    }))
    const mcp = new McpServer({ name: "settlement", version: "1" })
    let calls = 0
    mcp.registerTool("probe", { description: "Return an actual MCP observation", inputSchema: {} }, async () => {
      calls++
      return {
        content: [
          { type: "text" as const, text: "real MCP result" },
          { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
        ],
        structuredContent: { actual: true },
        isError,
      }
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() })
    yield* Effect.promise(() => mcp.connect(transport))
    const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => transport.handleRequest(request) })
    yield* Effect.addFinalizer(() => Effect.promise(async () => { await mcp.close(); await endpoint.stop(true) }))
    const server = startScriptedLLMServer([
      { lines: toolCallsResponse([{ id: "mcp-call", name: "example_probe", args: "{}" }]) },
      { lines: textStopResponse("continued from MCP observation") },
    ])
    yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
    yield* provideTmpdirInstance((dir) => Effect.gen(function* () {
      const entered = path.join(dir, "after-entered")
      const release = path.join(dir, "after-release")
      yield* Effect.promise(() => Bun.write(path.join(dir, ".mimocode/plugins/mcp-after.ts"), `
import { existsSync, writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
export default async () => ({
  "tool.execute.after": async (input) => {
    if (input.tool !== "example_probe") return
    writeFileSync(${JSON.stringify(entered)}, "yes")
    while (!existsSync(${JSON.stringify(release)})) await sleep(10)
  }
})`))
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const runs = yield* SessionRunState.Service
      const session = yield* sessions.create({ title: "MCP after settlement" })
      yield* Effect.addFinalizer(() => prompt.cancel(session.id))
      yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(release, "yes")))
      const running = yield* prompt.prompt({ sessionID: session.id, agent: "build", harness: "default",
        parts: [{ type: "text", text: "Call the MCP tool" }] }).pipe(Effect.forkChild)
      yield* Effect.promise(async () => {
        while (!(await Bun.file(entered).exists())) await Bun.sleep(10)
      }).pipe(Effect.timeout("10 seconds"))
      expect(calls).toBe(1)
      let stopped = false
      const stopping = yield* prompt.cancel(session.id).pipe(
        Effect.tap(() => Effect.sync(() => { stopped = true })), Effect.forkChild,
      )
      yield* Effect.sleep("100 millis")
      expect(stopped).toBe(false)
      expect((yield* runs.assertNotBusy(session.id).pipe(Effect.exit))._tag).toBe("Failure")
      yield* Effect.promise(() => Bun.write(release, "yes"))
      yield* Fiber.join(stopping)
      yield* Fiber.join(running)
      const tools = () => sessions.messages({ sessionID: session.id }).pipe(Effect.map((messages) =>
        messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")))
      const result = (yield* tools())[0]
      expect(result).toMatchObject({ execution: "started", state: { status: isError ? "error" : "completed" } })
      if (result.state.status !== "completed" && result.state.status !== "error") throw new Error("MCP result did not settle")
      expect(result.state.status === "completed" ? result.state.output : result.state.error).toContain("real MCP result")
      expect(result.state.attachments).toMatchObject([{ type: "file", mime: "image/png", url: "data:image/png;base64,aGVsbG8=" }])
      expect(result.state.metadata).toMatchObject({ mcp: { structuredContent: { actual: true } } })
      yield* prompt.resume({ sessionID: session.id, assistantMessageID: result.messageID,
        model: { providerID: "test", modelID: "model" } })
      expect(calls).toBe(1)
      expect(yield* tools()).toEqual([result])
    }), { git: true, config: {
      ...settlementConfig(server.origin), mcp: { example: { type: "remote", url: endpoint.url.href, oauth: false } },
    } })
  }), 30000)
}

// [TP-SR-R21-32]
for (const guestCount of [1, 9]) {
  it.live(`Stop waits for exec registered plugin guests and closes admission (${guestCount} calls)`, () => Effect.gen(function* () {
    const server = startScriptedLLMServer([
      { lines: toolCallsResponse([{ id: "exec-call", name: "exec", args: JSON.stringify({
        code: `return await Promise.all(Array.from({ length: ${guestCount} }, () => tools.settlement_probe({})))`,
      }) }]) },
      { lines: textStopResponse("continued from exec observations") },
    ])
    yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
    yield* provideTmpdirInstance((dir) => Effect.gen(function* () {
      const file = (name: string) => path.join(dir, name)
      yield* Effect.promise(() => Bun.write(path.join(dir, ".mimocode/plugins/exec-settlement.ts"), `
import { existsSync, appendFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
const directory = ${JSON.stringify(dir)}
export default async () => ({
  tool: { settlement_probe: { description: "Asynchronous exec guest", args: {},
    execute: async (_args, ctx) => {
      appendFileSync(directory + "/started", "once\\n")
      const aborted = () => appendFileSync(directory + "/aborted", "once\\n")
      if (ctx.abort.aborted) aborted()
      else ctx.abort.addEventListener("abort", aborted, { once: true })
      while (!existsSync(directory + "/release")) await sleep(10)
      appendFileSync(directory + "/effects", "once\\n")
      return { output: "real guest result", metadata: { actual: true } }
    }
  } }
})`))
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const runs = yield* SessionRunState.Service
      const session = yield* sessions.create({ title: "Exec guest settlement" })
      yield* Effect.addFinalizer(() => prompt.cancel(session.id))
      yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(file("release"), "yes")))
      const running = yield* prompt.prompt({ sessionID: session.id, agent: "build", harness: "codex",
        parts: [{ type: "text", text: "Run the asynchronous guests through exec" }] }).pipe(Effect.forkChild)
      const admitted = Math.min(guestCount, 8)
      yield* Effect.promise(async () => {
        while (!(await Bun.file(file("started")).exists()) ||
          (await Bun.file(file("started")).text()).split("\n").length - 1 !== admitted) await Bun.sleep(10)
      }).pipe(Effect.timeout("10 seconds"))
      let stopped = false
      const stopping = yield* prompt.cancel(session.id).pipe(
        Effect.tap(() => Effect.sync(() => { stopped = true })), Effect.forkChild,
      )
      yield* Effect.promise(async () => {
        while (!(await Bun.file(file("aborted")).exists())) await Bun.sleep(10)
      }).pipe(Effect.timeout("10 seconds"))
      yield* Effect.sleep("100 millis")
      expect(stopped).toBe(false)
      expect((yield* runs.assertNotBusy(session.id).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* Effect.promise(() => Bun.file(file("effects")).exists())).toBe(false)
      yield* Effect.promise(() => Bun.write(file("release"), "yes"))
      yield* Fiber.join(stopping)
      yield* Fiber.join(running)
      yield* runs.assertNotBusy(session.id)
      const tools = () => sessions.messages({ sessionID: session.id }).pipe(Effect.map((messages) =>
        messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")))
      const result = (yield* tools())[0]
      expect(result).toMatchObject({ execution: "started", state: { status: "completed", metadata: { status: "cancelled" } } })
      if (result.state.status !== "completed") throw new Error("Exec observations did not settle")
      const nested = result.state.metadata.sub_parts as Array<{ state: { status: string; output?: string; metadata?: unknown } }>
      expect(nested).toHaveLength(guestCount)
      expect(nested.slice(0, admitted).map((part) => part.state)).toEqual(Array.from({ length: admitted }, () => expect.objectContaining({
        status: "completed", output: "real guest result", metadata: expect.objectContaining({ actual: true }),
      })))
      if (guestCount > admitted) expect(nested.at(-1)?.state.status).toBe("error")
      expect(yield* Effect.promise(() => Bun.file(file("effects")).text())).toBe("once\n".repeat(admitted))
      expect(yield* Effect.promise(() => Bun.file(file("started")).text())).toBe("once\n".repeat(admitted))
      yield* prompt.resume({ sessionID: session.id, assistantMessageID: result.messageID,
        model: { providerID: "test", modelID: "model" } })
      expect(yield* tools()).toEqual([result])
      expect(yield* Effect.promise(() => Bun.file(file("effects")).text())).toBe("once\n".repeat(admitted))
    }), { git: true, config: settlementConfig(server.origin) })
  }), 30000)
}

// [TP-SR-R21-32]
for (const withGuest of [false, true]) {
  it.live(`Stop wakes exec pending JavaScript without further bytecode (completed guest=${withGuest})`, () => Effect.gen(function* () {
    const parked = path.join(os.tmpdir(), `exec-parked-${crypto.randomUUID()}`)
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(parked, { force: true })))
    const server = startScriptedLLMServer([
      { lines: toolCallsResponse([{ id: "pending-exec", name: "exec", args: JSON.stringify({
        code: `${withGuest ? "await tools.settlement_probe({});" : ""}
await files.writeText(${JSON.stringify(parked)}, "parked");
return await new Promise(() => {});`,
      }) }]) },
      { lines: textStopResponse("continued after pending JavaScript was stopped") },
    ])
    yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
    yield* provideTmpdirInstance((dir) => Effect.gen(function* () {
      const effects = path.join(dir, "effects")
      if (withGuest) {
        yield* Effect.promise(() => Bun.write(path.join(dir, ".mimocode/plugins/completed-guest.ts"), `
import { appendFile } from "node:fs/promises"
export default async () => ({
  tool: { settlement_probe: { description: "Complete once before JavaScript waits", args: {},
    execute: async () => {
      await appendFile(${JSON.stringify(effects)}, "once\\n")
      return { output: "completed guest result", metadata: { actual: true } }
    }
  } }
})`))
      }
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const runs = yield* SessionRunState.Service
      const session = yield* sessions.create({ title: "Pending JavaScript" })
      yield* Effect.addFinalizer(() => prompt.cancel(session.id))
      const running = yield* prompt.prompt({ sessionID: session.id, agent: "build", harness: "codex",
        parts: [{ type: "text", text: "Wait after the selected work" }] }).pipe(Effect.forkChild)
      yield* Effect.promise(async () => {
        while (!(await Bun.file(parked).exists())) await Bun.sleep(10)
      }).pipe(Effect.timeout("10 seconds"))
      yield* Effect.sleep("100 millis")
      yield* prompt.cancel(session.id).pipe(Effect.timeout("3 seconds"))
      yield* Fiber.join(running)
      yield* runs.assertNotBusy(session.id)
      const tools = () => sessions.messages({ sessionID: session.id }).pipe(Effect.map((messages) =>
        messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")))
      const result = (yield* tools())[0]
      expect(result).toMatchObject({ execution: "started", state: { status: "completed", metadata: {
        status: "cancelled", toolCalls: withGuest ? 1 : 0,
      } } })
      if (result.state.status !== "completed") throw new Error("Pending exec did not settle")
      if (withGuest) {
        expect(result.state.metadata.sub_parts).toMatchObject([{ state: {
          status: "completed", output: "completed guest result", metadata: { actual: true },
        } }])
        expect(yield* Effect.promise(() => Bun.file(effects).text())).toBe("once\n")
      } else expect(result.state.metadata.sub_parts).toEqual([])
      yield* prompt.resume({ sessionID: session.id, assistantMessageID: result.messageID,
        model: { providerID: "test", modelID: "model" } })
      expect(server.captures).toHaveLength(2)
      expect(yield* tools()).toEqual([result])
      if (withGuest) expect(yield* Effect.promise(() => Bun.file(effects).text())).toBe("once\n")
    }), { git: true, config: settlementConfig(server.origin) })
  }), 20000)
}

// [TP-SR-R21-32]
it.live(
  "Stop waits for admitted exec Filesystem.write and Resume does not repeat the write",
  () => Effect.gen(function* () {
    const root = yield* Effect.promise(() => realpath(os.tmpdir()))
    const target = path.join(root, `exec-write-${crypto.randomUUID()}`)
    const payload = "real filesystem write completed\n"
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(target, { force: true })))
    const server = startScriptedLLMServer([
      { lines: toolCallsResponse([{ id: "raw-file-write", name: "exec", args: JSON.stringify({
        code: `await files.writeText(${JSON.stringify(target)}, ${JSON.stringify(payload)}); return "write completed";`,
      }) }]) },
      { lines: textStopResponse("continued after actual file write") },
    ])
    yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
    yield* provideTmpdirInstance(() => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const runs = yield* SessionRunState.Service
      const session = yield* sessions.create({ title: "Raw file settlement" })
      const entered = yield* Deferred.make<void>()
      let release!: () => void
      const waiting = new Promise<void>(resolve => { release = resolve })
      let writes = 0
      let written = false
      const originalWrite = Filesystem.write
      const writing = spyOn(Filesystem, "write").mockImplementation(async (...args: Parameters<typeof originalWrite>) => {
        if (args[0] !== target) return originalWrite(...args)
        writes++
        Deferred.doneUnsafe(entered, Effect.void)
        await waiting
        await originalWrite(...args)
        written = true
      })
      const entering = spyOn(ToolGate.prototype, "run")
      yield* Effect.addFinalizer(() => Effect.sync(() => writing.mockRestore()))
      yield* Effect.addFinalizer(() => Effect.sync(() => entering.mockRestore()))
      yield* Effect.addFinalizer(() => prompt.cancel(session.id))
      yield* Effect.addFinalizer(() => Effect.sync(release))
      const running = yield* prompt.prompt({ sessionID: session.id, agent: "build", harness: "codex",
        parts: [{ type: "text", text: "Write through the raw file interface" }] }).pipe(Effect.forkChild)
      yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"))
      const signal = entering.mock.calls.find(([, callID]) => callID === "raw-file-write")?.[3]?.signal
      if (!signal) throw new Error("Exec did not enter its cancellation-aware tool gate")
      const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
      let stopped = false
      const stopping = yield* prompt.cancel(session.id).pipe(
        Effect.tap(() => Effect.sync(() => { stopped = true })), Effect.forkChild,
      )
      yield* Effect.promise(() => aborted).pipe(Effect.timeout("3 seconds"))
      yield* Effect.sleep("100 millis")
      expect(stopped).toBe(false)
      expect(written).toBe(false)
      expect(writes).toBe(1)
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
      expect((yield* runs.assertNotBusy(session.id).pipe(Effect.exit))._tag).toBe("Failure")
      const before = (yield* sessions.messages({ sessionID: session.id }))
        .flatMap((message) => message.parts).find((part) => part.type === "tool")
      expect(before).toMatchObject({ execution: "started", state: { status: "running" } })
      release()
      yield* Fiber.join(stopping).pipe(Effect.timeout("3 seconds"))
      yield* Fiber.join(running)
      expect(stopped).toBe(true)
      expect(written).toBe(true)
      expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe(payload)
      yield* runs.assertNotBusy(session.id)
      const tools = () => sessions.messages({ sessionID: session.id }).pipe(Effect.map((messages) =>
        messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")))
      const result = (yield* tools())[0]
      expect(result).toMatchObject({ execution: "started", state: { status: "completed", metadata: {
        status: "cancelled", toolCalls: 0, sub_parts: [],
      } } })
      yield* prompt.resume({ sessionID: session.id, assistantMessageID: result.messageID,
        model: { providerID: "test", modelID: "model" } })
      expect(server.captures).toHaveLength(2)
      expect(yield* tools()).toEqual([result])
      expect(writes).toBe(1)
      expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe(payload)
    }), { git: true, config: settlementConfig(server.origin) })
  }),
  20000,
)

// [TP-RUN-R4-09] [TP-CA-R8-09]
for (const recovery of ["send", "resume", "edit"] as const) {
  it.live(
    `Stop during cold ToolRegistry initialization allows ${recovery} in the same instance`,
    () =>
      Effect.gen(function* () {
        const server = startScriptedLLMServer([{ lines: textStopResponse("recovered request completed") }])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "Cold initialization cancellation" })
              const entered = yield* Deferred.make<void>()
              const release = yield* Deferred.make<void>()
              const original = Tool.init
              const gated: typeof Tool.init = (info) =>
                info.id === "bash"
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(Effect.suspend(() => original(info))),
                    )
                  : original(info)
              const initialize = spyOn(Tool, "init").mockImplementation(gated)
              yield* Effect.addFinalizer(() => Effect.sync(() => initialize.mockRestore()))
              yield* Effect.addFinalizer(() => prompt.cancel(session.id))
              const firstMessageID = MessageID.ascending()
              const first = yield* prompt
                .prompt({
                  sessionID: session.id,
                  messageID: firstMessageID,
                  agent: "build",
                  harness: "default",
                  parts: [{ type: "text", text: "First cold request" }],
                })
                .pipe(Effect.forkChild)
              yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"))
              yield* prompt.cancel(session.id)
              const firstResult = yield* Fiber.join(first)
              const stopped = yield* sessions.messages({ sessionID: session.id })
              const interrupted = stopped.find((message) => message.info.role === "assistant")
              expect(interrupted?.info).toMatchObject({
                parentID: firstMessageID,
                error: { name: "MessageAbortedError", data: { message: "Aborted" } },
              })
              const receipts = Database.use((db) => db.select().from(InboxTable)
                .where(eq(InboxTable.receiver_session_id, session.id)).all())
              expect(receipts).toHaveLength(1)
              expect(receipts[0]).toMatchObject({
                input_message_id: firstMessageID,
                state: "cancelled",
                outcome: "never_ran",
                consumed: false,
                delivery_message_id: null,
              })
              expect(server.captures).toHaveLength(0)
              if (interrupted?.info.role !== "assistant") throw new Error("missing interrupted assistant")
              expect(firstResult).toEqual(interrupted)
              const originalParentID = interrupted.info.parentID
              const originalUser = stopped.find((message) => message.info.id === originalParentID)!
              if (recovery === "edit") {
                expect(stopped.map((message) => message.info.role)).toEqual(["user", "assistant"])
                for (const message of [...stopped].reverse()) {
                  yield* sessions.removeMessage({ sessionID: session.id, messageID: message.info.id })
                }
                expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
              }
              yield* Deferred.succeed(release, undefined)
              const text = recovery === "edit" ? "Edited question after Stop" : "Fresh request after Stop"
              const next = yield* recovery === "resume"
                ? prompt.resume({ sessionID: session.id, assistantMessageID: interrupted.info.id })
                : prompt.prompt({
                    sessionID: session.id,
                    agent: "build",
                    harness: "default",
                    parts: [{ type: "text", text }],
                  })
              const after = yield* sessions.messages({ sessionID: session.id })
              const users = after.filter((message) => message.info.role === "user")
              expect(users).toHaveLength(recovery === "send" ? 2 : 1)
              if (recovery === "edit") {
                expect(after).toHaveLength(2)
                expect(after.some((message) => stopped.some((old) => old.info.id === message.info.id))).toBe(false)
                expect(
                  users[0].parts.filter((part) => !(part.type === "text" && part.text.includes(SESSION_MEMORY_DIR_MARKER))),
                ).toEqual([expect.objectContaining({ type: "text", text })])
                expect(JSON.stringify(after)).not.toContain("First cold request")
              } else {
                const retainedUser = after.find((message) => message.info.id === originalUser.info.id)!
                expect(retainedUser.info).toMatchObject(originalUser.info)
                expect(retainedUser.parts).toEqual(originalUser.parts)
              }
              expect(next.info.id).not.toBe(interrupted.info.id)
              expect(next.info).toMatchObject({
                role: "assistant",
                parentID: users.at(-1)!.info.id,
                time: { completed: expect.any(Number) },
              })
              expect(next.info.role === "assistant" ? next.info.error : undefined).toBeUndefined()
              expect(server.captures).toHaveLength(1)
              expect(server.captures[0].messages.at(-1)?.role).toBe("user")
              expect(JSON.stringify(server.captures[0].messages)).toContain(
                recovery === "resume" ? "First cold request" : text,
              )
              if (recovery === "edit") {
                expect(JSON.stringify(server.captures[0].messages)).not.toContain("First cold request")
                expect(server.captures[0].messages.filter((message) => message.role === "user")).toHaveLength(1)
              }
              expect(
                next.parts.some((part) => part.type === "text" && part.text === "recovered request completed"),
              ).toBe(true)
            }),
          {
            git: true,
            config: {
              enabled_providers: ["test"],
              model: "test/model",
              provider: {
                test: {
                  npm: "@ai-sdk/openai-compatible",
                  env: [],
                  options: { apiKey: "test-key", baseURL: `${server.origin}/v1` },
                  models: {
                    model: {
                      name: "Test",
                      tool_call: true,
                      limit: { context: 32000, output: 2000 },
                      modalities: { input: ["text"], output: ["text"] },
                    },
                  },
                },
              },
              agent: { build: { model: "test/model" } },
              lsp: false,
              formatter: false,
            },
          },
        )
      }),
    20000,
  )
}

// [TP-SR-R21-28] [TP-SR-R21-30] [TP-SR-R21-32] [TP-SR-R21-33]
for (const boundary of ["partial", "complete-empty"] as const) {
  it.live(
    `Stop preserves the actual tool input boundary (${boundary})`,
    () =>
      Effect.gen(function* () {
        const callID = "interrupted-input"
        const tool = boundary === "partial" ? "bash" : "plan_exit"
        const lines = toolCallsResponse([
          { id: callID, name: tool, args: boundary === "partial" ? '{"command":' : "{}" },
        ])
        const stream =
          boundary === "partial"
            ? new ReadableStream<Uint8Array>({
                start(controller) {
                  for (const line of lines.slice(0, -2)) controller.enqueue(new TextEncoder().encode(line))
                },
              })
            : undefined
        const server = startScriptedLLMServer([
          { lines, stream },
          ...(boundary === "partial" ? [{ status: 400, lines: [JSON.stringify({ error: { message: "model unavailable" } })] }] : []),
          { lines: textStopResponse("continued from a complete tool invocation") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const questions = yield* Question.Service
              const session = yield* sessions.create({ title: "Interrupted input provenance" })
              const reached = yield* Deferred.make<void>()
              const unsubscribe = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
                const part = event.properties.part
                if (
                  part.sessionID === session.id &&
                  part.type === "tool" &&
                  part.callID === callID &&
                  part.state.status === (boundary === "partial" ? "pending" : "running")
                )
                  Deferred.doneUnsafe(reached, Effect.void)
              })
              yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
              yield* Effect.addFinalizer(() => prompt.cancel(session.id))
              const running = yield* prompt
                .prompt({
                  sessionID: session.id,
                  agent: boundary === "partial" ? "build" : "plan",
                  harness: "default",
                  parts: [{ type: "text", text: "Use the requested tool." }],
                })
                .pipe(Effect.forkChild)
              yield* Deferred.await(reached).pipe(Effect.timeout("10 seconds"))
              if (boundary === "complete-empty") {
                while ((yield* questions.list()).length === 0) yield* Effect.sleep("10 millis")
              }
              const beforeStop = yield* sessions.messages({ sessionID: session.id })
              const beforeTool = beforeStop
                .flatMap((message) => message.parts)
                .find((part) => part.type === "tool" && part.callID === callID)
              expect(beforeTool?.type).toBe("tool")
              if (beforeTool?.type !== "tool") throw new Error("missing streamed tool")
              expect(beforeTool.state.status).toBe(boundary === "partial" ? "pending" : "running")
              expect(beforeTool.state.input).toEqual({})
              yield* prompt.cancel(session.id)
              yield* Fiber.join(running)
              const stopped = yield* sessions.messages({ sessionID: session.id })
              const carrier = stopped.find((message) =>
                message.parts.some((part) => part.type === "tool" && part.callID === callID),
              )!
              const stoppedTool = carrier.parts.find((part) => part.type === "tool" && part.callID === callID)!
              expect(stoppedTool.type === "tool" && stoppedTool.state.status).toBe("error")
              const deleted: string[] = []
              const off = Bus.subscribe(MessageV2.Event.Removed, (event) => {
                if (event.properties.sessionID === session.id) deleted.push(event.properties.messageID)
              })
              yield* Effect.addFinalizer(() => Effect.sync(off))
              let target = carrier.info.id
              if (boundary === "partial") {
                yield* prompt.resume({ sessionID: session.id, assistantMessageID: target,
                  model: { providerID: "test", modelID: "unavailable" } })
                expect(server.captures).toHaveLength(2)
                expect(server.captures[1].model).toBe("unavailable")
                const failed = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                expect(failed.info.role === "assistant" && failed.info.error).toBeTruthy()
                target = failed.info.id
              }
              const resumed = yield* prompt
                .resume({ sessionID: session.id, assistantMessageID: target,
                  model: { providerID: "test", modelID: "model" } })
                .pipe(Effect.exit)
              expect(resumed._tag).toBe("Success")
              expect(stoppedTool).toMatchObject({
                execution: boundary === "partial" ? "not-started" : "started",
                state: { status: "error", input: {}, inputComplete: boundary === "complete-empty" },
              })
              const after = yield* sessions.messages({ sessionID: session.id })
              if (boundary === "partial") {
                expect(server.captures).toHaveLength(3)
                expect(server.captures[2].model).toBe("model")
                expect(server.captures[2].messages.at(-1)?.role).toBe("user")
                expect(after.some((message) => message.info.id === carrier.info.id)).toBe(false)
                expect(deleted).toContain(carrier.info.id)
              } else {
                expect(server.captures).toHaveLength(2)
                expect(server.captures[1].messages.at(-1)?.role).toBe("tool")
                expect(after.find((message) => message.info.id === carrier.info.id)?.parts).toEqual(carrier.parts)
                expect(
                  after.filter((message) => message.info.role === "user").map((message) => message.info.id),
                ).toEqual(stopped.filter((message) => message.info.role === "user").map((message) => message.info.id))
              }
            }),
          {
            git: true,
            config: {
              enabled_providers: ["test"],
              model: "test/model",
              provider: {
                test: {
                  npm: "@ai-sdk/openai-compatible",
                  env: [],
                  options: { apiKey: "test-key", baseURL: `${server.origin}/v1` },
                  models: {
                    unavailable: {
                      name: "Unavailable",
                      tool_call: true,
                      limit: { context: 32000, output: 2000 },
                      modalities: { input: ["text"], output: ["text"] },
                    },
                    model: {
                      name: "Test",
                      tool_call: true,
                      limit: { context: 32000, output: 2000 },
                      modalities: { input: ["text"], output: ["text"] },
                    },
                  },
                },
              },
              agent: { build: { model: "test/model" }, plan: { model: "test/model" } },
              permission: { question: "allow" },
              lsp: false,
              formatter: false,
            },
          },
        )
      }),
    30000,
  )
}
