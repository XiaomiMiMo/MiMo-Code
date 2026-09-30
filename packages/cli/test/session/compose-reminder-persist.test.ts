import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt, COMPOSE_REMINDER_MARKER } from "../../src/session/prompt"
import { hasSyntheticReminder } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer)),
    ),
  )
}

function sse(chunks: object[]) {
  const payload = [...chunks.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]"].join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(payload))
      ctrl.close()
    },
  })
}

function chat(text: string) {
  return sse([
    { id: "c", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
    { id: "c", object: "chat.completion.chunk", choices: [{ delta: { content: text } }] },
    { id: "c", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] },
  ])
}

function chatToolCall(name: string, args: object) {
  return sse([
    { id: "c", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
    {
      id: "c",
      object: "chat.completion.chunk",
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    },
    { id: "c", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ])
}

// Compose protocol must persist once (marker dedupe) and reload with promote
// to parts[0] so parent runLoop and fork/checkpoint capture share order.
describe("session.prompt compose synthetic persist + head", () => {
  test(
    "compose multi-step turn persists exactly one protocol and reloads at head",
    async () => {
      let calls = 0
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url)
          if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
          calls++
          const body = calls === 1 ? chatToolCall("glob", { pattern: "*.md" }) : chat("ok")
          return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
        },
      })

      try {
        await using tmp = await tmpdir({
          git: true,
          init: async (dir) => {
            await Bun.write(path.join(dir, "readme.md"), "hi\n")
            await Bun.write(
              path.join(dir, "mimocode.json"),
              JSON.stringify({
                $schema: "https://opencode.ai/config.json",
                model: "alibaba/qwen-plus",
                enabled_providers: ["alibaba"],
                provider: {
                  alibaba: { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } },
                },
              }),
            )
          },
        })

        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            run(
              Effect.gen(function* () {
                const prompt = yield* SessionPrompt.Service
                const sessions = yield* Session.Service
                const session = yield* sessions.create({ title: "compose persist" })

                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "compose",
                  parts: [{ type: "text", text: "orchestrate a tiny workflow" }],
                })

                // Reload from DB — promoteComposeProtocolFirst runs in hydrate.
                const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "*" })
                const user = msgs.find((m) => m.info.role === "user" && m.info.agent === "compose")
                expect(user).toBeDefined()
                const parts = user?.parts ?? []
                const composeParts = parts.filter(
                  (p) => p.type === "text" && p.synthetic === true && p.text.includes(COMPOSE_REMINDER_MARKER),
                )
                expect(composeParts).toHaveLength(1)
                expect(hasSyntheticReminder(parts, COMPOSE_REMINDER_MARKER)).toBe(true)
                // Head invariant after DB reload: compose protocol is parts[0].
                expect(parts[0]?.type === "text" && parts[0].text.includes(COMPOSE_REMINDER_MARKER)).toBe(true)
                expect(calls).toBe(2)

                yield* sessions.remove(session.id)
              }),
            ),
        })
      } finally {
        void server.stop(true)
      }
    },
    20_000,
  )
})
