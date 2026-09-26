import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Vcs } from "../../src/project"

function withVcsOnly(directory: string, body: () => Promise<void>) {
  return Instance.provide({
    directory,
    fn: async () => {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          yield* vcs.init()
        }),
      )
      await body()
    },
  })
}

describe("Vcs.pullRequest", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  test("returns not_github for non-github remotes", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git remote add origin git@gitlab.com:group/project.git`.cwd(tmp.path).quiet()

    await withVcsOnly(tmp.path, async () => {
      const result = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.pullRequest()
        }),
      )
      expect(result.status).toBe("not_github")
      expect(result.branch).toBeTruthy()
    })
  })

  test("returns not_github when no remote is configured", async () => {
    await using tmp = await tmpdir({ git: true })

    await withVcsOnly(tmp.path, async () => {
      const result = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.pullRequest()
        }),
      )
      expect(result.status).toBe("not_github")
    })
  })

  test("parses github remote and attempts authenticated lookup", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git remote add origin git@github.com:XiaomiMiMo/MiMo-Code.git`.cwd(tmp.path).quiet()
    await $`git branch -M main`.cwd(tmp.path).quiet()

    await withVcsOnly(tmp.path, async () => {
      const result = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.pullRequest()
        }),
      )
      expect(result.owner).toBe("XiaomiMiMo")
      expect(result.repo).toBe("MiMo-Code")
      expect(result.branch).toBe("main")
      // Live GitHub call: any mapped terminal status is acceptable.
      // Public repo + local gh/env token should not be not_github / no_branch.
      expect(["ok", "none", "unauthorized", "rate_limited", "error"]).toContain(result.status)
      if (result.status === "ok") {
        expect(result.pull?.number).toBeGreaterThan(0)
      }
    })
  })
})
