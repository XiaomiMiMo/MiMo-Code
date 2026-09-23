import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import { Permission } from "../../src/permission"
import { Bus } from "../../src/bus"
import { TaskRegistry } from "../../src/task/registry"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, toolCallResponse, textStopResponse } from "../lib/scripted-llm-server"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    TaskRegistry.defaultLayer,
    Permission.defaultLayer,
    Bus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)
it.live(
  "path rewrite hooks preserve the FIFO order of writes to one destination",
  () =>
    Effect.gen(function* () {
      const first = toolCallResponse({
        id: "first",
        name: "write",
        args: JSON.stringify({ file_path: "logical.txt", content: "first" }),
      })
      const second = toolCallResponse({
        id: "second",
        name: "write",
        args: JSON.stringify({ file_path: "target.txt", content: "second" }),
      })
      const server = startScriptedLLMServer([
        {
          lines: [
            first[0],
            first[1],
            first[2],
            second[1].replaceAll('"index":0', '"index":1'),
            second[2].replaceAll('"index":0', '"index":1'),
            first[3],
            first[4],
          ],
        },
        { lines: textStopResponse("Finished") },
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(dir, ".mimocode", "hooks"), { recursive: true })
              await fs.writeFile(
                path.join(dir, ".mimocode", "hooks", "redirect.ts"),
                `export default {
        "tool.execute.before": async (input, output) => {
          if (input.tool !== "write" || output.args.file_path !== "logical.txt") return
          output.args.file_path = "target.txt"
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }`,
              )
            })
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({ title: "Hook path rewrite" })
            yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              harness: "default",
              parts: [{ type: "text", text: "Write both files in order" }],
            })
            const content = yield* Effect.promise(() => fs.readFile(path.join(dir, "target.txt"), "utf8"))
            expect(content).toBe("second")
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

for (const { harness, cancel } of (["default", "codex"] as const).flatMap((harness) =>
  [false, true].map((cancel) => ({ harness, cancel })),
)) {
  it.live(
    `exec/direct share before/after hooks and nested completion: ${harness} cancel=${cancel}`,
    () =>
      Effect.gen(function* () {
        const args =
          harness === "codex"
            ? {
                code: 'const result = await tools.exec_command({cmd:"printf original > output.txt"}); return result.output',
              }
            : { command: "printf original > output.txt", description: "Write fixture" }
        const server = startScriptedLLMServer([
          {
            lines: toolCallResponse({
              id: "fixture-call",
              name: harness === "codex" ? "exec" : "bash",
              args: JSON.stringify(args),
            }),
          },
          { lines: textStopResponse("Finished") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              yield* Effect.promise(async () => {
                await fs.mkdir(path.join(dir, ".mimocode", "hooks"), { recursive: true })
                await fs.writeFile(
                  path.join(dir, ".mimocode", "hooks", "parity.ts"),
                  `
            import fs from "node:fs/promises"
            export default {
              "tool.execute.before": async (input, output) => {
                if (input.tool === "bash" && ${cancel}) { output.cancel = true; output.cancelReason = "FIXTURE_CANCEL"; return }
                if (input.tool === "bash") output.args.command = output.args.command.replace("original", "aligned")
              },
              "tool.execute.after": async (input, output) => {
                if (input.tool !== "bash") return
                await fs.writeFile(${JSON.stringify(path.join(dir, "hook-call.txt"))}, input.callID)
                output.output += "AFTER_HOOK"
              }
            }`,
                )
              })
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const session = yield* sessions.create({ title: "Execution parity" })
              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                harness,
                parts: [{ type: "text", text: "Run the fixture" }],
              })
              if (cancel) {
                expect(yield* Effect.promise(() => Bun.file(path.join(dir, "output.txt")).exists())).toBe(false)
                expect(yield* Effect.promise(() => Bun.file(path.join(dir, "hook-call.txt")).exists())).toBe(false)
              } else {
                expect(yield* Effect.promise(() => fs.readFile(path.join(dir, "output.txt"), "utf8"))).toBe("aligned")
                expect(yield* Effect.promise(() => fs.readFile(path.join(dir, "hook-call.txt"), "utf8"))).toBe(
                  harness === "codex" ? "fixture-call:1" : "fixture-call",
                )
              }
              const messages = yield* sessions.messages({ sessionID: session.id })
              const parts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool")
              expect(JSON.stringify(parts)).toContain(cancel ? "FIXTURE_CANCEL" : "AFTER_HOOK")
              expect(parts.every((p) => p.state.status === "completed")).toBe(true)
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
                  models: { model: { name: "Test", tool_call: true, limit: { context: 32000, output: 2000 } } },
                },
              },
              agent: { build: { model: "test/model" } },
              permission: { bash: "allow", edit: "allow" },
              lsp: false,
              formatter: false,
            },
          },
        )
      }),
    30000,
  )
}

