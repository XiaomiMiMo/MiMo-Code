import path from "node:path"
import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TOOLCALL_DUPLICATE_ERROR } from "../../src/session/toolcall-flooding"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import type { Config } from "../../src/config"
import { Bus } from "../../src/bus"
import { Permission } from "../../src/permission"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, toolCallsResponse, textStopResponse } from "../lib/scripted-llm-server"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Permission.defaultLayer,
    Bus.defaultLayer,
  ),
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
    permission: { edit: "allow" },
    lsp: false,
    formatter: false,
  }
}

it.live(
  "a flooded batch shows eight calls, runs them all, and injects no reminder",
  () =>
    Effect.gen(function* () {
      const server = startScriptedLLMServer([
        {
          lines: toolCallsResponse(
            Array.from({ length: 9 }, (_, index) => ({
              id: `call-${index}`,
              name: "write",
              args: JSON.stringify({ file_path: `file-${index}.txt`, content: `content ${index}` }),
            })),
          ),
        },
        { lines: textStopResponse("Recovered") },
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Flood eight" })
            const result = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              harness: "default",
              parts: [{ type: "text", text: "Write the files" }],
            })
            const tools = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(tools).toHaveLength(8)
            expect(tools.every((part) => part.state.status === "completed")).toBe(true)
            expect(
              yield* Effect.promise(() =>
                Promise.all(
                  Array.from({ length: 8 }, (_, index) =>
                    Bun.file(path.join(dir, `file-${index}.txt`)).text(),
                  ),
                ),
              ),
            ).toEqual(Array.from({ length: 8 }, (_, index) => `content ${index}`))
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "file-8.txt")).exists())).toBe(false)
            expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
            expect(result.parts.some((part) => part.type === "text" && part.text === "Recovered")).toBe(true)
            expect(server.captures).toHaveLength(2)
            expect(server.captures[1].messages.filter((message) => message.role === "tool")).toHaveLength(8)
            expect(
              server.captures[1].messages
                .filter((message) => message.role === "user")
                .map((message) => message.content)
                .join("\n"),
            ).not.toContain("Tool-call flooding was detected")
          }),
        { git: true, config: config(server.origin) },
      )
    }),
  30000,
)

it.live(
  "same-step exact repeats cancel as duplicates while the first occurrence runs",
  () =>
    Effect.gen(function* () {
      const server = startScriptedLLMServer([
        {
          lines: toolCallsResponse([
            { id: "a0", name: "write", args: JSON.stringify({ file_path: "a.txt", content: "A" }) },
            { id: "b0", name: "write", args: JSON.stringify({ file_path: "b.txt", content: "B" }) },
            { id: "a1", name: "write", args: JSON.stringify({ file_path: "a.txt", content: "A" }) },
            { id: "a2", name: "write", args: JSON.stringify({ file_path: "a.txt", content: "A" }) },
            { id: "c0", name: "write", args: JSON.stringify({ file_path: "c.txt", content: "C" }) },
          ]),
        },
        { lines: textStopResponse("Recovered") },
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Duplicate cancel" })
            yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              harness: "default",
              parts: [{ type: "text", text: "Write the files" }],
            })
            const tools = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(tools).toHaveLength(5)
            expect(tools.map((part) => part.callID)).toEqual(["a0", "b0", "a1", "a2", "c0"])
            expect(tools[0].state.status).toBe("completed")
            expect(tools[1].state.status).toBe("completed")
            expect(tools[4].state.status).toBe("completed")
            for (const part of [tools[2], tools[3]]) {
              expect(part.state.status).toBe("error")
              expect(part.state.status === "error" && part.state.error).toBe(TOOLCALL_DUPLICATE_ERROR)
            }
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "a.txt")).text())).toBe("A")
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "b.txt")).text())).toBe("B")
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "c.txt")).text())).toBe("C")
            expect(server.captures).toHaveLength(2)
          }),
        { git: true, config: config(server.origin) },
      )
    }),
  30000,
)

