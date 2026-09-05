import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

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
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    },
    { id: "c", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ])
}

function userTexts(messages: Array<{ role: string; content: unknown }>): string[] {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : Array.isArray(m.content)
          ? m.content.filter((p: any) => p?.type === "text").map((p: any) => String(p.text))
          : [],
    )
}

describe("session.prompt mid-turn multi-steer drain", () => {
  test("stacked user messages after last assistant produce unanswered-count hint", async () => {
    const captures: Array<{ hasUnanswered: boolean; count: number | null; texts: string[] }> = []
    let calls = 0
    let steersReady: () => void = () => {}
    const steersDone = new Promise<void>((r) => {
      steersReady = r
    })

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
        calls++
        const body = (await req.json()) as { messages: Array<{ role: string; content: unknown }> }
        const texts = userTexts(body.messages)
        const joined = texts.join("\n")
        const m = joined.match(/There are (\d+) unanswered/)
        captures.push({
          hasUnanswered: /unanswered user messages/.test(joined),
          count: m ? Number(m[1]) : null,
          texts,
        })
        if (calls === 1) {
          // Hold the first LLM response until steers are in the DB, then keep
          // the loop alive with a tool call so the next iteration reloads them.
          await steersDone
          await new Promise((r) => setTimeout(r, 50))
          return new Response(chatToolCall("glob", { pattern: "*.md" }), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          })
        }
        return new Response(chat("DONE"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
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
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } },
              },
              agent: { build: { model: "alibaba/qwen-plus" } },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const session = yield* sessions.create({ title: "multi-steer" })

              const slow = yield* prompt
                .prompt({
                  sessionID: session.id,
                  parts: [{ type: "text", text: "SLOW_TURN first" }],
                })
                .pipe(Effect.forkChild)

              // Wait until the first LLM request is in flight (assistant exists).
              yield* Effect.promise(async () => {
                while (calls < 1) await new Promise((r) => setTimeout(r, 50))
              })
              yield* Effect.sleep("100 millis")

              yield* prompt
                .prompt({
                  sessionID: session.id,
                  parts: [{ type: "text", text: "STEER_A alpha" }],
                })
                .pipe(Effect.forkChild)
              yield* prompt
                .prompt({
                  sessionID: session.id,
                  parts: [{ type: "text", text: "STEER_B beta" }],
                })
                .pipe(Effect.forkChild)

              // Wait until both steers are durable before releasing call 1.
              for (let i = 0; i < 100; i++) {
                const msgs = yield* sessions.messages({ sessionID: session.id })
                const texts = msgs.flatMap((m) =>
                  m.parts.flatMap((p) => (p.type === "text" && !p.synthetic ? [p.text] : [])),
                )
                if (texts.some((t) => t.includes("STEER_A")) && texts.some((t) => t.includes("STEER_B"))) break
                yield* Effect.sleep("50 millis")
              }
              steersReady()

              yield* Fiber.join(slow).pipe(Effect.timeout("20 seconds"), Effect.catch(() => Effect.void))
              yield* Effect.sleep("1500 millis")
            }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
          ),
      })

      const multi = captures.find((c) => c.hasUnanswered && (c.count ?? 0) >= 2)
      expect(
        multi,
        `captures=${JSON.stringify(captures.map((c) => ({ u: c.hasUnanswered, n: c.count, texts: c.texts })))}`,
      ).toBeDefined()
      const blob = multi!.texts.join("\n")
      expect(blob).toContain("STEER_A")
      expect(blob).toContain("STEER_B")
    } finally {
      server.stop(true)
    }
  }, 60_000)
})
