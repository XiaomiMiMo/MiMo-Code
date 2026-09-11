import path from "path"
import { describe, expect } from "bun:test"
import { $ } from "bun"
import { Cause, Effect, Exit, Layer } from "effect"
import type { Tool } from "../../src/tool"
import {
  assertMainWorktreeWriteAllowed,
  assertHabitRepoMainWriteBlocked,
  buildMainWorktreeWriteRejection,
  isolationRoleFromContext,
  repoHasLinkedWorktrees,
} from "../../src/tool/auto-worktree-hint"
import { Config } from "../../src/config"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Log } from "../../src/util"

void Log.init({ print: false })

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, Config.defaultLayer))

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_aw_write_gate"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const failureMessage = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String((Cause.squash(exit.cause) as Error).message) : ""

const failureName = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return ""
  const err = Cause.squash(exit.cause) as Error
  return err.name
}

async function seedLinkedWorktree(repo: string) {
  const wt = path.join(path.dirname(repo), `${path.basename(repo)}-wt-${Math.random().toString(36).slice(2)}`)
  await $`git -C ${repo} worktree add ${wt} -b aw-gate-habit`.quiet()
  return wt
}

describe("assertMainWorktreeWriteAllowed (write-tool hard gate)", () => {
  it.live(
    "habit repo + auto_worktree:true → write into main is blocked with AutoWorktreeBlockedError",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => seedLinkedWorktree(dir).then(() => undefined))
          const target = path.join(dir, "src", "app.ts")
          const exit = yield* Effect.exit(assertMainWorktreeWriteAllowed(target))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(failureName(exit)).toBe("AutoWorktreeBlockedError")
          const message = failureMessage(exit)
          expect(message).toContain("MAIN worktree")
          expect(message).toContain("Isolate this change into a worktree")
          expect(message).toContain("Do NOT retry against the main worktree path")
          // Policy only — no git recipe for the model to follow literally.
          expect(message).not.toContain("git worktree add")
          expect(message).not.toMatch(/created a worktree/i)
        }),
      { git: true, config: { auto_worktree: true } },
    ),
  )

  it.live(
    "habit repo + auto_worktree:false → write into main is allowed",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => seedLinkedWorktree(dir).then(() => undefined))
          const exit = yield* Effect.exit(assertMainWorktreeWriteAllowed(path.join(dir, "src", "app.ts")))
          expect(Exit.isSuccess(exit)).toBe(true)
        }),
      { git: true, config: { auto_worktree: false } },
    ),
  )

  it.live(
    "habit repo + auto_worktree unset (product default) → write into main is allowed",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => seedLinkedWorktree(dir).then(() => undefined))
          const exit = yield* Effect.exit(assertMainWorktreeWriteAllowed(path.join(dir, "src", "app.ts")))
          expect(Exit.isSuccess(exit)).toBe(true)
        }),
      { git: true },
    ),
  )

  it.live(
    "no linked worktrees + auto_worktree:true → write into main is allowed (noHabit is notice-only)",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          expect(repoHasLinkedWorktrees(dir)).toBe(false)
          const exit = yield* Effect.exit(assertMainWorktreeWriteAllowed(path.join(dir, "src", "app.ts")))
          expect(Exit.isSuccess(exit)).toBe(true)
        }),
      { git: true, config: { auto_worktree: true } },
    ),
  )

  it.live(
    "linked worktree path in a habit repo + auto_worktree:true → write is allowed",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const wt = yield* Effect.promise(() => seedLinkedWorktree(dir))
          const exit = yield* Effect.exit(assertMainWorktreeWriteAllowed(path.join(wt, "src", "app.ts")))
          expect(Exit.isSuccess(exit)).toBe(true)
        }),
      { git: true, config: { auto_worktree: true } },
    ),
  )

  it.live(
    "non-git path → write is allowed regardless of config",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(assertMainWorktreeWriteAllowed(path.join(dir, "scratch.txt")))
          expect(Exit.isSuccess(exit)).toBe(true)
        }),
      { outsideGit: true, config: { auto_worktree: true } },
    ),
  )

  it.live(
    "assertHabitRepoMainWriteBlocked: bash path — hits already resolved to a main root",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => seedLinkedWorktree(dir).then(() => undefined))
          const exit = yield* Effect.exit(assertHabitRepoMainWriteBlocked(dir))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(failureName(exit)).toBe("AutoWorktreeBlockedError")
        }),
      { git: true, config: { auto_worktree: true } },
    ),
  )

  it.live(
    "subagent (agentMode=subagent) gets escalate copy, not self-isolate",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => seedLinkedWorktree(dir).then(() => undefined))
          const exit = yield* Effect.exit(assertMainWorktreeWriteAllowed(path.join(dir, "src", "app.ts"), {
            agentMode: "subagent",
          }))
          expect(Exit.isFailure(exit)).toBe(true)
          const message = failureMessage(exit)
          expect(message).toContain("You are a subagent")
          expect(message).toContain("Do NOT create a worktree yourself")
          expect(message).toContain("parent agent")
          // Policy, not a git recipe.
          expect(message).not.toContain("git worktree add")
          expect(message).not.toContain("Isolate this change into a worktree")
        }),
      { git: true, config: { auto_worktree: true } },
    ),
  )

  it.live(
    "primary (agentMode=primary) gets isolate-without-recipe copy",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => seedLinkedWorktree(dir).then(() => undefined))
          const exit = yield* Effect.exit(assertMainWorktreeWriteAllowed(path.join(dir, "src", "app.ts"), {
            agentMode: "primary",
          }))
          expect(Exit.isFailure(exit)).toBe(true)
          const message = failureMessage(exit)
          expect(message).toContain("Isolate this change into a worktree")
          expect(message).toContain("Do NOT retry against the main worktree path")
          expect(message).not.toContain("git worktree add")
        }),
      { git: true, config: { auto_worktree: true } },
    ),
  )
})

describe("buildMainWorktreeWriteRejection message contract", () => {
  it.live(
    "parent/primary rejection: policy + outcome, no command recipe",
    Effect.sync(() => {
      const err = buildMainWorktreeWriteRejection("/repo/main", "parent")
      expect(err.name).toBe("AutoWorktreeBlockedError")
      const message = err.message
      expect(message).toContain("`/repo/main`")
      expect(message).toContain("Isolate this change into a worktree under this repo")
      expect(message).toContain("retry with a path under that worktree")
      expect(message).toContain("Do NOT retry against the main worktree path")
      expect(message).not.toContain("git worktree add")
      expect(message).not.toMatch(/auto-creat/i)
      expect(message).not.toContain("You are a subagent")
    }),
  )

  it.live(
    "subagent rejection: escalate to parent, never self-isolate, no recipe",
    Effect.sync(() => {
      const err = buildMainWorktreeWriteRejection("/repo/main", "child")
      const message = err.message
      expect(message).toContain("You are a subagent")
      expect(message).toContain("Do NOT create a worktree yourself")
      expect(message).toContain("parent agent")
      expect(message).not.toContain("git worktree add")
      expect(message).not.toContain("Isolate this change into a worktree under this repo")
    }),
  )

  it.live(
    "isolationRoleFromContext: only agentMode=subagent is child",
    Effect.sync(() => {
      expect(isolationRoleFromContext({ agentMode: "subagent" })).toBe("child")
      expect(isolationRoleFromContext({ agentMode: "primary" })).toBe("parent")
      expect(isolationRoleFromContext({ agentMode: "all" })).toBe("parent")
      expect(isolationRoleFromContext({})).toBe("parent")
      expect(isolationRoleFromContext(undefined)).toBe("parent")
    }),
  )
})