it.live(
  "disabling duplicate detection allows identical same-step calls",
  () =>
    Effect.gen(function* () {
      const previous = process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT
      process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT = "true"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous == null) delete process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT
          else process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT = previous
        }),
      )
      const server = startScriptedLLMServer([
        {
          lines: toolCallsResponse([
            { id: "a0", name: "write", args: JSON.stringify({ file_path: "a.txt", content: "A1" }) },
            { id: "a1", name: "write", args: JSON.stringify({ file_path: "a.txt", content: "A2" }) },
          ]),
        },
        { lines: textStopResponse("Recovered") },
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Duplicate off" })
            yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              harness: "default",
              parts: [{ type: "text", text: "Write the files" }],
            })
            const tools = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(tools).toHaveLength(2)
            expect(tools.every((part) => part.state.status === "completed")).toBe(true)
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "a.txt")).text())).toBe("A2")
          }),
        { git: true, config: config(server.origin) },
      )
    }),
  30000,
)

for (const action of ["allow", "reject"] as const)
  it.live(
    `flooding waits for released-call permissions and respects ${action}`,
    () =>
      Effect.gen(function* () {
        const server = startScriptedLLMServer([
          {
            lines: toolCallsResponse(
              Array.from({ length: 9 }, (_, index) => ({
                id: `call-${index}`,
                name: "write",
                args: JSON.stringify({ file_path: `file-${index}.txt`, content: "written" }),
              })),
            ),
          },
          { lines: textStopResponse("Recovered") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const permission = yield* Permission.Service
              const bus = yield* Bus.Service
              const session = yield* sessions.create({ title: "Flood permission" })
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
                  parts: [{ type: "text", text: "Write the files after permission" }],
                })
                .pipe(Effect.forkChild)
              const request = yield* Deferred.await(asked).pipe(Effect.timeout("10 seconds"))
              yield* permission.reply({ requestID: request.id, reply: action === "allow" ? "always" : "reject" })
              const result = yield* Fiber.join(running)
              const tools = (yield* sessions.messages({ sessionID: session.id }))
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool")
              expect(tools).toHaveLength(8)
              expect(tools.every((part) => part.state.status === "completed" || part.state.status === "error")).toBe(
                true,
              )
              if (action === "reject") {
                expect(yield* Effect.promise(() => Bun.file(path.join(dir, "file-0.txt")).exists())).toBe(false)
                // A rejected permission is terminal for the turn; no second model request.
                expect(server.captures).toHaveLength(1)
                return
              }
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "file-0.txt")).text())).toBe("written")
              expect(result.parts.some((part) => part.type === "text" && part.text === "Recovered")).toBe(true)
            }),
          { git: true, config: { ...config(server.origin), permission: { edit: "ask" } } },
        )
      }),
    30000,
  )

it.live(
  "flood and duplicate switches are independent",
  () =>
    Effect.gen(function* () {
      const previous = {
        flood: process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT,
        duplicate: process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT,
      }
      process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = "true"
      delete process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous.flood == null) delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
          else process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = previous.flood
          if (previous.duplicate == null) delete process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT
          else process.env.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT = previous.duplicate
        }),
      )
      const server = startScriptedLLMServer([
        {
          lines: toolCallsResponse([
            { id: "a0", name: "write", args: JSON.stringify({ file_path: "a.txt", content: "A" }) },
            { id: "a1", name: "write", args: JSON.stringify({ file_path: "a.txt", content: "A" }) },
            { id: "b0", name: "write", args: JSON.stringify({ file_path: "b.txt", content: "B" }) },
          ]),
        },
        { lines: textStopResponse("Recovered") },
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Independent flags" })
            yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              harness: "default",
              parts: [{ type: "text", text: "Write the files" }],
            })
            const tools = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(tools).toHaveLength(3)
            expect(tools[0].state.status).toBe("completed")
            expect(tools[1].state.status === "error" && tools[1].state.error).toBe(TOOLCALL_DUPLICATE_ERROR)
            expect(tools[2].state.status).toBe("completed")
          }),
        { git: true, config: config(server.origin) },
      )
    }),
  30000,
)
