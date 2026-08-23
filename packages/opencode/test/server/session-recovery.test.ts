import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { Bus } from "../../src/bus"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("session turn recovery routes", () => {
  test("lists the latest incomplete assistant and accepts resume without a new prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "recovery route" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() },
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test-model"),
          providerID: ProviderID.make("test"),
          time: { created: Date.now() },
        })
        const app = Server.Default().app
        const errors: unknown[] = []
        let resolveError!: () => void
        const errorSeen = new Promise<void>((resolve) => {
          resolveError = resolve
        })
        const unsubscribe = Bus.subscribe(Session.Event.Error, (event) => {
          if (event.properties.sessionID === session.id) {
            errors.push(event.properties.error)
            resolveError()
          }
        })
        const query = `?directory=${encodeURIComponent(tmp.path)}`
        const listed = yield* Effect.promise(() => Promise.resolve(app.request(`/session/${session.id}/recovery${query}`)))
        const candidates = yield* Effect.promise(() => listed.json() as Promise<Array<{ assistantMessageID: string; parentMessageID: string; created: number }>>)
        const missing = yield* Effect.promise(() =>
          Promise.resolve(app.request(`/session/${session.id}/turn/${MessageID.ascending()}/resume${query}`, { method: "POST" })),
        )
        const resumed = yield* Effect.promise(() => Promise.resolve(app.request(`/session/${session.id}/turn/${assistant.id}/resume${query}`, { method: "POST" })))
        yield* Effect.promise(() =>
          Promise.race([errorSeen, new Promise((resolve) => setTimeout(resolve, 10_000))]),
        )
        unsubscribe()
        const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
        const abandoned = after.find((item) => item.info.id === assistant.id)?.info
        const abandonedAssistant = abandoned?.role === "assistant" ? abandoned : undefined
        return { listed: listed.status, candidates, resumed: resumed.status, missing: missing.status, userID: user.id, errors, abandoned: abandonedAssistant }
      })),
    })

    expect(result.listed).toBe(200)
    expect(result.candidates).toEqual([{ assistantMessageID: expect.any(String), parentMessageID: result.userID, created: expect.any(Number) }])
    expect(result.resumed).toBe(202)
    expect(result.missing).toBe(404)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.abandoned?.time.completed).toEqual(expect.any(Number))
    expect(result.abandoned?.error?.data.message).toContain("Abandoned")
  })
})
