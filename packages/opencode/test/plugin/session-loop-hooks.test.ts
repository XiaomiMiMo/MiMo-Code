import path from "path"
import { pathToFileURL } from "url"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

describe("SessionPrompt session loop hooks", () => {
  test(
    "session.pre cancel aborts before LLM and fires session.post",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("should not run") }])
      try {
        const file = path.join(tmp.path, "plugin.ts")
        await Bun.write(
          file,
          [
            "export default async () => ({",
            '  "session.pre": async (_input, output) => {',
            "    output.cancel = true",
            '    output.cancelReason = "blocked by test"',
            "  },",
            '  "session.post": async (input) => {',
            '    if (input.outcome !== "cancelled") throw new Error(`expected cancelled, got ${input.outcome}`)',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(tmp.path, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(file).href],
            enabled_providers: ["alibaba"],
            provider: {
              alibaba: { options: { apiKey: "test-key", baseURL: `${stub.origin}/v1` } },
            },
            agent: { build: { model: "alibaba/qwen-plus" } },
          }),
        )

        const exit = await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "pre-cancel" })
                return yield* prompt
                  .prompt({
                    sessionID: session.id,
                    agent: "build",
                    parts: [{ type: "text", text: "hello" }],
                  })
                  .pipe(Effect.exit)
              }),
            ),
        })

        expect(Exit.isFailure(exit)).toBe(true)
        expect(stub.captures.length).toBe(0)
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "fires pre/post session and userQuery hooks around a single LLM step",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("hook answer") }])
      const markerPath = path.join(tmp.path, "hook-events.json")
      try {
        const file = path.join(tmp.path, "plugin.ts")
        await Bun.write(
          file,
          [
            "import * as fs from 'fs/promises'",
            `const MARKER = ${JSON.stringify(markerPath)}`,
            "async function push(label: string) {",
            "  let cur: string[] = []",
            "  try { cur = JSON.parse(await fs.readFile(MARKER, 'utf8')) } catch {}",
            "  cur.push(label)",
            "  await fs.writeFile(MARKER, JSON.stringify(cur))",
            "}",
            "export default async () => ({",
            '  "session.pre": async (input) => { await push(`pre:${input.agentID}`) },',
            '  "session.userQuery.pre": async (input) => { await push(`query.pre:${input.step}:${input.query}`) },',
          '  "session.userQuery.post": async (input) => { await push(`query.post:${input.step}:${input.finalText ?? ""}:${input.trajectory.length}`) },',
          '  "session.post": async (input) => { await push(`post:${input.outcome}:${input.finalText ?? ""}:${input.trajectory.length}`) },',
            "})",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(tmp.path, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(file).href],
            enabled_providers: ["alibaba"],
            provider: {
              alibaba: { options: { apiKey: "test-key", baseURL: `${stub.origin}/v1` } },
            },
            agent: { build: { model: "alibaba/qwen-plus" } },
          }),
        )

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "hook-order" })
                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  parts: [{ type: "text", text: "What is the answer?" }],
                })
              }),
            ),
        })

        const events = JSON.parse(await Bun.file(markerPath).text()) as string[]
        expect(events[0]).toBe("pre:main")
        expect(events[1]).toMatch(/^query\.pre:1:/)
        expect(events[2]).toMatch(/^query\.post:1:hook answer:\d+$/)
        expect(events[3]).toMatch(/^post:completed:hook answer:\d+$/)
        expect(Number(events[3]?.split(":").pop())).toBeGreaterThan(0)
        expect(stub.captures.length).toBe(1)
      } finally {
        await stub.stop()
      }
    },
    { timeout: 30_000 },
  )
})
