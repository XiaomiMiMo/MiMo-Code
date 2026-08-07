import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import type { Tool } from "../../src/tool"
import { assertWriteAllowed } from "../../src/tool/external-directory"
import { Config } from "../../src/config"
import { Global } from "../../src/global"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Log } from "../../src/util"

void Log.init({ print: false })

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, Config.defaultLayer))

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_write_gate"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

// Global.Path.data is redirected to a per-run temp dir by the test preload, so
// these targets never point at the real user memory tree. Nothing here writes or
// deletes — the gate is asserted before any filesystem touch.
const memoryTarget = (...parts: string[]) => path.join(Global.Path.data, "memory", ...parts)

const failureMessage = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String((Cause.squash(exit.cause) as Error).message) : ""

describe("assertWriteAllowed × memory write switch (W5)", () => {
  it.live(
    "disable_write: true → memory write is refused with an explicit 'disabled' message",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(assertWriteAllowed(ctx, memoryTarget("projects", "global", "MEMORY.md")))

          expect(Exit.isFailure(exit)).toBe(true)
          const message = failureMessage(exit)
          expect(message).toContain("Memory WRITING is disabled")
          expect(message).toContain("memory.disable_write")
          // Single-language English, like every other message this gate throws:
          // the engine has no locale to consult, and the consuming client that
          // surfaces this carries its own translations.
          expect(message).not.toMatch(/[\u4e00-\u9fff]/)
          // Must not read as a path/permission problem, or the model retries elsewhere.
          expect(message).toContain("Do NOT retry with another memory path")
          // Must not claim memory as a whole is off — reads still work.
          expect(message).toContain("Reading is unaffected")
        }),
      { outsideGit: true, config: { memory: { disable_write: true } } },
    ),
  )

  it.live(
    "disable_write: true → notes.md is refused too (not just canonical writer paths)",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            assertWriteAllowed(ctx, memoryTarget("sessions", "ses_write_gate", "notes.md")),
          )
          expect(failureMessage(exit)).toContain("Memory WRITING is disabled")
        }),
      { outsideGit: true, config: { memory: { disable_write: true } } },
    ),
  )

  it.live(
    "disable_write: true → writes OUTSIDE the memory tree are unaffected",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(assertWriteAllowed(ctx, path.join(dir, "src", "app.ts")))
          expect(Exit.isSuccess(exit)).toBe(true)
        }),
      { outsideGit: true, config: { memory: { disable_write: true } } },
    ),
  )

  it.live(
    "absent config → memory write still allowed (backward compatible default)",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(assertWriteAllowed(ctx, memoryTarget("projects", "global", "MEMORY.md")))
          expect(Exit.isSuccess(exit)).toBe(true)
        }),
      { outsideGit: true },
    ),
  )

  it.live(
    "disable_write: false → memory write still allowed",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(assertWriteAllowed(ctx, memoryTarget("projects", "global", "MEMORY.md")))
          expect(Exit.isSuccess(exit)).toBe(true)
        }),
      { outsideGit: true, config: { memory: { disable_write: false } } },
    ),
  )
})
