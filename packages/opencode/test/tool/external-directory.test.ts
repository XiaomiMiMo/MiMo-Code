import { describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs"
import { Effect } from "effect"
import type { Tool } from "../../src/tool"
import { Instance } from "../../src/project/instance"
import { assertExternalDirectory } from "../../src/tool/external-directory"
import { Filesystem } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { Global } from "../../src/global"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

function makeCtx() {
  const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

describe("tool.assertExternalDirectory", () => {
  test("no-ops for empty target", async () => {
    const { requests, ctx } = makeCtx()

    await Instance.provide({
      directory: "/tmp",
      fn: async () => {
        await assertExternalDirectory(ctx)
      },
    })

    expect(requests.length).toBe(0)
  })

  test("no-ops for paths inside Instance.directory", async () => {
    const { requests, ctx } = makeCtx()

    await Instance.provide({
      directory: "/tmp/project",
      fn: async () => {
        await assertExternalDirectory(ctx, path.join("/tmp/project", "file.txt"))
      },
    })

    expect(requests.length).toBe(0)
  })

  test("asks with a single canonical glob", async () => {
    const { requests, ctx } = makeCtx()

    const directory = "/tmp/project"
    const target = "/tmp/outside/file.txt"
    const expected = glob(path.join(path.dirname(target), "*"))

    await Instance.provide({
      directory,
      fn: async () => {
        await assertExternalDirectory(ctx, target)
      },
    })

    const req = requests.find((r) => r.permission === "external_directory")
    expect(req).toBeDefined()
    expect(req!.patterns).toEqual([expected])
    expect(req!.always).toEqual([expected])
  })

  test("uses target directory when kind=directory", async () => {
    const { requests, ctx } = makeCtx()

    const directory = "/tmp/project"
    const target = "/tmp/outside"
    const expected = glob(path.join(target, "*"))

    await Instance.provide({
      directory,
      fn: async () => {
        await assertExternalDirectory(ctx, target, { kind: "directory" })
      },
    })

    const req = requests.find((r) => r.permission === "external_directory")
    expect(req).toBeDefined()
    expect(req!.patterns).toEqual([expected])
    expect(req!.always).toEqual([expected])
  })

  test("skips prompting when bypass=true", async () => {
    const { requests, ctx } = makeCtx()

    await Instance.provide({
      directory: "/tmp/project",
      fn: async () => {
        await assertExternalDirectory(ctx, "/tmp/outside/file.txt", { bypass: true })
      },
    })

    expect(requests.length).toBe(0)
  })

  test("does NOT ask for paths under the memory root (defers to memory-path-guard)", async () => {
    const { requests, ctx } = makeCtx()

    const memTarget = path.join(
      Global.Path.data,
      "memory",
      "sessions",
      "ses_test",
      "tasks",
      "T3",
      "progress.md",
    )

    await Instance.provide({
      directory: "/tmp/project", // memTarget is OUTSIDE the project dir on purpose
      fn: async () => {
        await assertExternalDirectory(ctx, memTarget)
      },
    })

    // memory region is governed by memory-path-guard, not external_directory
    expect(requests.length).toBe(0)
  })

  test("does NOT ask for paths under an orchestrator-created worktree base", async () => {
    const { requests, ctx } = makeCtx()

    // A child isolated into <data>/worktree/<projectID>/<name>. Its Instance may be
    // bound to the main checkout (subagent inherits parent ctx, or worktree boot
    // failed and it fell back to shared) — so the worktree path is OUTSIDE
    // Instance.directory on purpose. Without the trust it would raise
    // external_directory:ask and a background child with no replier would deadlock.
    const wtTarget = path.join(
      Global.Path.data,
      "worktree",
      "21e0df6f-0ff7-4b4e-9f19-9bf7d7f64ba1",
      "t25-gap-a-reliable-idle-peer-relay",
      "packages",
      "opencode",
      "src",
      "tool",
      "session.ts",
    )

    await Instance.provide({
      directory: "/tmp/project", // wtTarget is OUTSIDE the project dir on purpose
      fn: async () => {
        await assertExternalDirectory(ctx, wtTarget)
      },
    })

    // Orchestrator worktrees are app-managed, trusted workspaces — no ask.
    expect(requests.length).toBe(0)
  })

  test("still asks for non-memory paths outside the project (regression)", async () => {
    const { requests, ctx } = makeCtx()

    await Instance.provide({
      directory: "/tmp/project",
      fn: async () => {
        await assertExternalDirectory(ctx, "/tmp/outside/file.txt")
      },
    })

    expect(requests.find((r) => r.permission === "external_directory")).toBeDefined()
  })

  test("still asks for a foreign path even when it merely resembles the worktree base name (regression)", async () => {
    const { requests, ctx } = makeCtx()

    // A user path that is NOT under <data>/worktree must still prompt: the trust is
    // scoped to the app-managed base, it does not broadly weaken external_directory.
    await Instance.provide({
      directory: "/tmp/project",
      fn: async () => {
        await assertExternalDirectory(ctx, "/tmp/worktree/foreign/file.txt")
      },
    })

    expect(requests.find((r) => r.permission === "external_directory")).toBeDefined()
  })

  test("does NOT ask for an in-project path named through a symlinked project prefix", async () => {
    const { requests, ctx } = makeCtx()

    // A REAL symlinked prefix: <base>/link -> <base>/real, project at <...>/project.
    // `Instance.provide` realpath-resolves what it stores, so Instance.directory
    // becomes the <real> spelling while the tool call still carries the <link>
    // spelling. The two sides are then differently normalised — no attacker and no
    // exotic setup required — and a lexical-only containment test answers "outside",
    // raising external_directory:ask for a write that is plainly inside the project.
    // For a background/isolated child there is no interactive replier, so that ask
    // hangs on a never-resolved Deferred and the child deadlocks.
    const base = mkdtempSync(path.join(realpathSync(os.tmpdir()), "extdir-symlink-"))
    const realProject = path.join(base, "real", "project")
    mkdirSync(realProject, { recursive: true })
    symlinkSync(path.join(base, "real"), path.join(base, "link"), "dir")
    const linkedProject = path.join(base, "link", "project")

    await Instance.provide({
      directory: linkedProject,
      fn: async () => {
        await assertExternalDirectory(ctx, path.join(linkedProject, "src", "file.ts"))
      },
    })

    expect(requests.length).toBe(0)
    // Pin the asymmetry the test depends on, so a future fixture change cannot make
    // this pass for the wrong reason: the two spellings really are lexically foreign.
    expect(Filesystem.contains(realProject, path.join(linkedProject, "src", "file.ts"))).toBe(false)
  })

  test("still asks for a path outside a symlinked project prefix (regression)", async () => {
    const { requests, ctx } = makeCtx()

    // The realpath comparison must not become a blanket allow: a sibling directory
    // beside the project, reached through the same symlink, is still external.
    const base = mkdtempSync(path.join(realpathSync(os.tmpdir()), "extdir-symlink-out-"))
    mkdirSync(path.join(base, "real", "project"), { recursive: true })
    mkdirSync(path.join(base, "real", "elsewhere"), { recursive: true })
    symlinkSync(path.join(base, "real"), path.join(base, "link"), "dir")

    await Instance.provide({
      directory: path.join(base, "link", "project"),
      fn: async () => {
        await assertExternalDirectory(ctx, path.join(base, "link", "elsewhere", "file.ts"))
      },
    })

    expect(requests.find((r) => r.permission === "external_directory")).toBeDefined()
  })

  // The two <data>-rooted gates read Global.Path.data, which is fixed at import
  // time, so these name the SAME trusted file through a symlink that points at the
  // real data root. That is the production asymmetry — one side canonical, the other
  // not — without writing anything into the developer's real data directory.
  function dataRootAliasedTo(prefix: string) {
    const base = mkdtempSync(path.join(realpathSync(os.tmpdir()), prefix))
    const alias = path.join(base, "datalink")
    symlinkSync(Global.Path.data, alias, "dir")
    return alias
  }

  test("does NOT ask for a worktree path named through an aliased data root", async () => {
    const { requests, ctx } = makeCtx()

    // Regression guard for the deadlock the <data>/worktree trust exists to prevent:
    // if this gate answers "outside", a background/isolated child with no permission
    // replier hangs forever on the ask.
    const alias = dataRootAliasedTo("extdir-datalink-wt-")
    const target = path.join(alias, "worktree", "p_abc", "child-1", "packages", "opencode", "src", "tool", "session.ts")

    // Pin the hazard: lexically this is foreign to the canonical worktree base.
    expect(Filesystem.contains(path.join(Global.Path.data, "worktree"), target)).toBe(false)

    await Instance.provide({
      directory: "/tmp/project",
      fn: async () => {
        await assertExternalDirectory(ctx, target)
      },
    })

    expect(requests.length).toBe(0)
  })

  test("still asks for a memory path named through an aliased data root (deferral stays lexical)", async () => {
    const { requests, ctx } = makeCtx()

    // NOT an oversight. The memory early-return is a DEFERRAL to memory-path-guard,
    // and that guard is still lexical — assertMemoryWriteAllowed returns early on
    // `!target.startsWith(root)`, so an aliased memory path is governed by nothing.
    // Widening the deferral alone would drop the ask for precisely those paths, so
    // the memory branch deliberately keeps `contains` until the guard moves with it.
    // This test pins that decision so a future change has to confront it.
    const alias = dataRootAliasedTo("extdir-datalink-mem-")
    const target = path.join(alias, "memory", "sessions", "ses_test", "tasks", "T3", "progress.md")

    await Instance.provide({
      directory: "/tmp/project",
      fn: async () => {
        await assertExternalDirectory(ctx, target)
      },
    })

    expect(requests.find((r) => r.permission === "external_directory")).toBeDefined()
  })

  test("still asks for a foreign path reached through an aliased data root (regression)", async () => {
    const { requests, ctx } = makeCtx()

    // Aliasing the data root must not admit paths that are outside it even after
    // resolution — the trust stays scoped to the worktree subtree.
    const alias = dataRootAliasedTo("extdir-datalink-neg-")
    const target = path.join(alias, "not-a-trusted-subtree", "file.ts")

    await Instance.provide({
      directory: "/tmp/project",
      fn: async () => {
        await assertExternalDirectory(ctx, target)
      },
    })

    expect(requests.find((r) => r.permission === "external_directory")).toBeDefined()
  })

  if (process.platform === "win32") {
    test("normalizes Windows path variants to one glob", async () => {
      const { requests, ctx } = makeCtx()

      await using outerTmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "outside.txt"), "x")
        },
      })
      await using tmp = await tmpdir({ git: true })

      const target = path.join(outerTmp.path, "outside.txt")
      const alt = target
        .replace(/^[A-Za-z]:/, "")
        .replaceAll("\\", "/")
        .toLowerCase()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await assertExternalDirectory(ctx, alt)
        },
      })

      const req = requests.find((r) => r.permission === "external_directory")
      const expected = glob(path.join(outerTmp.path, "*"))
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    })

    test("uses drive root glob for root files", async () => {
      const { requests, ctx } = makeCtx()

      await using tmp = await tmpdir({ git: true })
      const root = path.parse(tmp.path).root
      const target = path.join(root, "boot.ini")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await assertExternalDirectory(ctx, target)
        },
      })

      const req = requests.find((r) => r.permission === "external_directory")
      const expected = path.join(root, "*")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    })
  }
})
