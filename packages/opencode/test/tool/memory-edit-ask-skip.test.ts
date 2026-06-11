import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { askEditUnlessMemory } from "../../src/tool/external-directory"
import type * as Tool from "../../src/tool/tool"
import { Log } from "../../src/util"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(CrossSpawnSpawner.defaultLayer)

// Minimal Tool.Context whose ask() records whether it was called.
function makeCtx(calls: string[]): Tool.Context {
  return {
    sessionID: "ses_test" as never,
    abort: new AbortController().signal,
    messageID: "msg_test" as never,
    callID: "call_test",
    agent: "checkpoint-writer",
    messages: [],
    metadata: () => Effect.void,
    ask: (req: { permission: string }) =>
      Effect.sync(() => {
        calls.push(req.permission)
      }),
  } as unknown as Tool.Context
}

describe("askEditUnlessMemory", () => {
  it.live(
    "skips the edit ask for a path under <data>/memory/",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const calls: string[] = []
        const target = path.join(Global.Path.data, "memory", "sessions", "ses_x", "checkpoint.md")
        yield* askEditUnlessMemory(makeCtx(calls), target, { patterns: ["checkpoint.md"], diff: "" })
        expect(calls).toEqual([]) // no edit ask
      }),
    ),
  )

  it.live(
    "still asks for a non-memory path",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const calls: string[] = []
        const target = path.join(Global.Path.data, "not-memory", "foo.md")
        yield* askEditUnlessMemory(makeCtx(calls), target, { patterns: ["foo.md"], diff: "" })
        expect(calls).toEqual(["edit"])
      }),
    ),
  )
})
