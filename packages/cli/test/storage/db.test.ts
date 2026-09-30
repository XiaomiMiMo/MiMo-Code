import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "../../src/global"
import { InstallationChannel } from "../../src/installation/version"
import { Flag } from "../../src/flag/flag"
import { Database, eq } from "../../src/storage"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { InstanceRef } from "../../src/effect/instance-ref"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Bus } from "../../src/bus"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageTable, PartTable } from "../../src/session/session.sql"
import { provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import "../../src/server/projectors"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

for (const mode of ["use", "transaction"] as const) {
  it.live(`Database.${mode} deferred effects retain Fiber ownership across conflicting ALS`, () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const owner = (yield* InstanceRef)!
        const dir = yield* tmpdirScoped()
        const stale = yield* Effect.promise(() => Instance.provide({ directory: dir, fn: () => Instance.current }))
        yield* Effect.addFinalizer(() => Effect.promise(() => Instance.disposeDirectory(dir)))
        const seen: string[] = []
        Instance.restore(stale, () => {
          Database[mode](() => {
            if (mode === "transaction") expect(Instance.current).toBe(owner)
            Database.effect(() => seen.push(Instance.directory))
            expect(seen).toEqual([])
          })
          expect(Instance.current).toBe(stale)
        })
        expect(seen).toEqual([owner.directory])
      }),
    ),
  )
}

it.live("persisted message and part events follow Fiber ownership rather than conflicting ALS", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const owner = (yield* InstanceRef)!
      const dir = yield* tmpdirScoped({ git: true })
      const stale = yield* Effect.promise(() => Instance.provide({ directory: dir, fn: () => Instance.current }))
      yield* Effect.addFinalizer(() => Effect.promise(() => Instance.disposeDirectory(dir)))
      expect(stale.project.id).not.toBe(owner.project.id)
      const session = yield* Session.Service
      const info = yield* session.create({ title: "Persistence routing" })
      const message: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID: info.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
      }
      const part: MessageV2.TextPart = {
        id: PartID.ascending(),
        sessionID: info.id,
        messageID: message.id,
        type: "text",
        text: "Persisted in the owning instance",
      }
      const owned: string[] = []
      const misrouted: string[] = []
      const global: GlobalEvent[] = []
      const delivered = Promise.withResolvers<void>()
      const collect = (target: string[]) => (event: { type: string; properties: { sessionID?: string } }) => {
        if (event.properties.sessionID !== info.id || !event.type.startsWith("message.")) return
        target.push(event.type)
        if (owned.length + misrouted.length === 2) delivered.resolve()
      }
      const offOwner = Instance.restore(owner, () => Bus.subscribeAll(collect(owned)))
      const offStale = Instance.restore(stale, () => Bus.subscribeAll(collect(misrouted)))
      const listener = (event: GlobalEvent) => {
        if (event.payload.type === "sync") {
          if (event.payload.syncEvent.aggregateID === info.id) global.push(event)
          return
        }
        if (event.payload.properties?.sessionID === info.id && event.payload.type.startsWith("message.")) {
          global.push(event)
        }
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          offOwner()
          offStale()
          GlobalBus.off("event", listener)
        }),
      )

      yield* Effect.promise(() =>
        Instance.restore(stale, () =>
          Effect.runPromise(
            Effect.gen(function* () {
              expect(Instance.current).toBe(stale)
              yield* session.updateMessage(message)
              yield* session.updatePart(part)
            }).pipe(Effect.provideService(InstanceRef, owner)),
          ),
        ),
      )
      yield* Effect.promise(() => delivered.promise)

      const storedMessage = Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.id, message.id)).get())
      const storedPart = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, part.id)).get())
      expect(storedMessage?.session_id).toBe(info.id)
      expect(storedMessage?.data.role).toBe("user")
      expect(storedPart?.session_id).toBe(info.id)
      expect(storedPart?.message_id).toBe(message.id)
      expect(storedPart?.data).toMatchObject({ type: "text", text: part.text })
      expect({
        owned,
        misrouted,
        routes: global
          .map((event) => ({
            type: event.payload.type === "sync" ? event.payload.syncEvent.type : event.payload.type,
            directory: event.directory,
            project: event.project,
          }))
          .sort((a, b) => a.type.localeCompare(b.type)),
      }).toEqual({
        owned: ["message.updated", "message.part.updated"],
        misrouted: [],
        routes: ["message.part.updated", "message.part.updated.1", "message.updated", "message.updated.1"].map((type) => ({
          type,
          directory: owner.directory,
          project: owner.project.id,
        })),
      })
    }),
    { git: true },
  ),
)

describe("Database.Path", () => {
  test("returns database path for the current channel", () => {
    const expected =
      ["latest", "beta", "prod"].includes(InstallationChannel) || Flag.MIMOCODE_DISABLE_CHANNEL_DB
        ? path.join(Global.Path.data, "mimocode.db")
        : path.join(Global.Path.data, `mimocode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
    expect(Database.getChannelPath()).toBe(expected)
  })
})
