import path from "path"
import { afterEach, expect, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer } from "../lib/scripted-llm-server"

afterEach(async () => {
  await Instance.disposeAll()
})

test("the stream error log summarizes the provider error without the request body", async () => {
  await using tmp = await tmpdir({ git: true })
  const marker = "request-body-marker-7f3a"
  const stub = startScriptedLLMServer([
    { status: 400, lines: [JSON.stringify({ error: { message: "bad request", type: "invalid_request_error" } })] },
  ])
  await Log.init({ print: true })
  const written: string[] = []
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  })
  try {
    await Bun.write(
      path.join(tmp.path, "mimocode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        enabled_providers: ["alibaba"],
        provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${stub.origin}/v1` } } },
        agent: { build: { model: "alibaba/qwen-plus" } },
      }),
    )
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "stream-error-log" })
            yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: marker }] })
          }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
        ),
    })
    await Log.flush()
  } finally {
    stderr.mockRestore()
    await Log.init({ print: false })
    await stub.stop()
  }
  expect(stub.captures.length).toBe(1)
  expect(JSON.stringify(stub.captures[0].messages)).toContain(marker)
  const lines = written.join("").split("\n").filter((line) => line.includes("stream error"))
  expect(lines.length).toBe(1)
  expect(lines[0]).toContain('"statusCode":400')
  expect(lines[0]).not.toContain(marker)
}, 30_000)
