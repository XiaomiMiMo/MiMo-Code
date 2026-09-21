import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import type { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, textStopResponse, toolCallsResponse } from "../lib/scripted-llm-server"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Permission.defaultLayer,
    Bus.defaultLayer,
  ),
)
const cancelled = "Tool call cancelled because an earlier tool call in this response failed."
const edit = { name: "edit", args: { file_path: "source.txt", old_string: "absent", new_string: "replacement" } }
const bash = { name: "bash", args: { command: "printf executed > marker.txt", description: "Create local marker" } }
const write = { name: "write", args: { file_path: "marker.txt", content: "executed" } }

const cases = [
  {
    title: "an unmatched edit cancels the following bash",
    first: edit,
    next: bash,
    error: "String to replace not found",
    runs: false,
  },
  {
    title: "editing a missing file cancels the following bash",
    first: { name: "edit", args: { file_path: "missing.txt", old_string: "old", new_string: "new" } },
    next: bash,
    error: "not found",
    runs: false,
  },
  {
    title: "a failed read allows the following bash",
    first: { name: "read", args: { file_path: "missing.txt" } },
    next: bash,
    error: "File not found",
    runs: true,
  },
  {
    title: "invalid edit arguments cancel the following bash",
    first: { name: "edit", args: { file_path: "source.txt", new_string: "replacement" } },
    next: bash,
    error: "Invalid arguments for the edit tool",
    runs: false,
  },
  ...["read", "grep", "glob"].map((name) => ({
    title: `invalid ${name} arguments cancel the following bash`,
    first: { name, args: name === "read" ? { file_path: 123 } : { pattern: 123 } },
    next: bash,
    error: `Invalid arguments for the ${name} tool`,
    runs: false,
  })),
  {
    title: "a nonzero bash exit cancels the following write",
    first: { name: "bash", args: { command: "printf original-failure; exit 7", description: "Fail locally" } },
    next: write,
    error: "original-failure",
    runs: false,
  },
  {
    title: "hook cancellation of a write cancels the following write",
    first: { name: "write", args: { file_path: "blocked.txt", content: "must not execute" } },
    next: write,
    error: "Write rejected by test hook",
    hook: true,
    runs: false,
  },
  {
    title: "an MCP error result cancels the following write",
    first: { name: "example_fail", args: {} },
    next: write,
    error: "MCP fixture failure",
    mcp: true,
    runs: false,
  },
  ...["1", "true"].map((disable) => ({
    title: `cascade opt-out ${disable} allows bash after a failed edit`,
    first: edit,
    next: bash,
    error: "String to replace not found",
    disable,
    runs: true,
  })),
  {
    title: "flooding opt-out leaves failure cascade enabled",
    first: edit,
    next: bash,
    error: "String to replace not found",
    flooding: "1",
    runs: false,
  },
] satisfies Array<{
  title: string
  first: { name: string; args: Record<string, unknown> }
  next: { name: string; args: Record<string, unknown> }
  error: string
  runs: boolean
  disable?: string
  flooding?: string
  hook?: boolean
  mcp?: boolean
}>

