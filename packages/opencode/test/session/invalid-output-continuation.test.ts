/**
 * RL integration tests: a `finish=stop` step with no usable output is terminal
 * after one request and records an InvalidOutputError instead of resending.
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

describe("invalid-output single attempt — integration", () => {
  test("empty stop step is terminal without a resend", async () => {
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
              expect(stub.captures).toHaveLength(1)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error?.name).toBe("InvalidOutputError")
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(false)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("think-only stop step is terminal without a resend", async () => {
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
              expect(stub.captures).toHaveLength(1)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error?.name).toBe("InvalidOutputError")
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(false)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("ordinary actor is not resent after invalid output", async () => {
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
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                agentID: "general-1",
                parts: [{ type: "text", text: "Do delegated work." }],
              })
              expect(stub.captures).toHaveLength(1)
              expect(result.info.role === "assistant" && result.info.error?.name).toBe("InvalidOutputError")
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("checkpoint-writer invalid output is not resent", async () => {
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
              expect(stub.captures).toHaveLength(1)
              expect(result.info.role === "assistant" && result.info.error?.name).toBe("InvalidOutputError")
              expect(result.parts.some((part) => part.type === "text" && part.text === "CHECKPOINT_COMPLETE")).toBe(false)
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
  }, 10_000)

  test("GPT reasoning-only length step is not resent", async () => {
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
              expect(stub.captures).toHaveLength(1)
              expect(result.info.role === "assistant" && result.info.error?.name).toBe("MessageOutputLengthError")
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(false)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  }, 10_000)

  test("empty output is terminal without requesting another response", async () => {
    await using tmp = await tmpdir({ git: true })
    // The server would repeat its last entry if called again; the single
    // captured request proves invalid output does not trigger a resend.
    const stub = startScriptedLLMServer([{ lines: emptyStopResponse() }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-exhaust" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(1)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error).toBeDefined()
              }
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  }, 10_000)
})
