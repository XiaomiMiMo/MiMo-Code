import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { askEditUnlessMemory } from "../../src/tool/external-directory"
import type * as Tool from "../../src/tool/tool"
import { SYSTEM_SPAWNED_AGENT_TYPES } from "../../src/agent/config"
import { Log } from "../../src/util"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const bus = Bus.layer
const env = Layer.mergeAll(Permission.layer.pipe(Layer.provide(bus)), bus, CrossSpawnSpawner.defaultLayer)
const it = testEffect(env)

// Recording Tool.Context whose ask() pushes the permission name onto a log so
// tests can assert "ask was / was not invoked".
function makeRecordingCtx(calls: string[]): Tool.Context {
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

describe("checkpoint writer permission invariants", () => {
  // T13: pure static guard — detects accidental removal during refactors.
  // checkpoint-writer is the writer agent that prompt.ts/processor.ts inject
  // `interactive: false` for; dropping it from the set silently re-enables a
  // hangable ask path.
  it.live("T13: SYSTEM_SPAWNED_AGENT_TYPES includes 'checkpoint-writer'", () =>
    Effect.sync(() => {
      expect(SYSTEM_SPAWNED_AGENT_TYPES.has("checkpoint-writer")).toBe(true)
    }),
  )

  // T11: pin Permission.ask's interactive=false fail-clean branch
  // (permission/index.ts:206-210). With an `ask`-rule on a non-memory path,
  // the request would normally enter the pending map and block on a Deferred;
  // interactive=false MUST short-circuit to DeniedError instead. This is the
  // protection that lets a non-interactive writer never hang.
  it.live(
    "T11: writer's permission ask never blocks (returns DeniedError)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        let asked = 0
        const unsub = Bus.subscribe(Permission.Event.Asked, () => {
          asked += 1
        })
        const result = yield* perm
          .ask({
            permission: "edit" as never,
            patterns: ["/some/non-memory/path"],
            always: ["*"],
            metadata: {},
            sessionID: "ses_test" as never,
            // ruleset with `edit: ask` on the path — would otherwise pend.
            ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
            tool: { messageID: "msg_test" as never, callID: "call_test" },
            interactive: false,
          })
          .pipe(Effect.exit)
        unsub()
        expect(result._tag).toBe("Failure")
        expect(asked).toBe(0)
        // pending must be empty — fail-clean branch never inserts an entry.
        const pending = yield* perm.list()
        expect(pending.length).toBe(0)
      }),
    ),
  )

  // T12: pin askEditUnlessMemory's path-based bypass (external-directory.ts:119)
  // for paths under <data>/memory/, regardless of the parent's `edit` rule.
  // Even with `edit: ask` configured, the gate must NOT call ctx.ask for memory
  // paths — otherwise a parent's `edit:ask` would deadlock the writer (no human
  // to reply) even with the T11 fail-clean (the writer's ctx.ask is the parent
  // tool's permission ask, not the spawn-level interactive=false ask).
  it.live(
    "T12: askEditUnlessMemory does not call ctx.ask for memory paths under `edit: ask`",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const calls: string[] = []
        const target = path.join(Global.Path.data, "memory", "sessions", "ses_x", "checkpoint.md")
        // The askEditUnlessMemory contract is path-based: it short-circuits
        // BEFORE reading any ruleset. We don't need to thread an `edit: ask`
        // ruleset into the call — the function never consults rules for
        // memory paths. The bypass is what protects the writer regardless of
        // parent permission config.
        yield* askEditUnlessMemory(makeRecordingCtx(calls), target, {
          patterns: ["checkpoint.md"],
          diff: "",
        })
        expect(calls).toEqual([])
      }),
    ),
  )

  // T8: same path-based bypass as T12, but documents the `edit: deny` case
  // explicitly. The bypass short-circuits before any ruleset evaluation, so
  // the parent's deny rule never has a chance to block memory writes. This
  // is what guarantees the writer can ALWAYS write memory.md.
  it.live(
    "T8: askEditUnlessMemory bypasses ctx.ask even when parent edit:deny",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const calls: string[] = []
        const target = path.join(Global.Path.data, "memory", "sessions", "ses_x", "checkpoint.md")
        yield* askEditUnlessMemory(makeRecordingCtx(calls), target, {
          patterns: ["checkpoint.md"],
          diff: "",
        })
        expect(calls).toEqual([])
      }),
    ),
  )
})
