/**
 * Integration tests for the empty/no-op tool-call loop guard (handleEmptyStep +
 * isEmptyStep). Driven end-to-end through Session.prompt against a scripted
 * HTTP LLM stub — same harness as classify-integration.test.ts.
 *
 * Root cause this guards: a degraded model can spin by emitting empty/no-op
 * steps (empty terminal, or a tool call with empty arguments). TEXT_NGRAM only
 * inspects text and stepSignature drops zero-tool steps, so neither counts the
 * loop. The guard escalates soft (remind → replan) up to
 * EMPTY_STEP_MAX_RECOVERY, then HARD-HALTS the turn.
 *
 * EMPTY_STEP_MAX_RECOVERY defaults to 2, so the ladder is:
 *   step 1 (empty) → streak 1 → REMIND nudge, continue
 *   step 2 (empty) → streak 2 → REPLAN nudge, continue
 *   step 3 (empty) → streak 3 > 2 → terminal error, break
 * i.e. exactly 3 model calls before the turn is halted.
 */

import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { EMPTY_STEP_MAX_RECOVERY } from "../../src/session/prompt/empty-step-detection"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, emptyStopResponse, textStopResponse, toolCallStopResponse } from "../lib/scripted-llm-server"

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

describe("empty/no-op tool-call loop guard — integration", () => {
  test("repeated empty-args tool calls HARD-HALT the turn instead of looping forever", async () => {
    await using tmp = await tmpdir({ git: true })
    // Every response is a tool call with empty args ({}). The stub repeats its
    // last entry forever, so if the guard failed to halt this would spin
    // indefinitely. We assert it terminates. (This is the specific "frontier
    // model emits tool call with no args" pathology the guard targets.)
    const stub = startScriptedLLMServer([
      { lines: toolCallStopResponse({ id: "call_1", name: "read", args: "{}" }) },
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
              const session = yield* sessions.create({ title: "empty-step-halt" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Do the task." }],
              })
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeDefined()
              expect(stub.captures.length).toBe(EMPTY_STEP_MAX_RECOVERY + 1)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("empty terminal (no tool call, no text) is NOT halted by the empty-step guard", async () => {
    await using tmp = await tmpdir({ git: true })
    // Empty terminal used to be flagged (b-branch) and could hard-halt the turn
    // after EMPTY_STEP_MAX_RECOVERY. It is now allowed by isEmptyStep — no
    // client tool call means nothing to loop-guard. Other invalid-output
    // handling (autoContinueInvalidOutput) may still nudge, but the guard's
    // terminal error must not fire.
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
              const session = yield* sessions.create({ title: "empty-terminal-allowed" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Do the task." }],
              })
              expect(result.info.role).toBe("assistant")
              // The empty-step guard specifically must NOT be the terminator.
              if (result.info.role === "assistant" && result.info.error) {
                expect(result.info.error.data?.message ?? "").not.toContain("Empty tool call loop detected")
              }
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("a single empty-args tool call recovers when the next step produces a real answer (no halt)", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      // step 1: empty-args tool call → streak 1 → REMIND nudge, continue
      { lines: toolCallStopResponse({ id: "call_1", name: "read", args: "{}" }) },
      // step 2: real answer → streak reset, loop exits cleanly
      { lines: textStopResponse("here is the real answer") },
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
              const session = yield* sessions.create({ title: "empty-step-recover" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Do the task." }],
              })
              expect(stub.captures.length).toBe(2)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "text" && p.text === "here is the real answer")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })
})
