import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config } from "../../src/config"
import { inject } from "../../src/config/config"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Env } from "../../src/env"
import { EffectFlock } from "@mimo-ai/shared/util/effect-flock"
import { Npm } from "../../src/npm"
import { Global } from "../../src/global"
import { provideTmpdirInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import path from "path"
import fs from "fs/promises"

const layer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(
    Layer.mock(Auth.Service)({
      all: () => Effect.succeed({}),
    }),
  ),
  Layer.provide(
    Layer.mock(Account.Service)({
      active: () => Effect.succeed(Option.none()),
      activeOrg: () => Effect.succeed(Option.none()),
    }),
  ),
  Layer.provide(Npm.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const load = () => Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(layer)))

describe("Config.inject in-memory overlay", () => {
  beforeEach(() => {
    inject(undefined)
  })
  afterEach(() => {
    inject(undefined)
    delete process.env.MIMOCODE_CONFIG_DEFAULTS
  })

  test("inject model_groups appears after load without writing global config", async () => {
    const globalFile = path.join(Global.Path.config, "mimocode.json")
    const before = await fs.readFile(globalFile, "utf8").catch(() => null)

    inject({ model_groups: { lite: "test/flash", standard: "test/pro", ultra: "test/pro" } } as never)

    await provideTmpdirInstance(() =>
      Effect.promise(async () => {
        const cfg = await load()
        expect(cfg.model_groups?.lite).toBe("test/flash")
        expect(cfg.model_groups?.standard).toBe("test/pro")
      }),
    )

    const after = await fs.readFile(globalFile, "utf8").catch(() => null)
    expect(after).toBe(before)
    expect(after ?? "").not.toContain("test/flash")
  })

  test("user file leaf wins over overlay", async () => {
    inject({ model_groups: { lite: "overlay/lite" } } as never)
    await provideTmpdirInstance(
      () =>
        Effect.promise(async () => {
          const cfg = await load()
          expect(cfg.model_groups?.lite).toBe("user/lite")
        }),
      { config: { model_groups: { lite: "user/lite" } } as never },
    )
  })

  test("inject(undefined) clears overlay", async () => {
    inject({ model_groups: { lite: "overlay/lite" } } as never)
    inject(undefined)
    await provideTmpdirInstance(() =>
      Effect.promise(async () => {
        const cfg = await load()
        expect(cfg.model_groups?.lite).toBeUndefined()
      }),
    )
  })

  test("overlay wins over MIMOCODE_CONFIG_DEFAULTS", async () => {
    process.env.MIMOCODE_CONFIG_DEFAULTS = JSON.stringify({ model_groups: { lite: "defaults/lite" } })
    inject({ model_groups: { lite: "overlay/lite" } } as never)
    await provideTmpdirInstance(() =>
      Effect.promise(async () => {
        const cfg = await load()
        expect(cfg.model_groups?.lite).toBe("overlay/lite")
      }),
    )
  })
})
