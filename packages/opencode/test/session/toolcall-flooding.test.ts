import path from "node:path"
import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TOOLCALL_FLOODING_REMINDER } from "../../src/session/toolcall-flooding"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import type { Config } from "../../src/config"
import { Bus } from "../../src/bus"
import { Permission } from "../../src/permission"
import { MessageV2 } from "../../src/session/message-v2"
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

for (const rounds of [1, 2])
  it.live(
    `${rounds} flooded batches execute one write each and resume with its result and a reminder`,
    () =>
      Effect.gen(function* () {
        const server = startScriptedLLMServer([
          ...Array.from({ length: rounds }, (_, round) => ({
            lines: toolCallsResponse(
              Array.from({ length: 17 }, (_, index) => ({
                id: `round-${round}-call-${index}`,
                name: "write",
                args: JSON.stringify({ file_path: `round-${round}-file-${index}.txt`, content: `round ${round}` }),
              })),
            ),
          })),
          { lines: textStopResponse("Recovered") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "Flood recovery" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                harness: "default",
                parts: [{ type: "text", text: "Write the files" }],
              })
              const messages = yield* sessions.messages({ sessionID: session.id })
              const tools = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
              expect(tools).toHaveLength(17 * rounds)
              for (const round of Array.from({ length: rounds }, (_, index) => index)) {
                const parts = tools.filter((part) => part.callID.startsWith(`round-${round}-`))
                expect(parts[0].state.status).toBe("completed")
                expect(parts[0].state.input).toEqual({
                  file_path: `round-${round}-file-0.txt`,
                  content: `round ${round}`,
                })
                expect(yield* Effect.promise(() => Bun.file(path.join(dir, `round-${round}-file-0.txt`)).text())).toBe(
                  `round ${round}`,
                )
                expect(
                  parts
                    .slice(1)
                    .every(
                      (part) =>
                        part.state.status === "error" &&
                        part.state.error === "Tool call cancelled because tool-call flooding was detected.",
                    ),
                ).toBe(true)
                expect(
                  yield* Effect.promise(() =>
                    Promise.all(
                      Array.from({ length: 16 }, (_, index) =>
                        Bun.file(path.join(dir, `round-${round}-file-${index + 1}.txt`)).exists(),
                      ),
                    ),
                  ),
                ).toEqual(Array(16).fill(false))
                const observations = server.captures[round + 1].messages.filter((message) => message.role === "tool")
                expect(observations).toHaveLength(17 * (round + 1))
                expect(observations[round * 17]).toMatchObject({
                  tool_call_id: parts[0].callID,
                  content: parts[0].state.status === "completed" ? parts[0].state.output : "",
                })
                expect(observations.slice(round * 17 + 1)).toEqual(
                  parts.slice(1).map((part) => ({
                    role: "tool",
                    tool_call_id: part.callID,
                    content: "Tool call cancelled because tool-call flooding was detected.",
                  })),
                )
                expect(
                  server.captures[round + 1].messages
                    .filter((message) => message.role === "user")
                    .map((message) => message.content),
                ).toContain(TOOLCALL_FLOODING_REMINDER)
              }
              expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
              expect(result.parts.some((part) => part.type === "text" && part.text === "Recovered")).toBe(true)
              expect(server.captures).toHaveLength(rounds + 1)
              expect(
                messages
                  .flatMap((message) => message.parts)
                  .filter(
                    (part) =>
                      part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
                  ),
              ).toHaveLength(0)
            }),
          {
            git: true,
            config: config(server.origin),
          },
        )
      }),
    30000,
  )

