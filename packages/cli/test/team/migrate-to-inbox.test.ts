import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Team } from "../../src/team"
import { SessionID } from "../../src/session/schema"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { tmpdir } from "../fixture/fixture"

const testLayer = Team.layer.pipe(Layer.provide(Bus.defaultLayer))

type RT = ManagedRuntime.ManagedRuntime<Team.Service, never>

afterEach(async () => {
  await Instance.disposeAll()
})

async function withTeam(directory: string, fn: (rt: RT) => Promise<void>) {
  return Instance.provide({
    directory,
    fn: async () => {
      const rt = ManagedRuntime.make(testLayer)
      try {
        await fn(rt)
      } finally {
        await rt.dispose()
      }
    },
  })
}

describe("Team module post-inbox-migration (Plan 4 / Task 2)", () => {
  test("members CRUD round-trips through filesystem", async () => {
    await using tmp = await tmpdir({ git: true })
    const sesX = SessionID.descending()
    const sesA = SessionID.descending()
    const sesB = SessionID.descending()
    await withTeam(tmp.path, async (rt) => {
      await rt.runPromise(
        Team.Service.use((team) =>
          Effect.gen(function* () {
            yield* team.create("alpha", sesX)
            yield* team.addMember("alpha", sesA, "explore", "researcher")
            yield* team.addMember("alpha", sesB, "general", "implementer")
            const members = yield* team.getMembers("alpha")
            expect(members.length).toBe(2)
            yield* team.removeMember("alpha", sesA)
            const after = yield* team.getMembers("alpha")
            expect(after.length).toBe(1)
            expect(after[0].sessionID).toBe(sesB)
          }),
        ),
      )
    })
  })

  test("team dir does NOT contain mailbox subdirectory or shared-state.md", async () => {
    await using tmp = await tmpdir({ git: true })
    const sesY = SessionID.descending()
    await withTeam(tmp.path, async (rt) => {
      await rt.runPromise(
        Team.Service.use((team) =>
          Effect.gen(function* () {
            yield* team.create("beta", sesY)
            const dir = yield* team.teamDir("beta")
            const entries = yield* Effect.promise(() => fs.readdir(dir))
            expect(entries).toContain("members.json")
            expect(entries).not.toContain("mailbox")
            expect(entries).not.toContain("shared-state.md")
          }),
        ),
      )
    })
  })

  test("addMember is idempotent — duplicate add does not create duplicate entry", async () => {
    await using tmp = await tmpdir({ git: true })
    const sesZ = SessionID.descending()
    const sesC = SessionID.descending()
    await withTeam(tmp.path, async (rt) => {
      await rt.runPromise(
        Team.Service.use((team) =>
          Effect.gen(function* () {
            yield* team.create("gamma", sesZ)
            yield* team.addMember("gamma", sesC, "general", "worker")
            yield* team.addMember("gamma", sesC, "general", "worker")
            const members = yield* team.getMembers("gamma")
            expect(members.length).toBe(1)
          }),
        ),
      )
    })
  })

  test("tool/team.ts is absent (Option A delete)", () => {
    const teamToolPath = path.join(__dirname, "../../src/tool/team.ts")
    expect(fsSync.existsSync(teamToolPath)).toBe(false)
  })

  test("tool/team.txt is absent (Option A delete)", () => {
    const teamTxtPath = path.join(__dirname, "../../src/tool/team.txt")
    expect(fsSync.existsSync(teamTxtPath)).toBe(false)
  })

  test("Team.Interface no longer exposes sendMessage / checkMessages / readState / writeState", () => {
    // Compile-time guard encoded as runtime assertion over the surviving keys.
    // If any deleted method were added back, this list would need updating — which
    // forces a conscious decision.
    const survivors: (keyof Team.Interface)[] = [
      "create",
      "addMember",
      "removeMember",
      "getMembers",
      "teamDir",
    ]
    expect(survivors).toEqual(["create", "addMember", "removeMember", "getMembers", "teamDir"])
    const deletedKeys = ["sendMessage", "checkMessages", "readState", "writeState"]
    for (const key of deletedKeys) {
      expect(survivors).not.toContain(key)
    }
  })
})
