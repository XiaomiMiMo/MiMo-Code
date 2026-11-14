import { describe, expect, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "../../src/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Server } from "../../src/server/server"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Database } from "../../src/storage"
import type { SQLQueryBindings } from "bun:sqlite"
import { createOpencodeClient } from "@mimo-ai/sdk/v2"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

function assistant(sessionID: SessionID, cost: number, agentID = "main"): MessageV2.Assistant {
  return {
    id: MessageID.ascending(),
    sessionID,
    agentID,
    role: "assistant",
    parentID: MessageID.ascending(),
    modelID: ModelID.make("test/model"),
    providerID: ProviderID.make("test"),
    agent: "test",
    mode: "test",
    path: { cwd: "/tmp/example", root: "/tmp/example" },
    time: { created: Date.now(), completed: Date.now() },
    cost,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  }
}

describe("session cost", () => {
  it.live(
    "includes main and actor costs through the HTTP route",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const info = yield* session.create()
        yield* session.updateMessage(assistant(info.id, 1))
        yield* session.updateMessage(assistant(info.id, 2, "general-1"))
        const response = yield* Effect.promise(async () => Server.Default().app.request(`/session/${info.id}/cost`))
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toEqual({ cost: 3 })
        const client = createOpencodeClient({
          baseUrl: "http://example.test",
          fetch: Object.assign(
            async (request: Request | URL | string) =>
              Server.Default().app.request(request instanceof Request ? request : new Request(request)),
            { preconnect: () => {} },
          ),
        })
        const result = yield* Effect.promise(() => client.session.cost({ sessionID: info.id }))
        expect(result.response.status).toBe(200)
        expect(result.data).toEqual({ cost: 3 })
      }),
    ),
  )

  it.live(
    "includes messages outside the latest page",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const info = yield* session.create()
        const messages = Array.from({ length: 101 }, () => assistant(info.id, 1))
        for (const message of messages) yield* session.updateMessage(message)
        expect(MessageV2.page({ sessionID: info.id, limit: 100 }).items).toHaveLength(100)
        expect(yield* session.cost(info.id)).toBe(101)
        yield* session.removeMessage({ sessionID: info.id, messageID: messages[0].id })
        expect(yield* session.cost(info.id)).toBe(100)
      }),
    ),
  )

  it.live(
    "returns zero for empty sessions and a 404 for missing sessions",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const info = yield* session.create()
        expect(yield* session.cost(info.id)).toBe(0)
        yield* session.updateMessage(assistant(info.id, 0, "general-1"))
        const app = Server.Default().app
        const zero = yield* Effect.promise(async () => app.request(`/session/${info.id}/cost`))
        expect(zero.status).toBe(200)
        expect(yield* Effect.promise(() => zero.json())).toEqual({ cost: 0 })
        const missing = yield* Effect.promise(async () => app.request(`/session/${SessionID.descending()}/cost`))
        expect(missing.status).toBe(404)
        expect(yield* Effect.promise(() => missing.json())).toMatchObject({ name: "NotFoundError" })
        yield* session.remove(info.id)
        const removed = yield* Effect.promise(async () => app.request(`/session/${info.id}/cost`))
        expect(removed.status).toBe(404)
      }),
    ),
  )

  it.live(
    "isolates sessions while including every actor and ignoring user and step costs",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const info = yield* session.create()
        const child = yield* session.create({ parentID: info.id })
        const unrelated = yield* session.create()
        const main = yield* session.updateMessage(assistant(info.id, 1))
        yield* session.updateMessage(assistant(info.id, 2, "general-1"))
        yield* session.updateMessage(assistant(info.id, 3, "general-2"))
        yield* session.updateMessage(assistant(child.id, 100))
        yield* session.updateMessage(assistant(unrelated.id, 1000))
        yield* session.updateMessage({
          id: MessageID.ascending(),
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test/model") },
          agent: "test",
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID: info.id,
          messageID: main.id,
          type: "step-finish",
          reason: "stop",
          cost: main.cost,
          tokens: main.tokens,
        })
        expect(yield* session.cost(info.id)).toBe(6)
        expect(yield* session.cost(child.id)).toBe(100)
        expect(yield* session.cost(unrelated.id)).toBe(1000)
      }),
    ),
  )

  it.live(
    "replaces updated costs, removes old costs and preserves forked history costs",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const info = yield* session.create()
        const main = yield* session.updateMessage(assistant(info.id, 1))
        const actor = yield* session.updateMessage(assistant(info.id, 2, "general-1"))
        yield* session.updateMessage({ ...actor, cost: 4 })
        yield* session.updateMessage({ ...actor, cost: 4 })
        expect(yield* session.cost(info.id)).toBe(5)
        const fork = yield* session.fork({ sessionID: info.id })
        expect(yield* session.cost(fork.id)).toBe(5)
        yield* session.removeMessage({ sessionID: info.id, messageID: main.id })
        expect(yield* session.cost(info.id)).toBe(4)
        expect(yield* session.cost(fork.id)).toBe(5)
        yield* session.removeMessage({ sessionID: info.id, messageID: actor.id })
        expect(yield* session.cost(info.id)).toBe(0)
      }),
    ),
  )

  it.live(
    "transfers only a cost scalar from SQLite for a large history with attachments",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const info = yield* session.create()
        const payload = "x".repeat(128 * 1024)
        for (let i = 0; i < 200; i++) {
          const message = yield* session.updateMessage({
            ...assistant(info.id, 1, i % 2 ? "general-1" : "main"),
            structured: { payload },
          })
          yield* session.updatePart({
            id: PartID.ascending(),
            sessionID: info.id,
            messageID: message.id,
            type: "file",
            mime: "image/png",
            url: `data:image/png;base64,${payload}`,
          })
        }
        const client = Database.Client().$client
        const prepare = client.prepare.bind(client)
        const queries: string[] = []
        const results: unknown[] = []
        const restore: (() => void)[] = []
        const capture = spyOn(client, "prepare").mockImplementation(function <
          Result,
          Params extends SQLQueryBindings | SQLQueryBindings[],
        >(query: string, params?: Params) {
          queries.push(query)
          const statement = prepare<Result, Params>(query, params)
          const values = statement.values.bind(statement)
          const observed = spyOn(statement, "values").mockImplementation((...params) => {
            const result = values(...params)
            results.push(result)
            return result
          })
          restore.push(() => observed.mockRestore())
          return statement
        })
        yield* session.cost(info.id).pipe(
          Effect.tap((cost) => Effect.sync(() => expect(cost).toBe(200))),
          Effect.ensuring(
            Effect.sync(() => {
              capture.mockRestore()
              for (const restoreValues of restore) restoreValues()
            }),
          ),
        )
        expect(queries).toHaveLength(1)
        expect(queries[0]).not.toMatch(/\bpart\b/i)
        expect(results).toEqual([[[200]]])
      }),
    ),
  )
})
