import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import z from "zod"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project"
import { Session as SessionNs } from "../../src/session"
import { Server } from "../../src/server/server"
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
  setArchived(input: z.output<typeof SessionNs.SetArchivedInput>) {
    return run(SessionNs.Service.use((svc) => svc.setArchived(input)))
  },
  resolvePrompt(input: Parameters<SessionNs.Interface["resolvePrompt"]>[0]) {
    return run(SessionNs.Service.use((svc) => svc.resolvePrompt(input)))
  },
  setSummary(input: Parameters<SessionNs.Interface["setSummary"]>[0]) {
    return run(SessionNs.Service.use((svc) => svc.setSummary(input)))
  },
  get(id: SessionNs.Info["id"]) {
    return run(SessionNs.Service.use((svc) => svc.get(id)))
  },
}

describe("session.listGlobal", () => {
  test("lists sessions across projects with project metadata", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })

    const firstSession = await Instance.provide({
      directory: first.path,
      fn: async () => svc.create({ title: "first-session" }),
    })
    const secondSession = await Instance.provide({
      directory: second.path,
      fn: async () => svc.create({ title: "second-session" }),
    })

    const sessions = [...svc.listGlobal({ limit: 200 })]
    const ids = sessions.map((session) => session.id)

    expect(ids).toContain(firstSession.id)
    expect(ids).toContain(secondSession.id)

    const firstProject = Project.get(firstSession.projectID)
    const secondProject = Project.get(secondSession.projectID)

    const firstItem = sessions.find((session) => session.id === firstSession.id)
    const secondItem = sessions.find((session) => session.id === secondSession.id)

    expect(firstItem?.project?.id).toBe(firstProject?.id)
    expect(firstItem?.project?.worktree).toBe(firstProject?.worktree)
    expect(secondItem?.project?.id).toBe(secondProject?.id)
    expect(secondItem?.project?.worktree).toBe(secondProject?.worktree)
  })

  test("excludes archived sessions by default", async () => {
    await using tmp = await tmpdir({ git: true })

    const archived = await Instance.provide({
      directory: tmp.path,
      fn: async () => svc.create({ title: "archived-session" }),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => svc.setArchived({ sessionID: archived.id, time: Date.now() }),
    })

    const sessions = [...svc.listGlobal({ limit: 200 })]
    const ids = sessions.map((session) => session.id)

    expect(ids).not.toContain(archived.id)

    const allSessions = [...svc.listGlobal({ limit: 200, archived: true })]
    const allIds = allSessions.map((session) => session.id)

    expect(allIds).toContain(archived.id)
  })

  test("supports cursor pagination", async () => {
    await using tmp = await tmpdir({ git: true })

    const first = await Instance.provide({
      directory: tmp.path,
      fn: async () => svc.create({ title: "page-one" }),
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await Instance.provide({
      directory: tmp.path,
      fn: async () => svc.create({ title: "page-two" }),
    })

    const page = [...svc.listGlobal({ directory: tmp.path, limit: 1 })]
    expect(page.length).toBe(1)
    expect(page[0].id).toBe(second.id)

    const next = [...svc.listGlobal({ directory: tmp.path, limit: 10, cursor: page[0].time.updated })]
    const ids = next.map((session) => session.id)

    expect(ids).toContain(first.id)
    expect(ids).not.toContain(second.id)
  })

  // Desktop clients poll this list; per-session system prompts made the full view tens of MB.
  test("brief view omits per-session prompt, permission and diffs; the default view keeps them", async () => {
    await using tmp = await tmpdir({ git: true })
    const system = "s".repeat(64 * 1024)
    const patch = "p".repeat(16 * 1024)
    const permission = [{ permission: "bash", pattern: "*", action: "allow" as const }]

    const session = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await svc.create({ title: "heavy-session", permission })
        await svc.resolvePrompt({ sessionID: created.id, fallback: { system } })
        await svc.setSummary({
          sessionID: created.id,
          summary: { additions: 3, deletions: 1, files: 1, diffs: [{ file: "a.ts", patch, additions: 3, deletions: 1 }] },
        })
        return created
      },
    })
    const find = (view?: "full" | "brief") =>
      [...svc.listGlobal({ directory: tmp.path, limit: 10, view })].find((entry) => entry.id === session.id)

    const full = await Instance.provide({ directory: tmp.path, fn: () => svc.get(session.id) })
    for (const item of [find(), find("full")]) {
      expect(item?.prompt?.system).toBe(system)
      expect(item?.permission).toEqual(permission)
      expect(item?.summary?.diffs?.[0]?.patch).toBe(patch)
      expect(item).toEqual({ ...full, project: item!.project })
    }

    const item = find("brief")
    expect(item).toBeDefined()
    expect(item).not.toHaveProperty("prompt")
    expect(item).not.toHaveProperty("permission")
    expect(item).not.toHaveProperty("revert")
    expect(item?.summary).toEqual({ additions: 3, deletions: 1, files: 1 })
    expect(item?.title).toBe("heavy-session")
    expect(item?.directory).toBe(session.directory)
    expect(item?.time.created).toBe(session.time.created)
    expect(item?.project?.id).toBe(session.projectID)
    expect(JSON.stringify(item).length).toBeLessThan(2048)
    expect(SessionNs.GlobalInfo.safeParse(item).success).toBe(true)
  })

  test("route returns full sessions by default and brief sessions for view=brief", async () => {
    await using tmp = await tmpdir({ git: true })
    const system = "s".repeat(64 * 1024)
    const session = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await svc.create({ title: "route-session" })
        await svc.resolvePrompt({ sessionID: created.id, fallback: { system } })
        return created
      },
    })
    const request = (query: string) =>
      Server.Default().app.request(`/experimental/session?directory=${encodeURIComponent(tmp.path)}&roots=true${query}`)
    const read = async (query: string) => {
      const response = await request(query)
      expect(response.status).toBe(200)
      const list = (await response.json()) as Array<{ id: string; prompt?: { system?: string } }>
      return list.find((entry) => entry.id === session.id)
    }

    expect((await read(""))?.prompt?.system).toBe(system)
    expect((await read("&view=full"))?.prompt?.system).toBe(system)
    const brief = await read("&view=brief")
    expect(brief).toBeDefined()
    expect(brief).not.toHaveProperty("prompt")
    expect((await request("&view=compact")).status).toBe(400)
  })
})
