import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { Effect, Layer, Option } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Global } from "@mimo-ai/shared/global"
import { EffectFlock } from "@mimo-ai/shared/util/effect-flock"
import { Npm } from "../src/npm"
import { tmpdir } from "./fixture/fixture"

function npmLayer(root: string, cache: string) {
  const global = Layer.succeed(
    Global.Service,
    Global.Service.of({
      home: root,
      data: path.join(root, "data"),
      cache,
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      bin: path.join(cache, "bin"),
      log: path.join(root, "log"),
    }),
  )
  return Npm.layer.pipe(
    Layer.provide(EffectFlock.layer),
    Layer.provide(AppFileSystem.layer),
    Layer.provide(global),
    Layer.provide(NodeFileSystem.layer),
  )
}

describe("Npm.add", () => {
  // Arborist returns an empty tree (no edges, no children) when its root path runs
  // through a symlink, even though it installed the package. Plugin installs then
  // reported NpmInstallFailedError whenever the cache lived under a symlinked
  // directory (a symlinked ~/.cache, or /tmp on macOS).
  test("installs into a cache directory reached through a symlink", async () => {
    await using tmp = await tmpdir()
    const pkg = path.join(tmp.path, "example-plugin")
    await fs.mkdir(pkg)
    await fs.writeFile(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "example-plugin", version: "1.0.0", main: "index.js" }),
    )
    await fs.writeFile(path.join(pkg, "index.js"), "module.exports = 1\n")
    await fs.mkdir(path.join(tmp.path, "real"))
    await fs.symlink(
      path.join(tmp.path, "real"),
      path.join(tmp.path, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    )

    const entry = await Effect.runPromise(
      Npm.Service.use((svc) => svc.add(`file:${pkg}`)).pipe(
        Effect.provide(npmLayer(tmp.path, path.join(tmp.path, "linked", "cache"))),
      ),
    )

    const entrypoint = Option.getOrThrow(entry.entrypoint)
    const file = entrypoint.startsWith("file://") ? fileURLToPath(entrypoint) : entrypoint
    expect(await fs.realpath(file)).toBe(await fs.realpath(path.join(pkg, "index.js")))
    expect(await fs.realpath(entry.directory)).toBe(await fs.realpath(pkg))
  })
})
