import { afterEach, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { ActorRegistryTable } from "../../src/actor/actor.sql"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Session } from "../../src/session"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Database, eq } from "../../src/storage"
import { Effect, Layer, ManagedRuntime } from "effect"
import { tmpdir } from "../fixture/fixture"
import { Log } from "../../src/util"

void Log.init({ print: false })

function seedOrphanQuestion(directory: string) {
  return Instance.provide({
    directory,
    fn: async () => {
      const rt = ManagedRuntime.make(Layer.mergeAll(Session.defaultLayer))
      try {
        return await rt.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const session = yield* sessions.create()
            const stale = Date.now() - 11 * 60 * 1000
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("model") },
              time: { created: stale },
            })
            const message = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "assistant",
              parentID: user.id,
              agent: "build",
              mode: "build",
              modelID: ModelID.make("model"),
              providerID: ProviderID.make("test"),
              path: { cwd: directory, root: directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: stale },
            })
            const part = yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: message.id,
              type: "tool",
              tool: "question",
              callID: "call_example",
              state: {
                status: "running",
                input: {
                  questions: [
                    { question: "Continue?", header: "Next", options: [{ label: "Yes", description: "Continue" }] },
                  ],
                },
                time: { start: stale },
              },
            })
            // Part writes refresh actor activity; simulate the crash after seeding.
            Database.use((db) =>
              db
                .update(ActorRegistryTable)
                .set({ status: "running", instance_id: "previous-process", last_activity_time: stale })
                .where(eq(ActorRegistryTable.session_id, session.id))
                .run(),
            )
            return { session: session.id, message: message.id, part: part.id }
          }),
        )
      } finally {
        await rt.dispose()
      }
    },
  })
}

function partStatus(input: Awaited<ReturnType<typeof seedOrphanQuestion>>) {
  const part = MessageV2.get({ sessionID: input.session, messageID: input.message }).parts.find(
    (p) => p.id === input.part,
  )
  return part?.type === "tool" ? part.state.status : undefined
}

afterEach(async () => {
  await Instance.disposeAll()
})

test("bootstrap settles abandoned actors without reading or reclaiming question history", async () => {
  await using tmpA = await tmpdir({ git: true })
  await using tmpB = await tmpdir({ git: true })
  const a = await seedOrphanQuestion(tmpA.path)
  const b = await seedOrphanQuestion(tmpB.path)
  await Instance.disposeDirectory(tmpA.path)
  await Instance.disposeDirectory(tmpB.path)

  // Trace the real driver; queries still execute against the real fixture DB.
  // This catches scans even when all historical questions are already completed.
  const client = Database.Client().$client
  const prepare = client.prepare.bind(client)
  const queries: string[] = []
  const trace = spyOn(client, "prepare").mockImplementation((...args) => {
    queries.push(args[0])
    return prepare(...args)
  })
  try {
    for (const directory of [tmpA.path, tmpB.path]) {
      await Instance.provide({
        directory,
        init: () => AppRuntime.runPromise(InstanceBootstrap),
        fn: async () => {},
      })
    }
  } finally {
    trace.mockRestore()
  }

  expect(queries.filter((query) => /\b(?:from|join)\s+["`]?(?:message|part)["`]?\b/i.test(query))).toEqual([])
  expect(partStatus(a)).toBe("running")
  expect(partStatus(b)).toBe("running")
  for (const id of [a.session, b.session]) {
    const actors = Database.use((db) =>
      db.select().from(ActorRegistryTable).where(eq(ActorRegistryTable.session_id, id)).all(),
    )
    expect(actors).toHaveLength(1)
    expect(actors[0]?.status).toBe("idle")
    expect(actors[0]?.last_outcome).toBe("failure")
  }
}, 30000)
