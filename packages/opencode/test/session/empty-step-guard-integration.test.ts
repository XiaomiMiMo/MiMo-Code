/** Single-attempt empty output and normal empty-argument tool-call behavior. */

import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
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

describe("empty output and empty-argument tools — integration", () => {
  test("empty terminal output is rejected without another request", async () => {
    await using tmp = await tmpdir({ git: true })
    // No client tool call means nothing for this guard to catch. The general
    // invalid-output handler terminates separately without another request.
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
              expect(stub.captures).toHaveLength(1)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error?.name).toBe("InvalidOutputError")
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("empty-argument tool calls still receive a normal tool-result followup", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: toolCallStopResponse({ id: "call_1", name: "read", args: "{}" }) },
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