for (const entry of cases)
  it.live(
    entry.title,
    () =>
      Effect.gen(function* () {
        const previous = {
          cascade: process.env.MIMOCODE_DISABLE_FAIL_CASCADE,
          flooding: process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT,
        }
        delete process.env.MIMOCODE_DISABLE_FAIL_CASCADE
        delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
        if ("disable" in entry) process.env.MIMOCODE_DISABLE_FAIL_CASCADE = entry.disable
        if ("flooding" in entry) process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = entry.flooding
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous.cascade == null) delete process.env.MIMOCODE_DISABLE_FAIL_CASCADE
            else process.env.MIMOCODE_DISABLE_FAIL_CASCADE = previous.cascade
            if (previous.flooding == null) delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
            else process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = previous.flooding
          }),
        )
        const server = startScriptedLLMServer([
          {
            lines: toolCallsResponse([
              { id: "first", name: entry.first.name, args: JSON.stringify(entry.first.args) },
              { id: "following", name: entry.next.name, args: JSON.stringify(entry.next.args) },
              { id: "read-after", name: "read", args: JSON.stringify({ file_path: "source.txt" }) },
            ]),
          },
          {
            lines: toolCallsResponse([
              {
                id: "recovery",
                name: "write",
                args: JSON.stringify({ file_path: "recovery.txt", content: "recovered" }),
              },
            ]),
          },
          { lines: textStopResponse("Recovered") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        const mcp =
          "mcp" in entry && entry.mcp
            ? yield* Effect.acquireRelease(
                Effect.sync(() =>
                  Bun.serve({
                    hostname: "127.0.0.1",
                    port: 0,
                    async fetch(request) {
                      if (request.method !== "POST") return new Response(null, { status: 405 })
                      const message: unknown = await request.json()
                      if (!message || typeof message !== "object" || !("method" in message) || !("id" in message)) {
                        return new Response(null, { status: 202 })
                      }
                      if (message.id == null) return new Response(null, { status: 202 })
                      const result =
                        message.method === "initialize"
                          ? {
                              protocolVersion: "2024-11-05",
                              capabilities: { tools: {} },
                              serverInfo: { name: "test-server", version: "1" },
                            }
                          : message.method === "tools/list"
                            ? { tools: [{ name: "fail", inputSchema: { type: "object", properties: {} } }] }
                            : { content: [{ type: "text", text: "MCP fixture failure" }], isError: true }
                      return Response.json({ jsonrpc: "2.0", id: message.id, result })
                    },
                  }),
                ),
                (server) => Effect.promise(() => server.stop(true)),
              )
            : undefined
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => Bun.write(path.join(dir, "source.txt"), "original"))
              if ("hook" in entry && entry.hook)
                yield* Effect.promise(async () => {
                  await fs.mkdir(path.join(dir, ".mimocode", "hooks"), { recursive: true })
                  await fs.writeFile(
                    path.join(dir, ".mimocode", "hooks", "cancel-write.ts"),
                    `export default {
  "tool.execute.before": async (input, output) => {
    if (input.tool !== "write" || output.args.file_path !== "blocked.txt") return
    output.cancel = true
    output.cancelReason = "Write rejected by test hook"
  }
}`,
                  )
                })
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "Failure cascade" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                harness: "default",
                parts: [{ type: "text", text: "Run the tools in order and recover from failures" }],
              })
              const tools = (yield* sessions.messages({ sessionID: session.id }))
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool")
              expect(tools).toHaveLength(4)
              const first = tools.find((part) => part.callID === "first")!
              const following = tools.find((part) => part.callID === "following")!
              const read = tools.find((part) => part.callID === "read-after")!
              const recovery = tools.find((part) => part.callID === "recovery")!
              const original =
                first.state.status === "error"
                  ? first.state.error
                  : first.state.status === "completed"
                    ? first.state.output
                    : ""
              expect(original).toContain(entry.error)
              expect(original).not.toContain(cancelled)
              if (entry.first.name === "bash") {
                expect(first.state.status).toBe("completed")
                if (first.state.status === "completed") expect(first.state.metadata.exit).toBe(7)
              }
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "marker.txt")).exists())).toBe(entry.runs)
              expect(following.state.status).toBe(entry.runs ? "completed" : "error")
              expect(read.state.status).toBe(entry.runs ? "completed" : "error")
              if (!entry.runs) {
                expect(following.state.status === "error" && following.state.error).toBe(cancelled)
                expect(read.state.status === "error" && read.state.error).toBe(cancelled)
              }
              if (entry.runs)
                expect(yield* Effect.promise(() => Bun.file(path.join(dir, "marker.txt")).text())).toBe("executed")
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "source.txt")).text())).toBe("original")
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "blocked.txt")).exists())).toBe(false)
              expect(recovery.state.status).toBe("completed")
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "recovery.txt")).text())).toBe("recovered")
              expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
              expect(result.parts.some((part) => part.type === "text" && part.text === "Recovered")).toBe(true)
              expect(server.captures).toHaveLength(3)
              expect(JSON.stringify(server.captures[1].messages)).toContain(entry.error)
              if (!entry.runs) expect(JSON.stringify(server.captures[1].messages)).toContain(cancelled)
            }),
          {
            git: true,
            config: {
              ...config(server.origin),
              ...(mcp ? { mcp: { example: { type: "remote", url: `${mcp.url}mcp`, oauth: false } } } : {}),
            },
          },
        )
      }),
    30000,
  )

