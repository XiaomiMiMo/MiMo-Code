import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
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
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    },
    { id: "c", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ])
}

// Plan-mode reminders are injected by insertReminders, which runs on EVERY
// step of the loop and persists via updatePart. The dedup guard must keep it
// to one reminder per user message even when a turn has multiple steps
// (tool call → continue), otherwise duplicates accumulate in the DB and the
// prompt prefix changes on every step (prefix cache invalidation).
describe("session.prompt plan reminder dedup", () => {
  test("plan→plan turn with a tool step injects exactly one short reminder", async () => {
    let calls = 0
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
        calls++
        // Both turns get a tool-call first step (forcing a second step that
        // re-enters insertReminders on the same user message). Turn 1 step 2
        // exercises entry-turn dedup (full reminder already present when the
        // plan→plan branch is reached); turn 2 step 2 exercises short-reminder
        // dedup.
        const body = calls === 1 || calls === 3 ? chatToolCall("glob", { pattern: "*.md" }) : chat("ok")
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
              agent: { plan: { model: "alibaba/qwen-plus" } },
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
              const session = yield* sessions.create({ title: "plan reminder dedup" })

              yield* prompt.prompt({
                sessionID: session.id,
                agent: "plan",
                parts: [{ type: "text", text: "plan something" }],
              })
              yield* prompt.prompt({
                sessionID: session.id,
                agent: "plan",
                parts: [{ type: "text", text: "refine it" }],
              })

              const msgs = yield* sessions.messages({ sessionID: session.id })
              const userMsgs = msgs.filter((m) => m.info.role === "user")
              expect(userMsgs).toHaveLength(2)

              const reminders = (m: (typeof userMsgs)[number]) =>
                m.parts.filter((p) => p.type === "text" && p.text.includes("Plan mode is"))

              // Entry turn: exactly one FULL reminder, no short one stacked on it.
              const entry = reminders(userMsgs[0])
              expect(entry).toHaveLength(1)
              expect(entry[0].type === "text" && entry[0].text.includes("Plan mode is active")).toBe(true)

              // Continuation turn ran two steps (tool call + final text) but
              // must carry exactly one short reminder.
              expect(calls).toBe(4)
              const cont = reminders(userMsgs[1])
              expect(cont).toHaveLength(1)
              expect(cont[0].type === "text" && cont[0].text.includes("Plan mode is still active")).toBe(true)

              yield* sessions.remove(session.id)
            }),
          ),
      })
    } finally {
      void server.stop(true)
    }
  })
})
