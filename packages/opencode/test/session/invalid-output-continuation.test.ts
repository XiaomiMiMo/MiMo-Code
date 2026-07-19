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
import { Flag } from "../../src/flag/flag"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import {
  startScriptedLLMServer,
  textStopResponse,
  emptyStopResponse,
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
      agent: { build: { model: "alibaba/qwen-plus" } },
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

  test("repeated empty output is caught by the empty-step guard and halts the turn", async () => {
    await using tmp = await tmpdir({ git: true })
    // Server repeats the last entry, so every call returns an empty stop.
    // The empty/no-op tool-call guard (empty-step-detection) intercepts these
    // empty terminals BEFORE autoContinueInvalidOutput and hard-halts the turn
    // after EMPTY_STEP_MAX_RECOVERY soft nudges + 1 halting step.
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
              // EMPTY_STEP_MAX_RECOVERY soft nudges + 1 halting step.
              expect(stub.captures.length).toBe(Flag.MIMOCODE_EMPTY_STEP_MAX_RECOVERY + 1)
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
  })
})
