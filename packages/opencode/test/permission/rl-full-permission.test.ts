import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Flag } from "../../src/flag/flag"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const fullPermission = Flag.MIMOCODE_RL_FULL_PERMISSION

beforeEach(() => {
  Flag.MIMOCODE_RL_FULL_PERMISSION = true
})

afterEach(async () => {
  Flag.MIMOCODE_RL_FULL_PERMISSION = fullPermission
  await Instance.disposeAll()
})

const bus = Bus.layer
const env = Layer.mergeAll(Permission.layer.pipe(Layer.provide(bus)), bus, CrossSpawnSpawner.defaultLayer)
const it = testEffect(env)

function request(permission: string) {
  return {
    permission,
    patterns: ["*"],
    always: ["*"],
    metadata: {},
    sessionID: "ses_rl_full_permission" as never,
    ruleset: [{ permission: "*", pattern: "*", action: "deny" as const }],
    interactive: false,
  }
}

describe("RL full permission", () => {
  test("flag is enabled globally by default and can be disabled explicitly", () => {
    const read = (value?: string) => {
      const env = { ...process.env }
      if (value === undefined) delete env.MIMOCODE_RL_FULL_PERMISSION
      else env.MIMOCODE_RL_FULL_PERMISSION = value
      return Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'import { Flag } from "./src/flag/flag.ts"; process.stdout.write(String(Flag.MIMOCODE_RL_FULL_PERMISSION))',
        ],
        cwd: process.cwd(),
        env,
      }).stdout.toString()
    }
    expect(read()).toBe("true")
    expect(read("true")).toBe("true")
    expect(read("false")).toBe("false")
    expect(read("0")).toBe("false")
  })

  it.live(
    "overrides explicit deny without publishing an approval request",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        let asked = 0
        const unsubscribe = Bus.subscribe(Permission.Event.Asked, () => {
          asked++
        })
        const result = yield* permission.ask(request("edit")).pipe(Effect.exit)
        unsubscribe()
        expect(result._tag).toBe("Success")
        expect(asked).toBe(0)
        expect(yield* permission.list()).toEqual([])
      }),
    ),
  )

  it.live(
    "auto-allows forced approval permissions",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        expect((yield* permission.ask(request("bash_delete")).pipe(Effect.exit))._tag).toBe("Success")
      }),
    ),
  )

  test("keeps tools visible despite deny rules", () => {
    expect(
      Permission.disabled(
        ["bash", "read", "edit"],
        [{ permission: "*", pattern: "*", action: "deny" }],
      ),
    ).toEqual(new Set())
  })
})
