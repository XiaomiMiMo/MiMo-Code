import { describe, expect, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import { Database, eq } from "../../src/storage"
import { SessionID } from "../../src/session/schema"
import { ProjectID } from "../../src/project/schema"
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
  it.live("projectID resolves from SessionTable", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const now = Date.now()
        Database.use((db) => {
          db.insert(ProjectTable)
            .values({
              id: "proj_42" as any,
              worktree: "/tmp",
              sandboxes: [] as any,
              time_created: now,
              time_updated: now,
            } as any)
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
        expect(Database.use((db) => resolver.projectID("ses_x", db))).toBe("proj_42")
      }),
    ),
  )

  // [TP-R12-06]
  it.live("repeated lookups follow project changes and session removal", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const now = Date.now()
        Database.use((db) => {
          db.insert(ProjectTable)
            .values({
              id: "proj_c" as any,
              worktree: "/tmp",
              sandboxes: [] as any,
              time_created: now,
              time_updated: now,
            } as any)
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
            .values({
              id: "msg_c" as any,
              session_id: "ses_c" as any,
              agent_id: "main",
              data: { role: "user" } as any,
              time_created: now,
              time_updated: now,
            })
            .run()
        })
        const resolver = makeResolver()
        Database.use((db) => resolver.projectID("ses_c", db))

        expect(Database.use((db) => resolver.projectID("ses_c", db))).toBe("proj_c")
        const project = Database.use((db) =>
          db
            .select()
            .from(ProjectTable)
            .where(eq(ProjectTable.id, ProjectID.make("proj_c")))
            .get(),
        )
        if (!project) throw new Error("missing project fixture")
        Database.use((db) => {
          db.insert(ProjectTable)
            .values({ ...project, id: ProjectID.make("proj_updated") })
            .run()
          db.update(SessionTable)
            .set({ project_id: ProjectID.make("proj_updated") })
            .where(eq(SessionTable.id, SessionID.make("ses_c")))
            .run()
        })
        expect(Database.use((db) => resolver.projectID("ses_c", db))).toBe("proj_updated")
        Database.use((db) =>
          db
            .delete(SessionTable)
            .where(eq(SessionTable.id, SessionID.make("ses_c")))
            .run(),
        )
        expect(Database.use((db) => resolver.projectID("ses_c", db))).toBeUndefined()
      }),
    ),
  )
})
