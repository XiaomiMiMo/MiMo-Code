import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Actor } from "../../src/actor/spawn"
import { Command } from "../../src/command"
import { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Provider } from "../../src/provider"
import { Session } from "../../src/session"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import { SessionPrompt } from "../../src/session/prompt"
import type { MessageID, SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage"
import { Log } from "../../src/util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import {
  startScriptedLLMServer,
  textStopResponse,
  toolCallsResponse,
  type LLMCapture,
} from "../lib/scripted-llm-server"

void Log.init({ print: false })

// A fresh SessionPrompt and Actor layer per test installs the process-global
// prefixCaptureRef and spawnRef the writer needs; other test files reset both.
const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Actor.defaultLayer,
    Session.defaultLayer,
    Config.defaultLayer,
    Provider.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Permission.defaultLayer,
    SessionCheckpoint.defaultLayer,
  ),
)

const FILES = ["alpha.txt", "beta.txt"]
const fileBody = (name: string) => Array.from({ length: 300 }, (_, i) => `${name} body line ${i}`).join("\n")
const HIGH_USAGE = 260_000
// Distinct tokens so the reply stays clear of the consecutive-repeat detector.
const LARGE_REPLY = [
  "large-reply-start",
  ...Array.from({ length: 16_000 }, (_, i) => ((i * 2_654_435_761) >>> 0).toString(36)),
].join(" ")
const WRITER_MARKER = "checkpoint-writer mode"
const BOUNDARY_LABEL = "Summary of previous conversation from checkpoint files:"

function usageStop(text: string, usage: number) {
  const chunk = (delta: Record<string, unknown>, finish?: string) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-usage",
      object: "chat.completion.chunk",
      choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
      ...(finish ? { usage: { prompt_tokens: usage, completion_tokens: 1, total_tokens: usage + 1 } } : {}),
    })}\n\n`
  return [chunk({ role: "assistant" }), chunk({ content: text }), chunk({}, "stop"), "data: [DONE]\n\n"]
}

function config(origin: string, fork: boolean): Partial<Config.Info> {
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
            limit: { context: 400_000, output: 10_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agent: { build: { model: "test/model" } },
    permission: { read: "allow" },
    checkpoint: { thresholds: ["50%"], fork },
    lsp: false,
    formatter: false,
  }
}

type Captured = LLMCapture["messages"][number]

function text(message: Captured) {
  if (typeof message.content === "string") return message.content
  return (message.content as { type: string; text?: string }[]).map((part) => part.text ?? JSON.stringify(part)).join("\n")
}

function indexOf(messages: Captured[], needle: string) {
  const index = messages.findIndex(
    (message) =>
      text(message).includes(needle) && (needle === BOUNDARY_LABEL || !text(message).includes(BOUNDARY_LABEL)),
  )
  expect(index, needle).toBeGreaterThanOrEqual(0)
  return index
}

function seedCheckpoint(sessionID: SessionID, watermark: MessageID) {
  return Effect.promise(async () => {
    await fs.mkdir(path.dirname(checkpointPath(sessionID)), { recursive: true })
    await Bun.write(checkpointPath(sessionID), "# Session checkpoint\n\n## §1 Active intent\nRun the checks.\n")
    Database.use((db) =>
      db.update(SessionTable).set({ last_checkpoint_message_id: watermark }).where(eq(SessionTable.id, sessionID)).run(),
    )
  })
}

describe("checkpoint writer after a rebuild", () => {
  for (const fork of [true, false])
    it.live(
      `receives the boundary, the full tail from the database, then the live messages (fork: ${fork})`,
      () =>
        Effect.gen(function* () {
          const server = startScriptedLLMServer([
            { lines: textStopResponse("starting") },
            {
              lines: toolCallsResponse(
                FILES.map((file, index) => ({
                  id: `call-${index}`,
                  name: "read",
                  args: JSON.stringify({ file_path: file }),
                })),
              ),
            },
            { lines: textStopResponse("checks passed") },
            { lines: textStopResponse("live reply") },
            { lines: usageStop(LARGE_REPLY, HIGH_USAGE) },
            { lines: textStopResponse("ok") },
          ])
          yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
          yield* provideTmpdirInstance(
            (dir) =>
              Effect.gen(function* () {
                for (const file of FILES) yield* Effect.promise(() => Bun.write(path.join(dir, file), fileBody(file)))
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const checkpoint = yield* SessionCheckpoint.Service
                const session = yield* sessions.create({ title: "writer after rebuild" })
                const say = (value: string) =>
                  prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: value }] })

                yield* say("start the task")
                const watermark = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                yield* seedCheckpoint(session.id, watermark.info.id)
                yield* say("run the checks on alpha and beta")
                yield* prompt.command({
                  sessionID: session.id,
                  command: Command.Default.REBUILD,
                  arguments: "",
                  agent: "build",
                })
                yield* say("after rebuild")
                yield* say("produce the large step")
                const before = server.captures.length
                // The large step reported usage past the 50% threshold, so this turn starts the writer.
                yield* say("next")
                const findWriter = () =>
                  server.captures
                    .slice(before)
                    .find((capture) => capture.messages.some((message) => text(message).includes(WRITER_MARKER)))
                for (let attempt = 0; attempt < 200 && !findWriter(); attempt++) yield* Effect.sleep("50 millis")
                const writer = findWriter()
                expect(writer).toBeDefined()

                const stored = yield* sessions.messages({ sessionID: session.id })
                const boundary = stored.find((message) => message.parts.some((part) => part.type === "checkpoint"))!
                const largeStep = stored.find((message) =>
                  message.parts.some((part) => part.type === "text" && part.text === "produce the large step"),
                )!
                expect(boundary.info.id < largeStep.info.id).toBe(true)

                const messages = writer!.messages.filter((message) => message.role !== "system")
                const order = [
                  indexOf(messages, BOUNDARY_LABEL),
                  indexOf(messages, "run the checks on alpha and beta"),
                  indexOf(messages, "alpha.txt body line 299"),
                  indexOf(messages, "beta.txt body line 299"),
                  indexOf(messages, "checks passed"),
                  indexOf(messages, "after rebuild"),
                  indexOf(messages, "live reply"),
                  indexOf(messages, "produce the large step"),
                  indexOf(messages, WRITER_MARKER),
                ]
                expect(order).toEqual([...order].sort((a, b) => a - b))
                expect(new Set(order).size).toBe(order.length)
                const outputs = stored
                  .flatMap((message) => message.parts)
                  .flatMap((part) =>
                    part.type === "tool" && part.tool === "read" && part.state.status === "completed"
                      ? [part.state.output]
                      : [],
                  )
                expect(outputs).toHaveLength(FILES.length)
                for (const output of outputs)
                  expect(messages.some((message) => message.role === "tool" && text(message) === output)).toBe(true)
                // computeBoundary still picks the large step's user message as the writer's watermark.
                expect(JSON.stringify(messages)).not.toContain("large-reply-start")
                // Teardown disposes the instance; let the writer finish its run first.
                expect(yield* checkpoint.waitForWriter(session.id)).toBe("success")
              }),
            { git: true, config: config(server.origin, fork) },
          )
        }),
      120_000,
    )
})
