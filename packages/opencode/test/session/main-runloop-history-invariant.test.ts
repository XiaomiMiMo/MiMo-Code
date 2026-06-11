/**
 * Integration test: main runLoop history monotonic-growth invariant.
 *
 * Drives a real Session.prompt(...) call through main runLoop's multi-step
 * iteration against a scripted HTTP LLM stub. Asserts that each successive
 * /chat/completions request contains strictly more messages than the previous
 * one — i.e. history is monotonically growing across steps.
 *
 * This catches a different failure mode than the unit test in
 * test/session/llm-request-prefix.test.ts: this fires if main runLoop is
 * wired to a non-monotonic prefix builder, or if some history-stripping logic
 * creeps in elsewhere on the stream path (e.g. a future PR replaces
 * buildLLMRequestPrefix with a different builder).
 *
 * Design notes:
 * - LLM.defaultLayer is baked into AppRuntime's ManagedRuntime at construction
 *   time, so Effect.provideService(LLM.Service, fake) cannot override it. The
 *   established pattern in this codebase is to spin up a Bun.serve HTTP mock
 *   that speaks OpenAI-compatible SSE, then point the project config's
 *   provider.baseURL at that mock. See prompt.test.ts, llm-system-prompt.test.ts.
 * - Step 0: mock returns a tool-call (read on the tmp README). runLoop executes
 *   the tool and makes a second LLM call.
 * - Step 1: mock returns text + stop. runLoop terminates.
 * - We assert captures[1].messages.length > captures[0].messages.length and
 *   that captures[1].messages[0..n-1] === captures[0].messages[0..n-1].
 */

import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, toolCallResponse, textStopResponse, textLengthResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

describe("main runLoop history monotonic-growth invariant", () => {
  test("each step's /chat/completions request strictly contains previous step's messages", async () => {
    // Create the tmp dir first (without init) so we know the real path before
    // constructing responses — this avoids any post-start mutation of the
    // responses array.
    await using tmp = await tmpdir({ git: true })

    const readmePath = path.join(tmp.path, "README.md")

    // Step 0: LLM replies with a read tool-call on the tmp README.
    // Step 1: LLM replies with plain text + stop.
    // Both constructed with the real path already baked in.
    const responses = [
      { lines: toolCallResponse({ id: "call_0", name: "read", args: JSON.stringify({ filePath: readmePath }) }) },
      { lines: textStopResponse("done.") },
    ]

    const stub = startScriptedLLMServer(responses)

    try {
      // Populate the tmp dir now that we have stub.origin.
      await Bun.write(readmePath, "# Hello\n")
      await Bun.write(
        path.join(tmp.path, "mimocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["alibaba"],
          provider: {
            alibaba: {
              options: {
                apiKey: "test-key",
                baseURL: `${stub.origin}/v1`,
              },
            },
          },
          agent: {
            build: { model: "alibaba/qwen-plus" },
          },
        }),
      )

      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "history-invariant" })

              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Please read the README." }],
              })

              // Verify the invariant: at least 2 LLM calls were made.
              expect(stub.captures.length).toBeGreaterThanOrEqual(2)

              const cap0 = stub.captures[0].messages
              const cap1 = stub.captures[1].messages

              // Step 1's message list must be strictly longer (tool result was appended).
              expect(cap1.length).toBeGreaterThan(cap0.length)

              // Every message from step 0 must appear at the same index in step 1
              // (prefix is preserved, not rebuilt from scratch).
              for (let i = 0; i < cap0.length; i++) {
                expect(cap1[i]).toEqual(cap0[i])
              }
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("auto-continues when a step finishes because of output length", async () => {
    await using tmp = await tmpdir({ git: true })

    const responses = [
      { lines: textLengthResponse("partial answer") },
      { lines: textStopResponse("done.") },
    ]
    const stub = startScriptedLLMServer(responses)

    try {
      await Bun.write(
        path.join(tmp.path, "mimocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["alibaba"],
          provider: {
            alibaba: {
              options: {
                apiKey: "test-key",
                baseURL: `${stub.origin}/v1`,
              },
            },
          },
          agent: {
            build: { model: "alibaba/qwen-plus" },
          },
        }),
      )

      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "length-continuation" })

              const final = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Produce an answer that may need continuation." }],
              })

              expect(stub.captures.length).toBe(2)
              expect(JSON.stringify(stub.captures[1].messages)).toContain("output token limit")
              expect(final.parts.some((part) => part.type === "text" && part.text === "done.")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })
})
