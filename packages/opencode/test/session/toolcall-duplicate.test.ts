import path from "node:path"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Bus } from "../../src/bus"
import type { Config } from "../../src/config"
import { TOOLCALL_DUPLICATE_ERROR } from "../../src/session/toolcall-duplicate"
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
  "three consecutive identical writes cancel as duplicates without a doom_loop ask",
  () =>
    Effect.gen(function* () {
      const server = startScriptedLLMServer([
        {
          lines: toolCallsResponse([
            { id: "same-0", name: "write", args: JSON.stringify({ file_path: "same.txt", content: "S" }) },
            { id: "same-1", name: "write", args: JSON.stringify({ file_path: "same.txt", content: "S" }) },
            { id: "same-2", name: "write", args: JSON.stringify({ file_path: "same.txt", content: "S" }) },
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
            const session = yield* sessions.create({ title: "Triple same" })
            // Completes without interactive doom_loop confirmation.
            yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              harness: "default",
              parts: [{ type: "text", text: "Write the same file three times" }],
            })
            const tools = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(tools.map((part) => [part.callID, part.state.status])).toEqual([
              ["same-0", "completed"],
              ["same-1", "error"],
              ["same-2", "error"],
            ])
            expect(tools[1].state.status === "error" && tools[1].state.error).toBe(TOOLCALL_DUPLICATE_ERROR)
            expect(tools[2].state.status === "error" && tools[2].state.error).toBe(TOOLCALL_DUPLICATE_ERROR)
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "same.txt")).text())).toBe("S")
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
            { id: "a1", name: "write", args: JSON.stringify({ file_path: "a.txt", content: "A1" }) },
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
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "a.txt")).text())).toBe("A1")
          }),
        { git: true, config: config(server.origin) },
      )
    }),
  30000,
)

it.live(
  "duplicate cancel does not fail-cascade later distinct calls",
  () =>
    Effect.gen(function* () {
      const server = startScriptedLLMServer([
        {
          lines: toolCallsResponse([
            { id: "first", name: "write", args: JSON.stringify({ file_path: "first.txt", content: "1" }) },
            { id: "dup", name: "write", args: JSON.stringify({ file_path: "first.txt", content: "1" }) },
            { id: "later", name: "write", args: JSON.stringify({ file_path: "later.txt", content: "2" }) },
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
            const session = yield* sessions.create({ title: "Duplicate no cascade" })
            yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              harness: "default",
              parts: [{ type: "text", text: "Write the files" }],
            })
            const tools = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(tools.map((part) => [part.callID, part.state.status])).toEqual([
              ["first", "completed"],
              ["dup", "error"],
              ["later", "completed"],
            ])
            expect(tools[1].state.status === "error" && tools[1].state.error).toBe(TOOLCALL_DUPLICATE_ERROR)
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "later.txt")).exists())).toBe(true)
          }),
        { git: true, config: config(server.origin) },
      )
    }),
  30000,
)
