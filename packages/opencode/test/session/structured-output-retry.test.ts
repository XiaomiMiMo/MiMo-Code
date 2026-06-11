/**
 * Integration tests for T04: under `json_schema` output, a step that fails to
 * produce structured output (plain text stop, etc.) must not immediately write
 * `StructuredOutputError({ retries: 0 })`. Instead the loop appends a repair
 * nudge and retries up to `lastUser.format.retryCount` times; on exhaustion it
 * writes a StructuredOutputError carrying the *real* retry count.
 *
 * Driven through a real Session.prompt(...) against the scripted HTTP LLM stub.
 */

import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse, toolCallResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

function writeConfig(dir: string, origin: string) {
  return Bun.write(
    path.join(dir, "mimocode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["alibaba"],
      provider: {
        alibaba: { options: { apiKey: "test-key", baseURL: `${origin}/v1` } },
      },
      agent: { build: { model: "alibaba/qwen-plus" } },
    }),
  )
}

const schema = {
  type: "object",
  properties: { answer: { type: "number" } },
  required: ["answer"],
}

describe("structured-output retry — integration", () => {
  test("plain text stop is repaired, second call produces structured output", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: textStopResponse("here is a plain text answer") },
      { lines: toolCallResponse({ id: "call_1", name: "StructuredOutput", args: JSON.stringify({ answer: 4 }) }) },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "structured-retry" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "What is 2 + 2?" }],
                format: { type: "json_schema", schema, retryCount: 2 },
              })
              // First plain text => repair nudge + continue; second call => structured tool call.
              expect(stub.captures.length).toBe(2)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error).toBeUndefined()
                expect(result.info.structured).toBeDefined()
                expect((result.info.structured as any).answer).toBe(4)
              }
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("repeated plain text exhausts retryCount and writes StructuredOutputError with real retries", async () => {
    await using tmp = await tmpdir({ git: true })
    // Server repeats the last entry, so every call returns a plain text stop.
    const stub = startScriptedLLMServer([{ lines: textStopResponse("still plain text") }])
    const retryCount = 2
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "structured-exhaust" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "What is 2 + 2?" }],
                format: { type: "json_schema", schema, retryCount },
              })
              // retryCount repair nudges + 1 initial attempt that trips the terminal error.
              expect(stub.captures.length).toBe(retryCount + 1)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error?.name).toBe("StructuredOutputError")
                expect((result.info.error?.data as any).retries).toBe(retryCount)
              }
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })
})
