import { expect, test } from "bun:test"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import { SyncEvent } from "../../src/sync"
import { SessionID } from "../../src/session/schema"

// engine-runtime [TP-R14-03] Event logs written before the removal still carry share links.
test("replaying legacy session events with share links applies the rest and keeps no link", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const original = await AppRuntime.runPromise(Session.Service.use((svc) => svc.create()))
      const id = SessionID.descending()
      const share = { url: "https://example.com/share/example" }
      SyncEvent.replay({
        id: `${id}-create`,
        aggregateID: id,
        seq: 0,
        type: "session.created.1",
        data: { sessionID: id, info: { ...original, id, share } },
      })
      SyncEvent.replay({
        id: `${id}-legacy`,
        aggregateID: id,
        seq: 1,
        type: "session.updated.1",
        data: { sessionID: id, info: { share } },
      })
      SyncEvent.replay({
        id: `${id}-unshare`,
        aggregateID: id,
        seq: 2,
        type: "session.updated.2",
        data: { sessionID: id, info: { share: { url: null } } },
      })
      SyncEvent.replay({
        id: `${id}-title`,
        aggregateID: id,
        seq: 3,
        type: "session.updated.2",
        data: { sessionID: id, previousRevision: 0, info: { title: "Kept", titleSource: "user", titleRevision: 1, share } },
      })
      const saved = await AppRuntime.runPromise(Session.Service.use((svc) => svc.get(id)))
      expect(saved.title).toBe("Kept")
      expect(saved).not.toHaveProperty("share")
    },
  })
})
