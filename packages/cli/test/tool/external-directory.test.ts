import { describe, expect, test } from "bun:test"
import path from "path"
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

// Project and outside targets live in SEPARATE fixture roots OUTSIDE the
// mimocode worktree (`outsideGit`). The project is its OWN git repo so
// Instance.worktree is that directory — not a shared ancestor like /tmp (which
// is itself a git repo on some machines and would swallow every /tmp sibling).
async function withProjectAndOutside<T>(
  fn: (paths: { project: string; outsideFile: string; outsideDir: string }) => Promise<T>,
): Promise<T> {
  await using project = await tmpdir({ git: true, outsideGit: true })
  await using outside = await tmpdir({
    outsideGit: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "file.txt"), "x")
      await Bun.write(path.join(dir, "sub", "nested.txt"), "x")
    },
  })
  return fn({
    project: project.path,
    outsideFile: path.join(outside.path, "file.txt"),
    outsideDir: path.join(outside.path, "sub"),
  })
}

describe("tool.assertExternalDirectory", () => {
  test("no-ops for empty target", async () => {
    const { requests, ctx } = makeCtx()

    await withProjectAndOutside(async ({ project }) => {
      await Instance.provide({
        directory: project,
        fn: async () => {
          await assertExternalDirectory(ctx)
        },
      })
    })

    expect(requests.length).toBe(0)
  })

  test("no-ops for paths inside Instance.directory", async () => {
    const { requests, ctx } = makeCtx()

    await withProjectAndOutside(async ({ project }) => {
      await Instance.provide({
        directory: project,
        fn: async () => {
          await assertExternalDirectory(ctx, path.join(project, "file.txt"))
        },
      })
    })

    expect(requests.length).toBe(0)
  })

  test("asks with a single canonical glob", async () => {
    const { requests, ctx } = makeCtx()

    await withProjectAndOutside(async ({ project, outsideFile }) => {
      const expected = glob(path.join(path.dirname(outsideFile), "*"))
      await Instance.provide({
        directory: project,
        fn: async () => {
          await assertExternalDirectory(ctx, outsideFile)
        },
      })

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    })
  })

  test("uses target directory when kind=directory", async () => {
    const { requests, ctx } = makeCtx()

    await withProjectAndOutside(async ({ project, outsideDir }) => {
      const expected = glob(path.join(outsideDir, "*"))
      await Instance.provide({
        directory: project,
        fn: async () => {
          await assertExternalDirectory(ctx, outsideDir, { kind: "directory" })
        },
      })

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    })
  })

  test("skips prompting when bypass=true", async () => {
    const { requests, ctx } = makeCtx()

    await withProjectAndOutside(async ({ project, outsideFile }) => {
      await Instance.provide({
        directory: project,
        fn: async () => {
          await assertExternalDirectory(ctx, outsideFile, { bypass: true })
        },
      })
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

    await withProjectAndOutside(async ({ project }) => {
      await Instance.provide({
        directory: project, // memTarget is OUTSIDE the project dir on purpose
        fn: async () => {
          await assertExternalDirectory(ctx, memTarget)
        },
      })
    })

    // memory region is governed by memory-path-guard, not external_directory
    expect(requests.length).toBe(0)
  })

  test("does NOT ask for paths under an app-managed worktree base", async () => {
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
      "child-worktree",
      "packages",
      "opencode",
      "src",
      "tool",
      "session.ts",
    )

    await withProjectAndOutside(async ({ project }) => {
      await Instance.provide({
        directory: project, // wtTarget is OUTSIDE the project dir on purpose
        fn: async () => {
          await assertExternalDirectory(ctx, wtTarget)
        },
      })
    })

    // App-managed worktrees are trusted workspaces — no ask.
    expect(requests.length).toBe(0)
  })

  test("still asks for non-memory paths outside the project (regression)", async () => {
    const { requests, ctx } = makeCtx()

    await withProjectAndOutside(async ({ project, outsideFile }) => {
      await Instance.provide({
        directory: project,
        fn: async () => {
          await assertExternalDirectory(ctx, outsideFile)
        },
      })
    })

    expect(requests.find((r) => r.permission === "external_directory")).toBeDefined()
  })

  test("still asks for a foreign path even when it merely resembles the worktree base name (regression)", async () => {
    const { requests, ctx } = makeCtx()

    // A user path that is NOT under <data>/worktree must still prompt: the trust is
    // scoped to the app-managed base, it does not broadly weaken external_directory.
    await using foreign = await tmpdir({
      outsideGit: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "worktree", "foreign", "file.txt"), "x")
      },
    })
    const foreignTarget = path.join(foreign.path, "worktree", "foreign", "file.txt")

    await withProjectAndOutside(async ({ project }) => {
      await Instance.provide({
        directory: project,
        fn: async () => {
          await assertExternalDirectory(ctx, foreignTarget)
        },
      })
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
