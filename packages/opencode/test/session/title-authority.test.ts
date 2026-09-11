import { expect, test } from "bun:test"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import { Database, eq, sql } from "../../src/storage"
import { SessionTable } from "../../src/session/session.sql"
import { SyncEvent } from "../../src/sync"
import { EventTable, EventSequenceTable } from "../../src/sync/event.sql"
import { SessionID } from "../../src/session/schema"
import { Flag } from "../../src/flag/flag"
import { Bus } from "../../src/bus"

// [TP-ST-R2-05, TP-ST-R2-06, TP-ST-R2-07] Real persisted commands, not a mocked CAS.
test("manual crosses AI, but never another manual revision (including identical text)", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const run = AppRuntime.runPromise
      const s = await run(Session.Service.use((s) => s.create()))
      expect(s.titleSource).toBe("fallback")
      expect(s.titleRevision).toBe(0)
      await run(
        Session.Service.use((svc) => svc.setTitleIfDefault({ sessionID: s.id, title: "AI", expectedRevision: 0 })),
      )
      await run(Session.Service.use((svc) => svc.setTitle({ sessionID: s.id, title: "Mine", expectedRevision: 0 })))
      const current = await run(Session.Service.use((svc) => svc.get(s.id)))
      expect(current.titleSource).toBe("user")
      expect(current.titleRevision).toBe(2)
      await expect(
        run(Session.Service.use((svc) => svc.setTitle({ sessionID: s.id, title: "Mine", expectedRevision: 0 }))),
      ).rejects.toThrow()
      expect(
        await run(
          Session.Service.use((svc) =>
            svc.setTitleIfDefault({ sessionID: s.id, title: "Late AI", expectedRevision: 2 }),
          ),
        ),
      ).toBe(false)
      expect((await run(Session.Service.use((svc) => svc.get(s.id)))).title).toBe("Mine")
    },
  })
})

test("machine title has exact CAS, updates generated, never borrows manual authority", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn: async () => {
    const run = AppRuntime.runPromise
    const s = await run(Session.Service.use(svc => svc.create()))
    const machine = (title: string, expectedRevision: number) => run(Session.Service.use(svc => svc.setGeneratedTitle({ sessionID: s.id, title, expectedRevision })))
    expect(await machine("Attachment meaning", 0)).toBeTruthy()
    expect(await machine("Changed purpose", 1)).toBeTruthy()
    expect(await machine("Changed purpose", 2)).toBe(false)
    expect(await machine("Stale candidate", 1)).toBe(false)
    expect(await run(Session.Service.use(svc => svc.setTitleIfDefault({ sessionID: s.id, title: "Initial must not update generated", expectedRevision: 2 })))).toBe(false)
    await run(Session.Service.use(svc => svc.setTitle({ sessionID: s.id, title: "Mine", expectedRevision: 0 })))
    expect(await machine("Late machine", 2)).toBe(false)
    expect(await machine("Fresh machine", 3)).toBe(false)
    const current = await run(Session.Service.use(svc => svc.get(s.id)))
    expect([current.title, current.titleSource, current.titleRevision]).toEqual(["Mine", "user", 3])
  } })
})

// [TP-ST-R1-04, TP-ST-R2-07, TP-ST-R2-08] Rejected projection/log writes leave no success evidence.
test("event insertion failure rolls back all three fields, sequence and publication", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create()))
      const snapshot = () =>
        Database.use((db) => ({
          session: db.select().from(SessionTable).where(eq(SessionTable.id, s.id)).get(),
          events: db.select().from(EventTable).where(eq(EventTable.aggregate_id, s.id)).all(),
          seq: db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, s.id)).get(),
        }))
      const before = snapshot()
      let published = 0
      const unsub = Bus.subscribe(Session.Event.Updated, () => {
        published++
      })
      try {
        expect(() => SyncEvent.run(Session.Event.Updated, { sessionID: s.id, info: { title: "Bypass" } })).toThrow()
        expect(snapshot()).toEqual(before)
        Database.use((db) => {
          db.run(
            sql`CREATE TABLE title_commit_fault (session_id text REFERENCES session(id) DEFERRABLE INITIALLY DEFERRED)`,
          )
          db.run(
            sql`CREATE TEMP TRIGGER reject_title_commit AFTER UPDATE OF title ON session BEGIN INSERT INTO title_commit_fault VALUES ('ses_missing_parent'); END`,
          )
        })
        try {
          expect(() =>
            Session.writeTitle({ sessionID: s.id, title: "Commit must fail", expectedRevision: 0 }, "user"),
          ).toThrow()
          expect(snapshot()).toEqual(before)
        } finally {
          Database.use((db) => {
            db.run(sql`DROP TRIGGER reject_title_commit`)
            db.run(sql`DROP TABLE title_commit_fault`)
          })
        }
        if (Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES) {
          Database.use((db) =>
            db.run(
              sql`CREATE TEMP TRIGGER reject_title_log BEFORE INSERT ON event BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`,
            ),
          )
          try {
            expect(() =>
              Session.writeTitle({ sessionID: s.id, title: "Must roll back", expectedRevision: 0 }, "user"),
            ).toThrow()
          } finally {
            Database.use((db) => db.run(sql`DROP TRIGGER reject_title_log`))
          }
          expect(snapshot()).toEqual(before)
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(published).toBe(0)
      } finally {
        unsub()
      }
    },
  })
})

