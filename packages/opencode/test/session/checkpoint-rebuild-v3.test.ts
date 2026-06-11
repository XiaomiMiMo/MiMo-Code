import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Memory } from "../../src/memory"
import { Session } from "../../src/session"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { TaskRegistry } from "../../src/task/registry"
import { ActorRegistry } from "../../src/actor/registry"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    Memory.defaultLayer,
    Session.defaultLayer,
    TaskRegistry.defaultLayer,
    ActorRegistry.defaultLayer,
    SessionCheckpoint.defaultLayer,
  ),
)

describe("renderRebuildContext v3", () => {
  it.live("returns empty when no memory or tasks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const out = yield* cp.renderRebuildContext(sess.id)
        expect(out).toBe("")
      }),
    ),
  )

  it.live("includes tasks ledger when tasks exist", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const sess = yield* session.create({ title: "Test" })
        yield* reg.create({ session_id: sess.id, summary: "Refactor auth" })

        const out = yield* cp.renderRebuildContext(sess.id)
        expect(out).not.toContain("<system-reminder>")
        expect(out).not.toContain('memory({ action: "search"')
        expect(out).toContain("Tasks ledger")
        expect(out).toContain("T1")
        expect(out).toContain("Refactor auth")
      }),
    ),
  )

  it.live("includes project memory section when memory.md exists", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const memory = yield* Memory.Service
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const root = yield* memory.root()
        const projDir = path.join(root, "projects", "global")
        yield* Effect.promise(() => fs.mkdir(projDir, { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(projDir, "memory.md"), "用 Bun 不用 npm"),
        )

        const out = yield* cp.renderRebuildContext(sess.id)
        expect(out).toContain("## Project memory")
        expect(out).toContain("用 Bun 不用 npm")
        // No global/MEMORY.md written → no spurious Global memory header.
        expect(out).not.toContain("## Global memory")
      }),
    ),
  )

  it.live("includes global memory section when global/MEMORY.md exists", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const memory = yield* Memory.Service
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const root = yield* memory.root()
        const globalDir = path.join(root, "global")
        yield* Effect.promise(() => fs.mkdir(globalDir, { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(globalDir, "MEMORY.md"), "prefer terse responses"),
        )

        const out = yield* cp.renderRebuildContext(sess.id)
        expect(out).toContain("## Global memory")
        expect(out).toContain("prefer terse responses")
      }),
    ),
  )

  it.live("global-only session does not early-bail", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const memory = yield* Memory.Service
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const root = yield* memory.root()
        const globalDir = path.join(root, "global")
        yield* Effect.promise(() => fs.mkdir(globalDir, { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(globalDir, "MEMORY.md"), "global only content"),
        )

        // No tasks, no checkpoint.md, no project memory.md — only global.
        const out = yield* cp.renderRebuildContext(sess.id)
        expect(out).not.toBe("")
        expect(out).toContain("global only content")
      }),
    ),
  )

  it.live("includes task in tasks ledger and memory index references progress.md", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const memory = yield* Memory.Service
        const session = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const sess = yield* session.create({ title: "Test" })

        const t1 = yield* reg.create({ session_id: sess.id, summary: "Auth" })

        const root = yield* memory.root()
        const taskDir = path.join(root, "sessions", sess.id, "tasks", t1.id)
        yield* Effect.promise(() => fs.mkdir(taskDir, { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(taskDir, "progress.md"), "Step 1 done. Working on step 2."),
        )

        const out = yield* cp.renderRebuildContext(sess.id)
        expect(out).toContain(t1.id)
        expect(out).toContain("Tasks ledger")
        expect(out).toContain("Memory keys index")
        expect(out).toContain("progress.md")
      }),
    ),
  )

  it.live("appends stopReminder when lastMessageInfo is assistant+stop", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const sess = yield* session.create({ title: "Test" })
        yield* reg.create({ session_id: sess.id, summary: "Some task" })

        const out = yield* cp.renderRebuildContext(sess.id, { lastMessageInfo: { role: "assistant", finish: "stop" } })
        expect(out).toContain("The previous assistant turn ended with a stop")
        expect(out).toContain("progress.md head section")
      }),
    ),
  )

  it.live("appends autonomousLoopReminder when lastMessageInfo is assistant+tool-calls", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const sess = yield* session.create({ title: "Test" })
        yield* reg.create({ session_id: sess.id, summary: "Some task" })

        const out = yield* cp.renderRebuildContext(sess.id, { lastMessageInfo: { role: "assistant", finish: "tool-calls" } })
        expect(out).toContain("mid-loop in an autonomous task")
      }),
    ),
  )

  it.live("appends toolResultContinueReminder when lastMessageInfo is tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const sess = yield* session.create({ title: "Test" })
        yield* reg.create({ session_id: sess.id, summary: "Some task" })

        const out = yield* cp.renderRebuildContext(sess.id, { lastMessageInfo: { role: "tool" } })
        expect(out).toContain("Tool results above are real history")
      }),
    ),
  )

  it.live("no reminder when lastMessageInfo is user", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const sess = yield* session.create({ title: "Test" })
        yield* reg.create({ session_id: sess.id, summary: "Some task" })

        const out = yield* cp.renderRebuildContext(sess.id, { lastMessageInfo: { role: "user" } })
        expect(out).not.toContain("mid-loop in an autonomous task")
        expect(out).not.toContain("The previous assistant turn ended with a stop")
        expect(out).not.toContain("Tool results above are real history")
      }),
    ),
  )

  // Regression: F49+F50 made the main agent's lastUser.agentID = "main"
  // (rather than undefined). The runLoop's overflow path calls
  // renderRebuildContext({ agentID: lastUser.agentID }). A bare
  // `if (opts?.agentID) return ""` would treat main as a subagent here and
  // skip rebuild — fall through to F39 compaction → context loss after the
  // first trim. agentID="main" must produce the same output as the unset
  // case, while a real subagent id still returns empty.
  it.live("treats agentID='main' the same as no agentID; subagent ids return empty", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const sess = yield* session.create({ title: "Test" })
        yield* reg.create({ session_id: sess.id, summary: "Refactor auth" })

        const noArg = yield* cp.renderRebuildContext(sess.id)
        const mainArg = yield* cp.renderRebuildContext(sess.id, { agentID: "main" })
        const subagentArg = yield* cp.renderRebuildContext(sess.id, { agentID: "explore-1" })

        expect(noArg).toContain("Tasks ledger")
        expect(mainArg).toBe(noArg)
        expect(subagentArg).toBe("")
      }),
    ),
  )
})
