import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Session } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { MessageTable, PartTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage"
import { Layer, ManagedRuntime } from "effect"
import { tmpdir } from "../fixture/fixture"
import { Log } from "../../src/util"

void Log.init({ print: false })

function seedOrphanQuestion(directory: string, storeKey: string) {
  return Instance.provide({
    directory,
    fn: async () => {
      const rt = ManagedRuntime.make(Layer.mergeAll(Session.defaultLayer))
      try {
        const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const stale = Date.now() - 11 * 60 * 1000
        const partId = PartID.ascending()
        Database.use((db) => {
          const messageId = MessageID.ascending()
          db.insert(MessageTable)
            .values({
              id: messageId,
              session_id: session.id,
              agent_id: "main",
              time_created: stale,
              time_updated: stale,
              data: { role: "assistant", time: { created: stale } } as never,
            })
            .run()
          db.insert(PartTable)
            .values({
              id: partId,
              message_id: messageId,
              session_id: session.id,
              time_created: stale,
              time_updated: stale,
              data: {
                type: "tool",
                tool: "question",
                callID: `call_${storeKey}`,
                state: {
                  status: "running",
                  input: {
                    questions: [{ question: "orphan?", header: "orphan", options: [{ label: "A", description: "" }] }],
                  },
                  time: { start: stale },
                },
              } as never,
            })
            .run()
          ;(globalThis as Record<string, unknown>)[storeKey] = {
            session: session.id,
            part: partId,
          }
        })
      } finally {
        await rt.dispose()
      }
    },
  })
}

function partStatus(partId: string) {
  return Database.use((db) => {
    const part = db.select().from(PartTable).where(eq(PartTable.id, partId as never)).get()
    return (part?.data as { state?: { status?: string } })?.state?.status
  })
}

/**
 * Production entry: Instance.provide + InstanceBootstrap.
 * Seed under A/B, dispose instance cache so init actually runs, then enter A then B
 * on the same AppRuntime — only the entered directory's orphan is reclaimed.
 */
test("[TP-ABANDON-Q-08] InstanceBootstrap reclaims each directory on enter (A then B)", async () => {
  await using tmpA = await tmpdir({ git: true })
  await using tmpB = await tmpdir({ git: true })
  await seedOrphanQuestion(tmpA.path, "__bootA")
  await seedOrphanQuestion(tmpB.path, "__bootB")
  const a = (globalThis as Record<string, unknown>).__bootA as { part: string }
  const b = (globalThis as Record<string, unknown>).__bootB as { part: string }

  // Drop instance cache so provide(init) runs bootstrap; keep the shared DB.
  await Instance.disposeDirectory(tmpA.path)
  await Instance.disposeDirectory(tmpB.path)

  await Instance.provide({
    directory: tmpA.path,
    init: () => AppRuntime.runPromise(InstanceBootstrap),
    fn: async () => {
      expect(partStatus(a.part)).toBe("error")
      expect(partStatus(b.part)).toBe("running")
    },
  })

  await Instance.provide({
    directory: tmpB.path,
    init: () => AppRuntime.runPromise(InstanceBootstrap),
    fn: async () => {
      expect(partStatus(b.part)).toBe("error")
    },
  })
}, 30000)
