/**
 * Integration tests: thinking/reasoning models (config `reasoning: true`,
 * e.g. DeepSeek v4 via zen-free) reject `tool_choice: "required"` with a
 * provider 400 ("Thinking mode does not support this tool_choice"). Under
 * `json_schema` output the loop must therefore NOT force "required" for
 * reasoning-capable models; non-thinking models keep the forced "required"
 * that makes structured extraction deterministic.
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
import { startScriptedLLMServer, toolCallResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

function writeConfig(dir: string, origin: string, model: string) {
  return Bun.write(
    path.join(dir, "mimocode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["alibaba"],
      provider: {
        alibaba: {
          options: { apiKey: "test-key", baseURL: `${origin}/v1` },
          models: {
            "qa-thinking": { reasoning: true },
            "qa-plain": {},
          },
        },
      },
      agent: { build: { model: `alibaba/${model}` } },
    }),
  )
}

const schema = {
  type: "object",
  properties: { answer: { type: "number" } },
  required: ["answer"],
}

const structuredResponse = toolCallResponse({
  id: "call_1",
  name: "StructuredOutput",
  args: JSON.stringify({ answer: 4 }),
})

describe("tool_choice with thinking models (integration)", () => {
  test("thinking model: json_schema format must not force tool_choice required", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: structuredResponse }])
    try {
      await writeConfig(tmp.path, stub.origin, "qa-thinking")
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "tool-choice-thinking" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "What is 2 + 2?" }],
                format: { type: "json_schema", schema, retryCount: 0 },
              })
              expect(stub.captures.length).toBe(1)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error).toBeUndefined()
                expect((result.info.structured as any).answer).toBe(4)
              }
              expect(stub.captures[0].tool_choice).not.toBe("required")
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("non-thinking model keeps tool_choice required", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: structuredResponse }])
    try {
      await writeConfig(tmp.path, stub.origin, "qa-plain")
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "tool-choice-plain" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "What is 2 + 2?" }],
                format: { type: "json_schema", schema, retryCount: 0 },
              })
              expect(stub.captures.length).toBe(1)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error).toBeUndefined()
                expect((result.info.structured as any).answer).toBe(4)
              }
              expect(stub.captures[0].tool_choice).toBe("required")
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })
})