import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createOpencodeClient } from "@mimo-ai/sdk/v2/client"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { MimoBackend, type EngineEvents } from "../../src/phone/backend"
import { engineFrom } from "../../src/phone/engine"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

afterEach(() => Instance.disposeAll())

/** The in-process server and its event bus, wired the way the TUI reaches them. */
function wire(directory: string) {
  const app = Server.Default().app
  const client = createOpencodeClient({
    baseUrl: "http://mimocode.test",
    directory,
    fetch: Object.assign((request: Request) => app.fetch(request), { preconnect: () => {} }) as typeof fetch,
  })
  const handlers = new Set<(event: GlobalEvent) => void>()
  const listener = (event: GlobalEvent) => {
    if (event.directory === directory) for (const handler of handlers) handler(event)
  }
  GlobalBus.on("event", listener)
  const events: EngineEvents = {
    on(type, handler) {
      const filtered = (event: GlobalEvent) => {
        if (event.payload?.type === type) handler(event.payload)
      }
      handlers.add(filtered)
      return () => handlers.delete(filtered)
    },
  }
  return { client, events, close: () => GlobalBus.off("event", listener) }
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  while (true) {
    const value = await read()
    if (ready(value)) return value
    if (Date.now() >= deadline) throw new Error(`timed out: ${JSON.stringify(value)}`)
    await Bun.sleep(20)
  }
}

function withEngine(
  run: (input: {
    backend: MimoBackend
    client: ReturnType<typeof wire>["client"]
    llm: TestLLMServer["Service"]
  }) => Promise<void>,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* Effect.promise(async () => {
        await using tmp = await tmpdir({
          git: true,
          config: {
            enabled_providers: ["alibaba"],
            provider: { alibaba: { options: { apiKey: "test-key", baseURL: llm.url } } },
            model: "alibaba/qwen-plus",
            small_model: "alibaba/qwen-plus",
            agent: { build: { model: "alibaba/qwen-plus" } },
          },
        })
        const { client, events, close } = wire(tmp.path)
        const backend = new MimoBackend(
          engineFrom(() => client),
          events,
        )
        try {
          await run({ backend, client, llm })
        } finally {
          backend.dispose()
          close()
        }
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}

describe("phone backend on the real engine", () => {
  test(
    "a phone message is admitted once, answered, and its turn completes from the receipt",
    () =>
      withEngine(async ({ backend, client, llm }) => {
        const session = (await client.session.create({ title: "Phone test" }, { throwOnError: true })).data
        expect((await backend.listSessions()).map((s) => s.id)).toContain(session.id)

        await Effect.runPromise(llm.text("answer for the phone"))
        const messageId = backend.newMessageId()
        expect(await backend.lookup(session.id, messageId)).toEqual({ kind: "absent" })
        expect(await backend.submit(session.id, messageId, "hello from the phone")).toEqual({ kind: "accepted" })
        expect(await backend.lookup(session.id, messageId)).toEqual({ kind: "admitted" })

        const done = await until(
          () => backend.snapshot(session.id),
          (snapshot) => snapshot?.turns[0]?.phase === "completed",
        )
        expect(done!.turns).toEqual([
          { inputMessageId: messageId, assistantMessageId: expect.any(String), phase: "completed" },
        ])
        expect(done!.parts.map((p) => [p.role, p.messageId === messageId, p.text])).toEqual([
          ["user", true, "hello from the phone"],
          ["assistant", false, "answer for the phone"],
        ])
        expect(done!.parts[1].turnId).toBe(messageId)
        await until(
          () => backend.snapshot(session.id),
          (snapshot) => snapshot?.phase === "idle",
        )

        // Submitting the same message again is the same admission, not a second prompt.
        expect(await backend.submit(session.id, messageId, "hello from the phone")).toEqual({ kind: "accepted" })
        await Bun.sleep(200)
        expect(await Effect.runPromise(llm.calls)).toBe(1)
      }),
    30_000,
  )

  test(
    "an unknown session is not readable and a malformed message ID is rejected before admission",
    () =>
      withEngine(async ({ backend, client }) => {
        const session = (await client.session.create({ title: "Phone test" }, { throwOnError: true })).data
        expect(await backend.snapshot("ses_unknown")).toBeUndefined()
        expect(await backend.submit(session.id, "not-a-message-id", "x")).toEqual({
          kind: "rejected",
          reason: "invalid",
        })
      }),
    30_000,
  )
})
