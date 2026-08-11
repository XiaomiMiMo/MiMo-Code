/**
 * Integration tests for T01: a `finish=stop` step with no usable output
 * (think-only = reasoning only, or empty = nothing at all) must not silently
 * break into an empty assistant. The loop nudges the model to produce a final
 * answer; once the shared continuation counter is exhausted it writes an
 * InvalidOutputError terminal instead of looping forever.
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
import {
  startScriptedLLMServer,
  textStopResponse,
  emptyStopResponse,
  reasoningLengthResponse,
  reasoningStopResponse,
} from "../lib/scripted-llm-server"

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
      agent: {
        build: { model: "alibaba/qwen-plus" },
        "checkpoint-writer": { model: "alibaba/qwen-plus" },
      },
    }),
  )
}

function writeGPTConfig(dir: string, origin: string) {
  return Bun.write(
    path.join(dir, "mimocode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["test"],
      provider: {
        test: {
          name: "Test",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "gpt-5.5": {
              id: "gpt-5.5",
              name: "GPT-5.5",
              attachment: false,
              reasoning: true,
              temperature: false,
              tool_call: true,
              release_date: "2026-01-01",
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
          options: { apiKey: "test-key", baseURL: `${origin}/v1` },
        },
      },
      agent: { build: { model: "test/gpt-5.5" } },
    }),
  )
}

describe("invalid-output continuation — integration", () => {
  test("empty stop step is nudged, second call produces a non-empty final assistant", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: emptyStopResponse() }, { lines: textStopResponse("final answer") }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-empty" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              // First empty stop => nudge + continue; second call => final text.
              expect(stub.captures.length).toBe(2)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("think-only (reasoning only) stop step is nudged, second call produces a final assistant", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: reasoningStopResponse("let me think about this...") },
      { lines: textStopResponse("final answer") },
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
              const session = yield* sessions.create({ title: "invalid-think-only" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(2)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("ordinary actor gets a parent-facing invalid-output reminder", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: emptyStopResponse() }, { lines: textStopResponse("actor result") }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-actor" })
              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                agentID: "general-1",
                parts: [{ type: "text", text: "Do delegated work." }],
              })
              const retry = JSON.stringify(stub.captures[1].messages)
              expect(retry).toContain("parent agent")
              expect(retry).not.toContain("final answer to the user")
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("checkpoint-writer gets a scoped retry and converges on CHECKPOINT_COMPLETE", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: emptyStopResponse() },
      { lines: textStopResponse("CHECKPOINT_COMPLETE") },
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
              const session = yield* sessions.create({ title: "invalid-checkpoint-writer" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "checkpoint-writer",
                parts: [{ type: "text", text: "Update the checkpoint." }],
              })
              const retry = JSON.stringify(stub.captures[1].messages)
              expect(retry).toContain("checkpoint writer")
              expect(retry).toContain("CHECKPOINT_COMPLETE")
              expect(retry).not.toContain("final answer to the user")
              expect(result.parts.some((part) => part.type === "text" && part.text === "CHECKPOINT_COMPLETE")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("GPT reasoning-only stop step is terminal and is not retried", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: reasoningStopResponse("let me think about this...") },
      { lines: textStopResponse("unexpected retry") },
    ])
    try {
      await writeGPTConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "gpt-reasoning-only" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(1)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "reasoning" && p.text.includes("let me think"))).toBe(true)
              expect(result.parts.some((p) => p.type === "text")).toBe(false)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("GPT reasoning-only length step still auto-continues", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: reasoningLengthResponse("token budget exhausted while thinking...") },
      { lines: textStopResponse("final answer") },
    ])
    try {
      await writeGPTConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "gpt-reasoning-length" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(2)
              expect(JSON.stringify(stub.captures[1].messages)).toContain("output token limit")
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })
})
