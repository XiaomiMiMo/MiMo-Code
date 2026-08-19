import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { GlobalBus } from "../../src/bus/global"
import { Snapshot } from "../../src/snapshot"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Filesystem } from "../../src/util"
import { Log } from "../../src/util"
import { resetDatabase } from "../fixture/db"
import { provideInstance, tmpdir, withTmpdirOutsideGit } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await resetDatabase()
})

// This test needs a tmpdir OUTSIDE any git repo so project detection doesn't
// inherit a parent .git. Serving a directory outside cwd is only allowed when the
// OPERATOR secured the server, so the password is set the way an operator sets it —
// in the environment. Poking the `Flag` object would no longer work and would not be
// the real mechanism: `Flag` reads the env var to tell an operator-supplied password
// apart from one an implicit listener generated for itself.
const TEST_PASSWORD = "init-git-test"
const authHeader = `Basic ${Buffer.from(`mimocode:${TEST_PASSWORD}`).toString("base64")}`

describe("project.initGit endpoint", () => {
  test("initializes git and reloads immediately", async () => {
    const prevFlag = process.env["MIMOCODE_SERVER_PASSWORD"]
    process.env["MIMOCODE_SERVER_PASSWORD"] = TEST_PASSWORD
    try {
      await using tmp = await tmpdir({ outsideGit: true })
      const app = Server.Default().app
      const seen: { directory?: string; payload: { type: string } }[] = []
      const fn = (evt: { directory?: string; payload: { type: string } }) => {
        seen.push(evt)
      }
      const reload = Instance.reload
      const reloadSpy = spyOn(Instance, "reload").mockImplementation((input) => reload(input))
      GlobalBus.on("event", fn)

      try {
        const init = await app.request("/project/git/init", {
          method: "POST",
          headers: {
            "x-mimocode-directory": tmp.path,
            "authorization": authHeader,
          },
        })
        const body = await init.json()
        expect(init.status).toBe(200)
        expect(body).toMatchObject({
          vcs: "git",
          worktree: tmp.path,
        })
        // v5: a freshly-initialised git repo has a UUID, not the "global" sentinel.
        expect(body.id).not.toBe("global")
        expect(reloadSpy).toHaveBeenCalledTimes(1)
        expect(seen.some((evt) => evt.directory === tmp.path && evt.payload.type === "server.instance.disposed")).toBe(
          true,
        )
        expect(await Filesystem.exists(path.join(tmp.path, ".git", "mimocode"))).toBe(false)

        const current = await app.request("/project/current", {
          headers: {
            "x-mimocode-directory": tmp.path,
            "authorization": authHeader,
          },
        })
        expect(current.status).toBe(200)
        expect(await current.json()).toMatchObject({
          vcs: "git",
          worktree: tmp.path,
        })

        expect(
          await Effect.runPromise(
            Snapshot.Service.use((svc) => svc.track()).pipe(
              provideInstance(tmp.path),
              Effect.provide(Snapshot.defaultLayer),
            ),
          ),
        ).toBeTruthy()
      } finally {
        await Instance.disposeAll()
        reloadSpy.mockRestore()
        GlobalBus.off("event", fn)
      }
    } finally {
      if (prevFlag === undefined) delete process.env["MIMOCODE_SERVER_PASSWORD"]
      else process.env["MIMOCODE_SERVER_PASSWORD"] = prevFlag
    }
  })

  test("does not reload when the project is already git", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default().app
    const seen: { directory?: string; payload: { type: string } }[] = []
    const fn = (evt: { directory?: string; payload: { type: string } }) => {
      seen.push(evt)
    }
    const reload = Instance.reload
    const reloadSpy = spyOn(Instance, "reload").mockImplementation((input) => reload(input))
    GlobalBus.on("event", fn)

    try {
      const init = await app.request("/project/git/init", {
        method: "POST",
        headers: {
          "x-mimocode-directory": tmp.path,
        },
      })
      expect(init.status).toBe(200)
      expect(await init.json()).toMatchObject({
        vcs: "git",
        worktree: tmp.path,
      })
      expect(
        seen.filter((evt) => evt.directory === tmp.path && evt.payload.type === "server.instance.disposed").length,
      ).toBe(0)
      expect(reloadSpy).toHaveBeenCalledTimes(0)

      const current = await app.request("/project/current", {
        headers: {
          "x-mimocode-directory": tmp.path,
        },
      })
      expect(current.status).toBe(200)
      expect(await current.json()).toMatchObject({
        vcs: "git",
        worktree: tmp.path,
      })
    } finally {
      await Instance.disposeAll()
      reloadSpy.mockRestore()
      GlobalBus.off("event", fn)
    }
  })
})
