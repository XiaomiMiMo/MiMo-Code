import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt, SESSION_MEMORY_DIR_MARKER } from "../../src/session/prompt"
import { memoryPath, metaDir } from "../../src/session/checkpoint-paths"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
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

// runLoop reloads msgs every step; the reminder must be persisted once on the
// window's first user message, so later steps and turns leave history alone.
describe("session.prompt memory paths reminder", () => {
  test(
    "multi-step turn plus a second turn persist exactly one reminder on the first user message",
    async () => {
      const bodies: string[] = []
      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url)
          if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
          bodies.push(await req.text())
          const body = bodies.length === 1 ? chatToolCall("glob", { pattern: "*.md" }) : chat("ok")
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
                const session = yield* sessions.create({ title: "memory dir reminder" })

                yield* prompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "list markdown files" }] })
                yield* prompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "thanks" }] })

                const marker = `${SESSION_MEMORY_DIR_MARKER} ${metaDir(session.id)}/`
                const msgs = yield* sessions.messages({ sessionID: session.id })
                const users = msgs.filter((m) => m.info.role === "user")
                expect(users).toHaveLength(2)
                const reminders = users.map(
                  (m) => m.parts.filter((p) => p.type === "text" && p.synthetic === true && p.text.includes(marker)).length,
                )
                expect(reminders).toEqual([1, 0])
                const projectLine = `- Project memory: ${memoryPath(Instance.current.project.id)}`
                expect(users[0].parts.some((p) => p.type === "text" && p.text.includes(projectLine))).toBe(true)
                expect(bodies).toHaveLength(3)
                for (const body of bodies) {
                  expect(body).toContain(JSON.stringify(marker).slice(1, -1))
                  expect(body).toContain(JSON.stringify(projectLine).slice(1, -1))
                }
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
