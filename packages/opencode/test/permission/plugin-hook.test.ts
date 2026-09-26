import { afterEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import fs from "fs"
import path from "path"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const bus = Bus.layer
const env = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(bus)),
  Plugin.defaultLayer,
  bus,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(env)

// A request that genuinely needs ask: no rule auto-approves and the pattern is
// not on any default-allow list.
function buildRequest() {
  return {
    permission: "read" as never,
    patterns: ["/some/never-allowed-path"],
    always: ["*"],
    metadata: {},
    sessionID: "ses_test" as never,
    ruleset: [], // empty ruleset → evaluate falls through to needsAsk
    tool: { messageID: "msg_test" as never, callID: "call_test" },
  }
}

// File hooks are loaded from the project's .mimocode/hooks directory before
// the Instance is created (FILE_HOOK_GLOB = "{hook,hooks}/*.{js,ts}").
async function projectWithAskHook(decision: string) {
  return tmpdir({
    init: async (dir) => {
      const hookDir = path.join(dir, ".mimocode", "hooks")
      await fs.promises.mkdir(hookDir, { recursive: true })
      await Bun.write(
        path.join(hookDir, "ask.ts"),
        [
          "export default {",
          '  "permission.ask": async (input: any, output: any) => {',
          decision,
          "  },",
          "}",
          "",
        ].join("\n"),
      )
      await Bun.write(path.join(dir, "mimocode.json"), "{}")
    },
  })
}

async function runAskInInstance(dir: string) {
  return Instance.provide({
    directory: dir,
    fn: async () =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        return yield* perm.ask(buildRequest()).pipe(Effect.exit)
      }).pipe(Effect.provide(env), Effect.runPromise),
  })
}

describe("permission.ask plugin hook", () => {
  it.live(
    "auto-allows when the plugin sets status=allow",
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => projectWithAskHook('if (input.type === "read") output.status = "allow"'))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      const result = yield* Effect.promise(() => runAskInInstance(tmp.path))
      expect(result._tag).toBe("Success")
    }),
    30000,
  )

  it.live(
    "auto-denies when the plugin sets status=deny",
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => projectWithAskHook('if (input.type === "read") output.status = "deny"'))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      const result = yield* Effect.promise(() => runAskInInstance(tmp.path))
      expect(result._tag).toBe("Failure")
    }),
    30000,
  )

  it.live(
    "falls through to the human prompt when the plugin leaves status unset",
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => projectWithAskHook("// no decision"))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      // Without a human reply the ask blocks, so a bounded timeout must fire
      // rather than the ask auto-resolving.
      const result: Exit.Exit<void, unknown> = yield* Effect.promise(async () =>
        await Instance.provide({
          directory: tmp.path,
          fn: async () =>
            Effect.gen(function* () {
              const perm = yield* Permission.Service
              return yield* perm.ask(buildRequest()).pipe(Effect.timeout("200 millis"), Effect.exit)
            }).pipe(Effect.provide(env), Effect.runPromise),
        }),
      )
      expect(result._tag).toBe("Failure")
    }),
    30000,
  )

  it.live(
    "does not let a plugin bypass forced-ask permissions",
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => projectWithAskHook('if (input.type === "bash_delete") output.status = "allow"'))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      const forced = {
        permission: "bash_delete" as never,
        patterns: ["/some/file"],
        always: ["*"],
        metadata: {},
        sessionID: "ses_test" as never,
        ruleset: [],
        tool: { messageID: "msg_test" as never, callID: "call_test" },
      }
      // Forced-ask permissions never consult the hook → the ask blocks for a
      // human reply, so it must time out rather than auto-succeed.
      const result: Exit.Exit<void, unknown> = yield* Effect.promise(async () =>
        await Instance.provide({
          directory: tmp.path,
          fn: async () =>
            Effect.gen(function* () {
              const perm = yield* Permission.Service
              return yield* perm.ask(forced).pipe(Effect.timeout("200 millis"), Effect.exit)
            }).pipe(Effect.provide(env), Effect.runPromise),
        }),
      )
      expect(result._tag).toBe("Failure")
    }),
    30000,
  )
})
