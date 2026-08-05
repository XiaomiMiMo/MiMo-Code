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
  sessionID: SessionID.make("ses_capture_gate"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const memoryTarget = (...parts: string[]) => path.join(Global.Path.data, "memory", ...parts)

const failureMessage = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String((Cause.squash(exit.cause) as Error).message) : ""

describe("assertWriteAllowed × memory.capture (W5)", () => {
  it.live(
    "capture: false → memory write is refused with an explicit 'disabled' message",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(assertWriteAllowed(ctx, memoryTarget("projects", "global", "MEMORY.md")))

          expect(Exit.isFailure(exit)).toBe(true)
          const message = failureMessage(exit)
          expect(message).toContain("Memory writing is DISABLED")
          expect(message).toContain("记忆写入已关闭")
          expect(message).toContain("memory.capture")
          // Must not read as a path/permission problem, or the model retries elsewhere.
          expect(message).toContain("Do NOT retry with another memory path")
        }),
      { outsideGit: true, config: { memory: { capture: false } } },
    ),
  )

  it.live(
    "capture: false → notes.md is refused too (not just canonical writer paths)",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            assertWriteAllowed(ctx, memoryTarget("sessions", "ses_capture_gate", "notes.md")),
          )
          expect(failureMessage(exit)).toContain("Memory writing is DISABLED")
        }),
      { outsideGit: true, config: { memory: { capture: false } } },
    ),
  )

  it.live(
    "capture: false → writes OUTSIDE the memory tree are unaffected",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(assertWriteAllowed(ctx, path.join(dir, "src", "app.ts")))
          expect(Exit.isSuccess(exit)).toBe(true)
        }),
      { outsideGit: true, config: { memory: { capture: false } } },
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
    "capture: true → memory write still allowed",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(assertWriteAllowed(ctx, memoryTarget("projects", "global", "MEMORY.md")))
          expect(Exit.isSuccess(exit)).toBe(true)
        }),
      { outsideGit: true, config: { memory: { capture: true } } },
    ),
  )
})