for (const entry of [
  {
    title: "a failed first edit",
    name: "edit",
    args: { file_path: "missing.txt", old_string: "old", new_string: "new" },
    error: "not found",
  },
  {
    title: "an invalid first tool name",
    name: "Write",
    args: { file_path: "first.txt", content: "must not execute" },
    error: "Write",
  },
  {
    title: "invalid first read arguments",
    name: "read",
    args: { file_path: 123 },
    error: "Invalid arguments for the read tool",
  },
  {
    title: "a denied first write",
    name: "write",
    args: { file_path: "first.txt", content: "must not execute" },
    error: "specified a rule",
    deny: true,
  },
])
  it.live(
    `${entry.title} retains its real failure and leaves all later calls flooding errors`,
    () =>
      Effect.gen(function* () {
        const server = startScriptedLLMServer([
          {
            lines: toolCallsResponse([
              { id: "first", name: entry.name, args: JSON.stringify(entry.args) },
              ...Array.from({ length: 16 }, (_, index) => ({
                id: `tail-${index}`,
                name: "write",
                args: JSON.stringify({ file_path: `tail-${index}.txt`, content: "must not execute" }),
              })),
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
              const session = yield* sessions.create({ title: "First flooded call failure" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                harness: "default",
                parts: [{ type: "text", text: "Attempt the tools and inspect the result" }],
              })
              const tools = (yield* sessions.messages({ sessionID: session.id }))
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool")
              expect(tools).toHaveLength(17)
              expect(tools[0].state.status).toBe("error")
              expect(tools[0].state.status === "error" && tools[0].state.error).toContain(entry.error)
              expect(tools[0].tool).toBe(entry.name === "Write" ? "invalid" : entry.name)
              expect(
                tools
                  .slice(1)
                  .every(
                    (part) =>
                      part.state.status === "error" &&
                      part.state.error === "Tool call cancelled because tool-call flooding was detected.",
                  ),
              ).toBe(true)
              expect(
                yield* Effect.promise(() =>
                  Promise.all(
                    ["first.txt", ...Array.from({ length: 16 }, (_, index) => `tail-${index}.txt`)].map((file) =>
                      Bun.file(path.join(dir, file)).exists(),
                    ),
                  ),
                ),
              ).toEqual(Array(17).fill(false))
              expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
              expect(result.parts.some((part) => part.type === "text" && part.text === "Recovered")).toBe(true)
              expect(server.captures).toHaveLength(2)
              const observations = server.captures[1].messages.filter((message) => message.role === "tool")
              expect(observations).toHaveLength(17)
              expect(observations[0]).toMatchObject({
                tool_call_id: "first",
                content: tools[0].state.status === "error" ? tools[0].state.error : "",
              })
              expect(observations.slice(1)).toEqual(
                tools.slice(1).map((part) => ({
                  role: "tool",
                  tool_call_id: part.callID,
                  content: "Tool call cancelled because tool-call flooding was detected.",
                })),
              )
              expect(
                server.captures[1].messages
                  .filter((message) => message.role === "user")
                  .map((message) => message.content),
              ).toContain(TOOLCALL_FLOODING_REMINDER)
            }),
          {
            git: true,
            config: {
              ...config(server.origin),
              permission: { edit: { "*": "allow", "first.txt": "deny" in entry ? "deny" : "allow" } },
            },
          },
        )
      }),
    30000,
  )

it.live(
  "an incomplete first call admits no substitute and uses the same recovery reminder",
  () =>
    Effect.gen(function* () {
      const server = startScriptedLLMServer([
        {
          lines: toolCallsResponse(
            Array.from({ length: 17 }, (_, index) => ({
              id: `call-${index}`,
              name: "write",
              args: index === 0 ? "{" : JSON.stringify({ file_path: `file-${index}.txt`, content: "must not execute" }),
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
            const session = yield* sessions.create({ title: "Incomplete first flooded call" })
            const result = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              harness: "default",
              parts: [{ type: "text", text: "Write the files" }],
            })
            const tools = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(tools).toHaveLength(17)
            expect(
              tools.every(
                (part) =>
                  part.state.status === "error" &&
                  part.state.error === "Tool call cancelled because tool-call flooding was detected.",
              ),
            ).toBe(true)
            expect(
              yield* Effect.promise(() =>
                Promise.all(
                  Array.from({ length: 17 }, (_, index) => Bun.file(path.join(dir, `file-${index}.txt`)).exists()),
                ),
              ),
            ).toEqual(Array(17).fill(false))
            expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
            expect(result.parts.some((part) => part.type === "text" && part.text === "Recovered")).toBe(true)
            expect(server.captures).toHaveLength(2)
            expect(server.captures[1].messages.filter((message) => message.role === "tool")).toEqual(
              tools.map((part) => ({
                role: "tool",
                tool_call_id: part.callID,
                content: "Tool call cancelled because tool-call flooding was detected.",
              })),
            )
            expect(
              server.captures[1].messages
                .filter((message) => message.role === "user")
                .map((message) => message.content),
            ).toContain(TOOLCALL_FLOODING_REMINDER)
          }),
        { git: true, config: config(server.origin) },
      )
    }),
  30000,
)

for (const action of ["allow", "reject", "cancel"] as const)
  it.live(
    `flooding waits for the first tool permission and respects ${action}`,
    () =>
      Effect.gen(function* () {
        const server = startScriptedLLMServer([
          {
            lines: toolCallsResponse(
              Array.from({ length: 17 }, (_, index) => ({
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
              const session = yield* sessions.create({ title: "First flooded call permission" })
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
              expect(server.captures).toHaveLength(1)
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "file-0.txt")).exists())).toBe(false)
              if (action === "cancel") yield* prompt.cancel(session.id)
              if (action !== "cancel")
                yield* permission.reply({ requestID: request.id, reply: action === "allow" ? "once" : "reject" })
              const result = yield* Fiber.join(running)
              const tools = (yield* sessions.messages({ sessionID: session.id }))
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool")
              expect(tools).toHaveLength(17)
              expect(tools[0].state.status).toBe(action === "allow" ? "completed" : "error")
              expect(
                yield* Effect.promise(() =>
                  Promise.all(
                    Array.from({ length: 16 }, (_, index) =>
                      Bun.file(path.join(dir, `file-${index + 1}.txt`)).exists(),
                    ),
                  ),
                ),
              ).toEqual(Array(16).fill(false))
              expect(tools.every((part) => part.state.status === "completed" || part.state.status === "error")).toBe(
                true,
              )
              if (action === "cancel") {
                expect(result.info.role === "assistant" && result.info.error?.name).toBe("MessageAbortedError")
                expect(server.captures).toHaveLength(1)
                expect(yield* Effect.promise(() => Bun.file(path.join(dir, "file-0.txt")).exists())).toBe(false)
                return
              }
              expect(
                tools
                  .slice(1)
                  .every(
                    (part) =>
                      part.state.status === "error" &&
                      part.state.error === "Tool call cancelled because tool-call flooding was detected.",
                  ),
              ).toBe(true)
              if (action === "reject") {
                expect(tools[0].state.status === "error" && tools[0].state.error).toContain("user rejected permission")
                expect(server.captures).toHaveLength(1)
                expect(yield* Effect.promise(() => Bun.file(path.join(dir, "file-0.txt")).exists())).toBe(false)
                return
              }
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "file-0.txt")).text())).toBe("written")
              expect(server.captures).toHaveLength(2)
              expect(server.captures[1].messages.find((message) => message.role === "tool")).toMatchObject({
                tool_call_id: "call-0",
                content: tools[0].state.status === "completed" ? tools[0].state.output : "",
              })
              expect(result.parts.some((part) => part.type === "text" && part.text === "Recovered")).toBe(true)
            }),
          { git: true, config: { ...config(server.origin), permission: { edit: "ask" } } },
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
    permission: { edit: "allow" },
    lsp: false,
    formatter: false,
  }
}

for (const mode of ["enabled", "disabled", "cancel"] as const) {
  it.live(
    `${mode}: streamed tools respect generation finish and user cancellation`,
    () =>
      Effect.gen(function* () {
        const previous = process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
        process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = mode === "disabled" ? "1" : "0"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous == null) delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
            else process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = previous
          }),
        )
        const count = mode === "disabled" ? 17 : 16
        const lines = toolCallsResponse(
          Array.from({ length: count }, (_, index) => ({
            id: `call-${index}`,
            name: "write",
            args: JSON.stringify({ file_path: `file-${index}.txt`, content: "written" }),
          })),
        )
        let controller!: ReadableStreamDefaultController<Uint8Array>
        const stream = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value
          },
        })
        const server = startScriptedLLMServer([{ lines: [], stream }, { lines: textStopResponse("Finished") }])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "Streaming barrier" })
              const observed = yield* Deferred.make<void>()
              const unsubscribe = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
                const part = event.properties.part
                if (part.sessionID !== session.id || part.type !== "tool") return
                if (part.callID !== `call-${count - 1}`) return
                if (part.state.status !== "pending") return
                Deferred.doneUnsafe(observed, Effect.void)
              })
              yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
              yield* Effect.addFinalizer(() => prompt.cancel(session.id))
              const running = yield* prompt
                .prompt({
                  sessionID: session.id,
                  agent: "build",
                  harness: "default",
                  parts: [{ type: "text", text: "Write files" }],
                })
                .pipe(Effect.forkChild)
              for (const line of lines.slice(0, -2)) controller.enqueue(new TextEncoder().encode(line))
              yield* Deferred.await(observed).pipe(Effect.timeout("10 seconds"))
              // The existing openai-compatible patch itself buffers complete calls.
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "file-0.txt")).exists())).toBe(false)
              if (mode === "cancel") {
                yield* prompt.cancel(session.id)
                expect(() => controller.enqueue(new TextEncoder().encode(lines.at(-1)))).toThrow()
              }
              if (mode !== "cancel") {
                for (const line of lines.slice(-2)) controller.enqueue(new TextEncoder().encode(line))
                controller.close()
              }
              const result = yield* Fiber.join(running)
              const messages = yield* sessions.messages({ sessionID: session.id })
              const tools = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
              expect(tools).toHaveLength(count)
              expect(tools.every((part) => part.state.status === (mode === "cancel" ? "error" : "completed"))).toBe(
                true,
              )
              if (mode === "cancel") {
                expect(result.info.role === "assistant" && result.info.error?.name).toBe("MessageAbortedError")
                expect(server.captures).toHaveLength(1)
                expect(yield* Effect.promise(() => Bun.file(path.join(dir, "file-0.txt")).exists())).toBe(false)
                return
              }
              expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, `file-${count - 1}.txt`)).text())).toBe(
                "written",
              )
              expect(server.captures).toHaveLength(2)
            }),
          { git: true, config: config(server.origin) },
        )
      }),
    30000,
  )
}