// [TP-ST-R1-05, TP-ST-R10-09] Replay is an accepted transition, not re-arbitration.
test("revisioned and legacy replay protect titles; duplicate is inert and gap rolls back", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const original = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create()))
      const id = SessionID.descending()
      SyncEvent.replay({
        id: `${id}-create`,
        aggregateID: id,
        seq: 0,
        type: "session.created.1",
        data: { sessionID: id, info: { ...original, id } },
      })
      const accepted = {
        id: `${id}-title`,
        aggregateID: id,
        seq: 1,
        type: "session.updated.2",
        data: {
          sessionID: id,
          previousRevision: 0,
          info: { title: "Protected", titleSource: "user", titleRevision: 1 },
        },
      }
      SyncEvent.replay(accepted)
      SyncEvent.replay(accepted)
      expect(() => SyncEvent.replay({ ...accepted, id: `${id}-gap`, seq: 3 })).toThrow("Sequence mismatch")
      expect(() =>
        SyncEvent.replay({
          ...accepted,
          id: `${id}-bad`,
          seq: 2,
          data: {
            sessionID: id,
            previousRevision: 1,
            info: { title: "AI", titleSource: "generated", titleRevision: 2 },
          },
        }),
      ).toThrow()
      const saved = await AppRuntime.runPromise(Session.Service.use((svc) => svc.get(id)))
      expect([saved.title, saved.titleSource, saved.titleRevision]).toEqual(["Protected", "user", 1])
      expect(() =>
        SyncEvent.replay({
          id: `${id}-legacy`,
          aggregateID: id,
          seq: 2,
          type: "session.updated.1",
          data: { sessionID: id, info: { title: "Generating title" } },
        }),
      ).toThrow("Legacy title event after revisioned title command")
      const migrated = SessionID.descending()
      SyncEvent.replay({
        id: `${migrated}-create`,
        aggregateID: migrated,
        seq: 0,
        type: "session.created.1",
        data: { sessionID: migrated, info: { ...original, id: migrated } },
      })
      for (const seq of [1, 2])
        SyncEvent.replay({
          id: `${migrated}-old-${seq}`,
          aggregateID: migrated,
          seq,
          type: "session.updated.1",
          data: { sessionID: migrated, info: { title: "Generating title" } },
        })
      const legacy = await AppRuntime.runPromise(Session.Service.use((svc) => svc.get(migrated)))
      expect([legacy.title, legacy.titleSource, legacy.titleRevision]).toEqual(["Generating title", "user", 0])
      SyncEvent.replay({
        ...accepted,
        id: `${migrated}-new`,
        aggregateID: migrated,
        seq: 3,
        data: { ...accepted.data, sessionID: migrated },
      })
      const modern = await AppRuntime.runPromise(Session.Service.use((svc) => svc.get(migrated)))
      expect([modern.title, modern.titleSource, modern.titleRevision]).toEqual(["Protected", "user", 1])
    },
  })
})

// [TP-ST-R2-04, TP-ST-R9-03] Ordinary manual validation is not automatic title sanitation.
test("manual titles preserve placeholder/command text and use CA-R3's 80 code-point limit", () => {
  for (const title of ["/compose-next", "ses_example", "Generating title", "<think>My title</think>"]) {
    expect(Session.ManualTitle.parse(title)).toBe(title)
  }
  expect(Session.ManualTitle.parse("  " + "𠮷".repeat(81))).toBe("𠮷".repeat(80))
})

// [TP-ST-R2-08] There is deliberately no old-client unconditional write.
test("manual title input requires a safe nonnegative expected revision", () => {
  for (const expectedRevision of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(Session.SetTitleInput.safeParse({ sessionID: "ses_test", title: "Mine", expectedRevision }).success).toBe(
      false,
    )
  }
})
