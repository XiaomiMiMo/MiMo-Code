import { expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { EffectFlock } from "@mimo-ai/shared/util/effect-flock"
import { Config } from "../../src/config"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { Env } from "../../src/env"
import { TuiConfig } from "../../src/cli/cmd/tui/config/tui"
import { CurrentWorkingDirectory } from "../../src/cli/cmd/tui/config/cwd"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Configuration must work without a package installer, including when an old
// configuration directory still declares a plugin SDK version absent from npm.
const it = testEffect(
  Config.layer.pipe(
    Layer.provide(EffectFlock.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Account.defaultLayer),
    Layer.provideMerge(
      CrossSpawnSpawner.defaultLayer.pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
    ),
  ),
)

for (const dependencies of [
  undefined,
  { "@mimo-ai/plugin": "0.0.0-unpublished" },
  { "@example/dependency": "1.0.0" },
]) {
  it.live(`loads plugin configuration without installing ${JSON.stringify(dependencies) ?? "any dependencies"}`, () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            const local = path.join(dir, ".mimocode")
            await Bun.write(path.join(local, "plugins", "example.js"), "export default async () => ({})\n")
            await Bun.write(path.join(local, "tui.json"), JSON.stringify({ plugin: ["./plugins/example.js"] }))
            if (dependencies) await Bun.write(path.join(local, "package.json"), JSON.stringify({ dependencies }))
          })
          const config = yield* Config.Service.use((svc) => svc.get())
          const tui = yield* TuiConfig.Service.use((svc) => svc.get()).pipe(
            Effect.provide(TuiConfig.layer.pipe(Layer.provide(AppFileSystem.defaultLayer))),
            Effect.provideService(CurrentWorkingDirectory, dir),
          )
          expect(config.plugin).toHaveLength(1)
          expect(tui.plugin).toHaveLength(1)

          yield* Effect.promise(async () => {
            const local = path.join(dir, ".mimocode")
            expect(await Bun.file(path.join(local, "package.json")).exists()).toBe(!!dependencies)
            if (dependencies) {
              expect(await Bun.file(path.join(local, "package.json")).json()).toEqual({ dependencies })
            }
            expect(await Bun.file(path.join(local, "package-lock.json")).exists()).toBe(false)
            expect(
              await Bun.file(path.join(local, "node_modules", "@mimo-ai", "plugin", "package.json")).exists(),
            ).toBe(false)
          })
        }),
      {
        outsideGit: true,
      },
    ),
  )
}
