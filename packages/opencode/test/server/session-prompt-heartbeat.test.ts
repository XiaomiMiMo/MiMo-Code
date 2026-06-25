import { afterEach, expect } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Log } from "../../src/util"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { makeLayer, ref, providerCfg } from "../workflow/lib"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(makeLayer())

// The turn blocks inside the `question` tool on an un-timed Deferred. With a
// short heartbeat interval the route must emit keep-alive whitespace on the
// open POST /:sessionID/message stream BEFORE the turn finishes — otherwise a
// client with its own request timeout aborts mid-question with
// "error sending request for url". After we reply, the trailing JSON must
// still parse as the whole body despite the leading whitespace.
it.live(
  "writes keep-alive whitespace while the question tool blocks, then a parseable JSON tail",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const prev = process.env["MIMOCODE_PROMPT_HEARTBEAT_INTERVAL_MS"]
        process.env["MIMOCODE_PROMPT_HEARTBEAT_INTERVAL_MS"] = "50"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (prev === undefined) delete process.env["MIMOCODE_PROMPT_HEARTBEAT_INTERVAL_MS"]
            else process.env["MIMOCODE_PROMPT_HEARTBEAT_INTERVAL_MS"] = prev
          }),
        )

        // Model emits a single `question` tool call → the turn blocks in
        // Question.ask waiting for a human reply, holding the stream open.
        yield* llm.tool("question", {
          questions: [{ question: "proceed?", header: "confirm", options: [{ label: "yes", description: "go" }] }],
        })

        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "heartbeat test",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        const app = Server.Default().app
        const dirQuery = `?directory=${encodeURIComponent(dir)}`

        const res = yield* Effect.promise(async () =>
          app.request(`/session/${session.id}/message${dirQuery}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: { providerID: ref.providerID, modelID: ref.modelID },
              parts: [{ type: "text", text: "hi" }],
            }),
          }),
        )

        expect(res.status).toBe(200)
        expect(res.body).not.toBeNull()
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()

        const readChunk = () =>
          Effect.promise(() =>
            Promise.race([
              reader.read().then((r) => ({ timeout: false as const, ...r })),
              new Promise<{ timeout: true }>((r) => setTimeout(() => r({ timeout: true as const }), 100)),
            ]),
          )

        const listPending = () =>
          Effect.promise(async () => {
            const r = await app.request(`/question${dirQuery}`, { method: "GET" })
            return (await r.json()) as Array<{ id: string }>
          })

        // Read until the pending question shows up over the same app instance
        // and at least one heartbeat space has been written — proof bytes flow
        // before the turn completes.
        let buffer = ""
        let sawHeartbeat = false
        let pendingID: string | undefined
        for (let i = 0; i < 300 && !(sawHeartbeat && pendingID); i++) {
          if (!pendingID) {
            const pending = yield* listPending()
            if (pending.length > 0) pendingID = pending[0]!.id
          }
          const read = yield* readChunk()
          if (!read.timeout && !read.done && read.value) buffer += decoder.decode(read.value, { stream: true })
          if (buffer.length > 0 && /^\s+$/.test(buffer)) sawHeartbeat = true
          yield* Effect.sleep("20 millis")
        }

        expect(sawHeartbeat).toBe(true)
        expect(pendingID).toBeDefined()

        // Reply over the same app instance so the turn finishes.
        const replyRes = yield* Effect.promise(async () =>
          app.request(`/question/${pendingID}/reply${dirQuery}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ answers: [["yes"]] }),
          }),
        )
        expect(replyRes.status).toBe(200)

        // Drain the rest of the stream.
        let done = false
        for (let i = 0; i < 2000 && !done; i++) {
          const read = yield* readChunk()
          if (read.timeout) continue
          if (read.done) done = true
          else buffer += decoder.decode(read.value, { stream: true })
        }

        // Leading whitespace + trailing JSON still parses as the whole body.
        const parsed = JSON.parse(buffer)
        expect(parsed).toBeDefined()
        expect(parsed.info).toBeDefined()
      }),
      { git: true, config: providerCfg },
    ),
  30_000,
)
