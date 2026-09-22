import path from "node:path"
import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import { Goal } from "../../src/session/goal"
import type { Config } from "../../src/config"
import { Bus } from "../../src/bus"
import { MessageV2 } from "../../src/session/message-v2"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, toolCallsResponse, textStopResponse } from "../lib/scripted-llm-server"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    Goal.defaultLayer,
    Bus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

for (const rounds of [1, 2])
  it.live(
    `${rounds} flooded batches cancel every write and resume with tool results and a reminder`,
    () =>
      Effect.gen(function* () {
        const server = startScriptedLLMServer([
          ...Array.from({ length: rounds }, () => ({
            lines: toolCallsResponse(
              Array.from({ length: 17 }, (_, index) => ({
                id: `call-${index}`,
                name: "write",
                args: JSON.stringify({ file_path: `file-${index}.txt`, content: "must not execute" }),
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
              expect(
                tools.every(
                  (part) =>
                    part.state.status === "error" &&
                    part.state.error === "Tool call cancelled because tool-call flooding was detected.",
                ),
              ).toBe(true)
              expect(tools[0].state.input).toEqual({ file_path: "file-0.txt", content: "must not execute" })
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "file-0.txt")).exists())).toBe(false)
              expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
              expect(result.parts.some((part) => part.type === "text" && part.text === "Recovered")).toBe(true)
              expect(server.captures).toHaveLength(rounds + 1)
              const recovery = JSON.stringify(server.captures[1].messages)
              expect(recovery).toContain("Tool call cancelled because tool-call flooding was detected.")
              expect(recovery).toContain("<system-reminder>")
              expect(recovery).toContain("Prefer 1–3 tool calls per step. Avoid more than 8 calls in a single step.")
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

for (const mode of ["identical", "rotating", "interleaved", "goal", "text"] as const) {
  it.live(
    `${mode}: the third flooded batch stops the turn without another request`,
    () =>
      Effect.gen(function* () {
        const server = startScriptedLLMServer([
          ...Array.from({ length: 3 }, (_, round) => [
            {
              lines: [
                ...(mode === "text" ? textStopResponse("Writing the files").slice(0, 2) : []),
                ...toolCallsResponse(
                  Array.from({ length: 17 }, (_, index) => ({
                    id: `call-${round}-${index}`,
                    name: "write",
                    args: JSON.stringify({
                      file_path: `flood-${mode === "identical" ? 0 : index % 3}.txt`,
                      content: "must not execute",
                    }),
                  })),
                ),
              ],
            },
            ...(mode === "interleaved" && round < 2
              ? [
                  {
                    lines: toolCallsResponse([
                      {
                        id: `progress-${round}`,
                        name: "write",
                        args: JSON.stringify({ file_path: `progress-${round}.txt`, content: "written" }),
                      },
                    ]),
                  },
                ]
              : []),
          ]).flat(),
          { lines: textStopResponse("Unexpected continuation") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const goal = yield* Goal.Service
              const bus = yield* Bus.Service
              const session = yield* sessions.create({ title: "Repeated flooding" })
              if (mode === "goal") yield* goal.set(session.id, "Write all the files")
              const errors: unknown[] = []
              const unsubscribe = yield* bus.subscribeCallback(Session.Event.Error, (event) => {
                if (event.properties.sessionID === session.id) errors.push(event.properties.error)
              })
              yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                harness: "default",
                parts: [{ type: "text", text: "Write the files" }],
              })
              expect(server.captures).toHaveLength(mode === "interleaved" ? 5 : 3)
              expect(result.info.role).toBe("assistant")
              if (result.info.role !== "assistant") throw new Error("Missing assistant")
              expect(result.info.error).toEqual({
                name: "UnknownError",
                data: {
                  message:
                    "Tool-call flooding persisted after 2 recovery attempts. The turn was stopped to prevent repeated cancellations.",
                },
              })
              expect(errors).toEqual([result.info.error])
              expect(result.info.time.completed).toBeUndefined()
              const messages = yield* sessions.messages({ sessionID: session.id })
              const parts = messages.flatMap((message) => message.parts)
              const tools = parts.filter((part) => part.type === "tool")
              expect(tools.filter((part) => part.state.status === "error")).toHaveLength(51)
              expect(
                tools
                  .filter((part) => part.state.status === "error")
                  .every(
                    (part) =>
                      part.state.status === "error" &&
                      part.state.error === "Tool call cancelled because tool-call flooding was detected.",
                  ),
              ).toBe(true)
              expect(tools.some((part) => part.state.status === "pending" || part.state.status === "running")).toBe(
                false,
              )
              expect(
                parts.filter(
                  (part) =>
                    part.type === "text" && part.synthetic && part.text.includes("Tool-call flooding was detected"),
                ),
              ).toHaveLength(2)
              for (const index of [0, 1, 2]) {
                expect(yield* Effect.promise(() => Bun.file(path.join(dir, `flood-${index}.txt`)).exists())).toBe(false)
              }
              if (mode === "interleaved") {
                expect(tools.filter((part) => part.state.status === "completed")).toHaveLength(2)
                expect(yield* Effect.promise(() => Bun.file(path.join(dir, "progress-1.txt")).text())).toBe("written")
              }
              if (mode === "goal") expect((yield* goal.get(session.id))?.react).toBe(0)
            }),
          { git: true, config: config(server.origin) },
        )
      }),
    30000,
  )
}

it.live(
  "a new user turn has a fresh recovery budget after flooding stops the previous turn",
  () =>
    Effect.gen(function* () {
      const server = startScriptedLLMServer([
        ...Array.from({ length: 5 }, (_, round) => ({
          lines: toolCallsResponse(
            Array.from({ length: 17 }, (_, index) => ({
              id: `call-${round}-${index}`,
              name: "write",
              args: JSON.stringify({ file_path: `file-${index}.txt`, content: "must not execute" }),
            })),
          ),
        })),
        { lines: textStopResponse("Recovered on the next turn") },
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "New turn after flooding" })
            const stopped = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              harness: "default",
              parts: [{ type: "text", text: "Write the files" }],
            })
            expect(stopped.info.role === "assistant" && stopped.info.error?.name).toBe("UnknownError")
            expect(server.captures).toHaveLength(3)
            const recovered = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              harness: "default",
              parts: [{ type: "text", text: "Try again with smaller batches" }],
            })
            expect(recovered.info.role === "assistant" && recovered.info.error).toBeUndefined()
            expect(
              recovered.parts.some((part) => part.type === "text" && part.text === "Recovered on the next turn"),
            ).toBe(true)
            expect(server.captures).toHaveLength(6)
          }),
        { git: true, config: config(server.origin) },
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
