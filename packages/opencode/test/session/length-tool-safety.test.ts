/**
 * Integration test (T05): the "length + tool" safety contract.
 *
 * Contract (Route 2, weaker-but-accurate): when a step finishes with
 * finish_reason="length" AND carries a non-providerExecuted client tool part,
 * autoContinueOutputLength must NOT inject an output-length continuation
 * (the "...hit the model output token limit..." system-reminder). The loop
 * instead continues via the normal tool-observation path (classify's core
 * guarantee). This is the contrast case to
 * main-runloop-history-invariant.test.ts:128, where length + plain text DOES
 * inject that reminder.
 *
 * Design notes mirror main-runloop-history-invariant.test.ts: LLM.defaultLayer
 * is baked into AppRuntime at construction, so we drive a real Session.prompt
 * against a scripted Bun.serve SSE mock pointed at by the project config.
 */

import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, toolCallLengthResponse, textStopResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

describe("length + tool safety contract", () => {
  test("length finish with a complete client tool call does not inject an output-length continuation", async () => {
    await using tmp = await tmpdir({ git: true })

    const readmePath = path.join(tmp.path, "README.md")

    // Step 0: complete `read` tool call, but the step is capped on output tokens
    //         (finish_reason: "length").
    // Step 1: plain text + stop.
    const responses = [
      {
        lines: toolCallLengthResponse({
          id: "call_0",
          name: "read",
          args: JSON.stringify({ filePath: readmePath }),
        }),
      },
      { lines: textStopResponse("done.") },
    ]

    const stub = startScriptedLLMServer(responses)

    try {
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
              const session = yield* sessions.create({ title: "length-tool-safety" })

              const final = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Please read the README." }],
              })

              // The loop continued via the tool-observation path, not via an
              // output-length retry: exactly two model calls.
              expect(stub.captures.length).toBe(2)

              // No output-length continuation reminder was injected on ANY call.
              for (const capture of stub.captures) {
                expect(JSON.stringify(capture.messages)).not.toContain("output token limit")
              }

              // The second call carried the tool result back (normal observation
              // re-loop), proving the continue came from the tool, not from a
              // synthetic length continuation.
              expect(JSON.stringify(stub.captures[1].messages)).toContain("Hello")

              // Terminates on the stop response.
              expect(final.parts.some((part) => part.type === "text" && part.text === "done.")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })
})