for (const mode of ["deny", "ask"] as const)
  it.live(
    `permission ${mode} cancels the following bash and preserves its cascade result`,
    () =>
      Effect.gen(function* () {
        const previous = process.env.MIMOCODE_DISABLE_FAIL_CASCADE
        delete process.env.MIMOCODE_DISABLE_FAIL_CASCADE
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous == null) delete process.env.MIMOCODE_DISABLE_FAIL_CASCADE
            else process.env.MIMOCODE_DISABLE_FAIL_CASCADE = previous
          }),
        )
        const server = startScriptedLLMServer([
          {
            lines: toolCallsResponse([
              { id: "denied", name: "write", args: JSON.stringify({ file_path: "blocked.txt", content: "blocked" }) },
              { id: "following", name: bash.name, args: JSON.stringify(bash.args) },
            ]),
          },
          { lines: textStopResponse("Stopped") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const permission = yield* Permission.Service
              const bus = yield* Bus.Service
              const session = yield* sessions.create({ title: "Permission cascade" })
              const asked = yield* Deferred.make<Permission.Request>()
              const unsubscribe = yield* bus.subscribeCallback(Permission.Event.Asked, (event) => {
                if (event.properties.sessionID === session.id)
                  Deferred.doneUnsafe(asked, Effect.succeed(event.properties))
              })
              yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
              yield* Effect.addFinalizer(() => prompt.cancel(session.id))
              const running = yield* prompt
                .prompt({
                  sessionID: session.id,
                  agent: "build",
                  harness: "default",
                  parts: [{ type: "text", text: "Attempt the write followed by the command" }],
                })
                .pipe(Effect.forkChild)
              if (mode === "ask") {
                const request = yield* Deferred.await(asked).pipe(Effect.timeout("10 seconds"))
                yield* permission.reply({ requestID: request.id, reply: "reject" })
              }
              yield* Fiber.join(running)
              const tools = (yield* sessions.messages({ sessionID: session.id }))
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool")
              expect(tools).toHaveLength(2)
              const first = tools.find((part) => part.callID === "denied")!
              const following = tools.find((part) => part.callID === "following")!
              expect(first.state.status).toBe("error")
              expect(first.state.status === "error" && first.state.error).toContain(
                mode === "deny" ? "specified a rule" : "user rejected permission",
              )
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "blocked.txt")).exists())).toBe(false)
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "marker.txt")).exists())).toBe(false)
              expect(following.state.status === "error" && following.state.error).toBe(cancelled)
              if (mode === "ask") expect(server.captures).toHaveLength(1)
            }),
          {
            git: true,
            config: {
              ...config(server.origin),
              permission: { edit: { "*": "allow", "blocked.txt": mode }, bash: "allow" },
            },
          },
        )
      }),
    30000,
  )

function config(origin: string): Config.Info {
  return {
    enabled_providers: ["test"],
    model: "test/model",
    provider: {
      test: {
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "test-key", baseURL: `${origin}/v1` },
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
    permission: { edit: "allow", bash: "allow" },
    lsp: false,
    formatter: false,
  }
}
