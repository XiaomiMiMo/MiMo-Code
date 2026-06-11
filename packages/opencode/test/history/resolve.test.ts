import { describe, expect, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../../src/storage"
import { MessageTable, SessionTable, PartTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { makeResolver } from "../../src/history/resolve"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

afterEach(async () => {
  Database.use((db) => {
    db.delete(PartTable).run()
    db.delete(MessageTable).run()
    db.delete(SessionTable).run()
    db.delete(ProjectTable).run()
  })
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer))

describe("history.resolve", () => {
  it.live("role resolves user / assistant from MessageTable.data.role", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const now = Date.now()
        Database.use((db) => {
          db.insert(ProjectTable)
            .values({ id: "proj_1", worktree: "/tmp", sandboxes: [] as any, time_created: now, time_updated: now } as any)
            .run()
          db.insert(SessionTable)
            .values({
              id: "ses_1" as any,
              project_id: "proj_1" as any,
              slug: "x",
              directory: "/tmp",
              title: "t",
              version: "1",
              time_created: now,
              time_updated: now,
            })
            .run()
          db.insert(MessageTable)
            .values({ id: "msg_u" as any, session_id: "ses_1" as any, agent_id: "main", data: { role: "user" } as any, time_created: now, time_updated: now })
            .run()
          db.insert(MessageTable)
            .values({ id: "msg_a" as any, session_id: "ses_1" as any, agent_id: "main", data: { role: "assistant" } as any, time_created: now, time_updated: now })
            .run()
        })

        const resolver = makeResolver()
        expect(yield* resolver.role("msg_u")).toBe("user")
        expect(yield* resolver.role("msg_a")).toBe("assistant")
      }),
    ),
  )

  it.live("role defaults to assistant when message missing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const resolver = makeResolver()
        expect(yield* resolver.role("missing")).toBe("assistant")
      }),
    ),
  )

  it.live("projectID resolves from SessionTable", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const now = Date.now()
        Database.use((db) => {
          db.insert(ProjectTable)
            .values({ id: "proj_42" as any, worktree: "/tmp", sandboxes: [] as any, time_created: now, time_updated: now } as any)
            .run()
          db.insert(SessionTable)
            .values({
              id: "ses_x" as any,
              project_id: "proj_42" as any,
              slug: "x",
              directory: "/tmp",
              title: "t",
              version: "1",
              time_created: now,
              time_updated: now,
            })
            .run()
        })
        const resolver = makeResolver()
        expect(yield* resolver.projectID("ses_x")).toBe("proj_42")
      }),
    ),
  )

  it.live("LRU caches results — second call returns same value", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const now = Date.now()
        Database.use((db) => {
          db.insert(ProjectTable)
            .values({ id: "proj_c" as any, worktree: "/tmp", sandboxes: [] as any, time_created: now, time_updated: now } as any)
            .run()
          db.insert(SessionTable)
            .values({
              id: "ses_c" as any,
              project_id: "proj_c" as any,
              slug: "x",
              directory: "/tmp",
              title: "t",
              version: "1",
              time_created: now,
              time_updated: now,
            })
            .run()
          db.insert(MessageTable)
            .values({ id: "msg_c" as any, session_id: "ses_c" as any, agent_id: "main", data: { role: "user" } as any, time_created: now, time_updated: now })
            .run()
        })
        const resolver = makeResolver()
        yield* resolver.role("msg_c")
        yield* resolver.projectID("ses_c")

        // Both should still resolve to the cached values on a second call
        expect(yield* resolver.role("msg_c")).toBe("user")
        expect(yield* resolver.projectID("ses_c")).toBe("proj_c")
      }),
    ),
  )
})