for (const harness of ["default", "codex"] as const) {
  it.live(
    `task persistence and history execution through both tool routes: ${harness}`,
    () =>
      Effect.gen(function* () {
        const calls = [
          ["task", { operation: { action: "create", summary: "Parity task" } }],
          ["task", { operation: { action: "start", id: "T1" } }],
          ["task", { operation: { action: "done", id: "T1" } }],
          ["history", { operation: "search", query: "parity evidence" }],
        ] as const
        const server = startScriptedLLMServer([
          ...(harness === "codex"
            ? [
                {
                  lines: toolCallResponse({
                    id: "batch",
                    name: "exec",
                    args: JSON.stringify({
                      code: calls.map(([name, args]) => `await tools.${name}(${JSON.stringify(args)});`).join("\n"),
                    }),
                  }),
                },
              ]
            : calls.map(([name, args], i) => ({
                lines: toolCallResponse({ id: `call-${i}`, name, args: JSON.stringify(args) }),
              }))),
          { lines: textStopResponse("Finished") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const session = yield* sessions.create({ title: "Task history parity" })
              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                harness,
                parts: [{ type: "text", text: "parity evidence" }],
              })
              const registry = yield* TaskRegistry.Service
              const tasks = yield* registry.list({ session_id: session.id, include_terminal: true })
              expect(tasks).toHaveLength(1)
              expect(tasks[0]).toMatchObject({ id: "T1", status: "done", summary: "Parity task" })
              const events = yield* registry.events({ session_id: session.id, task_id: "T1" })
              expect(events.map((e) => e.kind)).toEqual(["created", "started", "done"])
              const messages = yield* sessions.messages({ sessionID: session.id })
              const parts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool")
              expect(JSON.stringify(parts)).toContain("History search")
              expect(parts.every((p) => p.state.status === "completed")).toBe(true)
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
                  models: { model: { name: "Test", tool_call: true, limit: { context: 32000, output: 2000 } } },
                },
              },
              agent: { build: { model: "test/model" } },
              permission: { "*": "allow" },
              lsp: false,
              formatter: false,
            },
          },
        )
      }),
    30000,
  )
}

for (const harness of ["default", "codex"] as const) {
  it.live(
    `permission rejection binds to the executing child: ${harness}`,
    () =>
      Effect.gen(function* () {
        const args =
          harness === "codex"
            ? { code: 'await tools.exec_command({cmd:"printf blocked > blocked.txt"})' }
            : { command: "printf blocked > blocked.txt", description: "Permission fixture" }
        const server = startScriptedLLMServer([
          {
            lines: toolCallResponse({
              id: "permission-call",
              name: harness === "codex" ? "exec" : "bash",
              args: JSON.stringify(args),
            }),
          },
          { lines: textStopResponse("Stopped") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const bus = yield* Bus.Service
              const permission = yield* Permission.Service
              const session = yield* sessions.create({ title: "Permission parity" })
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
                  harness,
                  parts: [{ type: "text", text: "Attempt the command" }],
                })
                .pipe(Effect.forkChild)
              const request = yield* Deferred.await(asked).pipe(Effect.timeout("10 seconds"))
              expect(request.tool?.callID).toBe(harness === "codex" ? "permission-call:1" : "permission-call")
              yield* permission.reply({ requestID: request.id, reply: "reject" })
              yield* Fiber.join(running)
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "blocked.txt")).exists())).toBe(false)
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
                  models: { model: { name: "Test", tool_call: true, limit: { context: 32000, output: 2000 } } },
                },
              },
              agent: { build: { model: "test/model" } },
              permission: { bash: "ask", edit: "allow" },
              lsp: false,
              formatter: false,
            },
          },
        )
      }),
    30000,
  )
}
