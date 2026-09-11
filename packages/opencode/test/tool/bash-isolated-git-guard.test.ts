import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import fs from "fs/promises"
import path from "path"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Plugin } from "../../src/plugin"
import * as Git from "../../src/git"
import { tmpdir } from "../fixture/fixture"

// End-to-end proof that the cross-branch git guard is actually WIRED into the
// bash tool (not just a unit-tested module): an isolated child's Instance
// directory lives under `<data>/worktree/...`, and a cross-branch git command
// executed there must be rejected before the process is spawned.

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    // bash.ts resolves the repo git identity through the Git service (added when
    // the worktree-identity work landed), so the runtime must provide it.
    Git.defaultLayer,
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_guard_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const init = () => runtime.runPromise(BashTool.pipe(Effect.flatMap((info) => info.init())))

async function withIsolatedWorktree(fn: (dir: string) => Promise<void>) {
  const dir = path.join(Global.Path.data, "worktree", `guardtest-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  try {
    await Instance.provide({ directory: dir, fn: () => fn(dir) })
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

const run = async (command: string) => {
  const bash = await init()
  return Effect.runPromise(bash.execute({ command, description: "guard probe" }, ctx))
}

describe("tool.bash isolated-child git guard", () => {
  test("rejects `git rebase main` from an isolated child's worktree", async () => {
    await withIsolatedWorktree(async (dir) => {
      let text = ""
      await run("git rebase main").then(
        () => {},
        (err) => {
          text = String(err?.message ?? err)
        },
      )
      expect(text).toContain("Blocked in an isolated child session")
      expect(text).toContain("git rebase main")
      expect(text).toContain("shares ONE .git/ ref store")
      expect(text).toContain(dir)
      expect(text).toContain("ask the orchestrator")
    })
  })

  test("rejects `git checkout main` even when chained after legitimate work", async () => {
    await withIsolatedWorktree(async () => {
      let text = ""
      await run("git add -A && git commit -m wip && git checkout main").then(
        () => {},
        (err) => {
          text = String(err?.message ?? err)
        },
      )
      expect(text).toContain("Blocked in an isolated child session")
      expect(text).toContain("git checkout main")
    })
  })

  test("allows the child's own work: `git status` runs normally", async () => {
    await withIsolatedWorktree(async () => {
      const result = await run("git status --porcelain")
      // Not a repo, so git exits non-zero — the point is that it RAN rather
      // than being rejected by the guard.
      expect(typeof result.metadata.exit).toBe("number")
      expect(result.output).not.toContain("Blocked in an isolated child session")
    })
  })

  test("a NON-isolated session is unaffected — `git rebase` is not gated", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await run("git rebase definitely-no-such-branch")
        expect(result.output).not.toContain("Blocked in an isolated child session")
        expect(result.metadata.exit).not.toBe(0)
      },
    })
  })
})
