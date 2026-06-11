import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return run(SessionNs.Service.use((svc) => svc.updatePart(part)))
  },
}

afterEach(async () => {
  await Instance.disposeAll()
})

async function withoutWatcher<T>(fn: () => Promise<T>) {
  if (process.platform !== "win32") return fn()
  const prev = process.env.MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
  process.env.MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
    else process.env.MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = prev
  }
}

async function fill(
  sessionID: SessionID,
  count: number,
  time = (i: number) => Date.now() + i,
  agentID?: string,
) {
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    await svc.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
      ...(agentID !== undefined ? { agentID } : {}),
    } as unknown as MessageV2.Info)
    await svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: `m${i}${agentID ? `-${agentID}` : ""}`,
    })
  }
  return ids
}

describe("session messages endpoint", () => {
  test("returns cursor headers for older pages", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const ids = await fill(session.id, 5)
          const app = Server.Default().app

          const a = await app.request(`/session/${session.id}/message?limit=2`)
          expect(a.status).toBe(200)
          const aBody = (await a.json()) as MessageV2.WithParts[]
          expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
          const cursor = a.headers.get("x-next-cursor")
          expect(cursor).toBeTruthy()
          expect(a.headers.get("link")).toContain('rel="next"')

          const b = await app.request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
          expect(b.status).toBe(200)
          const bBody = (await b.json()) as MessageV2.WithParts[]
          expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("keeps full-history responses when limit is omitted", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const ids = await fill(session.id, 3)
          const app = Server.Default().app

          const res = await app.request(`/session/${session.id}/message`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as MessageV2.WithParts[]
          expect(body.map((item) => item.info.id)).toEqual(ids)

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("rejects invalid cursors and missing sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const app = Server.Default().app

          const bad = await app.request(`/session/${session.id}/message?limit=2&before=bad`)
          expect(bad.status).toBe(400)

          const miss = await app.request(`/session/ses_missing/message?limit=2`)
          expect(miss.status).toBe(404)

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("filters out subagent slices by default; opts in via agent_id query param", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          // Interleave main + subagent rows so a wrong filter would still
          // pick some rows up by accident.
          const baseTime = Date.now()
          const main = await fill(session.id, 2, (i) => baseTime + i)
          const writer = await fill(session.id, 2, (i) => baseTime + 10 + i, "checkpoint-writer-1")
          const more = await fill(session.id, 1, (i) => baseTime + 20 + i)

          const app = Server.Default().app

          // Default — main slice only (the bug we're fixing).
          const def = await app.request(`/session/${session.id}/message`)
          expect(def.status).toBe(200)
          const defBody = (await def.json()) as MessageV2.WithParts[]
          expect(defBody.map((m) => m.info.id)).toEqual([...main, ...more])

          // ?agent_id=<id> — that subagent's slice only.
          const sub = await app.request(`/session/${session.id}/message?agent_id=checkpoint-writer-1`)
          expect(sub.status).toBe(200)
          const subBody = (await sub.json()) as MessageV2.WithParts[]
          expect(subBody.map((m) => m.info.id)).toEqual(writer)

          // ?agent_id=* — all slices, preserves the legacy "no filter" behavior
          // for callers that explicitly opt in.
          const all = await app.request(`/session/${session.id}/message?agent_id=*`)
          expect(all.status).toBe(200)
          const allBody = (await all.json()) as MessageV2.WithParts[]
          expect(allBody.map((m) => m.info.id)).toEqual([...main, ...writer, ...more])

          // Same defaulting on the cursor-paginated path.
          const limited = await app.request(`/session/${session.id}/message?limit=10`)
          expect(limited.status).toBe(200)
          const limitedBody = (await limited.json()) as MessageV2.WithParts[]
          expect(limitedBody.map((m) => m.info.id)).toEqual([...main, ...more])

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("does not truncate large legacy limit requests", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          await fill(session.id, 520)
          const app = Server.Default().app

          const res = await app.request(`/session/${session.id}/message?limit=510`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as MessageV2.WithParts[]
          expect(body).toHaveLength(510)

          await svc.remove(session.id)
        },
      }),
    )
  })
})
