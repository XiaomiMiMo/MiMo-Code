import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt, RECALL_REMINDER_MARKER } from "../../src/session/prompt"
import { TaskRegistry } from "../../src/task/registry"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(
  fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service | TaskRegistry.Service>,
) {
  return Effect.runPromise(
    fx.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer, TaskRegistry.defaultLayer),
      ),
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

// Recall reminder used to parts.push without updatePart. runLoop reloads msgs
// every step, so each tool-call step re-attached a new copy after
// insertReminders and flipped the last-user tail — prompt-cache miss mid-turn.
// Contract now: persist once via updatePart + marker dedupe (plan-reminder pattern).
describe("session.prompt recall reminder persistence", () => {
  test("multi-step turn with memory/tasks persists exactly one recall synthetic", async () => {
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
              const tasks = yield* TaskRegistry.Service
              const session = yield* sessions.create({ title: "recall persist" })

              // hasMemoryOrTasks is true once the session has any task row.
              yield* tasks.create({ session_id: session.id, summary: "seed recall gate" })

              yield* prompt.prompt({
                sessionID: session.id,
                parts: [{ type: "text", text: "list markdown files" }],
              })

              const msgs = yield* sessions.messages({ sessionID: session.id })
              const user = msgs.find((m) => m.info.role === "user")
              expect(user).toBeDefined()
              const recallParts = (user?.parts ?? []).filter(
                (p) => p.type === "text" && p.synthetic === true && p.text.includes(RECALL_REMINDER_MARKER),
              )
              expect(recallParts).toHaveLength(1)
              expect(calls).toBe(2)

              yield* sessions.remove(session.id)
            }),
          ),
      })
    } finally {
      void server.stop(true)
    }
  })
})
