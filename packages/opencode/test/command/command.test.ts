import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { Effect, Layer, Option } from "effect"
import path from "path"
import fs from "fs/promises"
import { Command } from "@/command"
import { Config } from "@/config"
import { MCP } from "@/mcp"
import { Skill } from "@/skill"
import { Instance } from "@/project/instance"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Env } from "@/env"
import { Npm } from "@/npm"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { EffectFlock } from "@mimo-ai/shared/util/effect-flock"
import { tmpdir } from "../fixture/fixture"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { Filesystem } from "@/util"
import { Global } from "@/global"

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const emptyAccount = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
  activeOrg: () => Effect.succeed(Option.none()),
})
const emptyAuth = Layer.mock(Auth.Service)({ all: () => Effect.succeed({}) })

const layer = Command.defaultLayer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(emptyAuth),
  Layer.provide(emptyAccount),
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(Npm.defaultLayer),
  Layer.provideMerge(infra),
)

async function writePluginCommand(pluginName: string, cmdName: string, content: string) {
  const dir = path.join(Global.Path.data, "plugins", pluginName, "commands")
  await Filesystem.write(path.join(dir, `${cmdName}.md`), content)
}

describe("marketplace plugin commands", () => {
  beforeEach(async () => {
    await fs.rm(path.join(Global.Path.data, "plugins"), { recursive: true, force: true }).catch(() => {})
  })
  afterEach(async () => {
    await fs.rm(path.join(Global.Path.data, "plugins"), { recursive: true, force: true }).catch(() => {})
  })

  test("loads markdown commands from marketplace plugin", async () => {
    await writePluginCommand("my-plugin", "code-review", `---
description: Code review a pull request
---
Provide a code review for the given pull request.`)

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.gen(function* () {
          const cmd = yield* Command.Service
          const list = yield* cmd.list()
          const cr = list.find((c) => c.name === "code-review")
          expect(cr).toBeDefined()
          expect(cr?.description).toBe("Code review a pull request")
          expect(cr?.source).toBe("command")
        }).pipe(Effect.provide(layer), Effect.runPromise)
      },
    })
  })

  test(".mimocode command takes priority over marketplace command", async () => {
    await writePluginCommand("my-plugin", "shared", `---
description: marketplace version
---
from marketplace`)

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, ".mimocode", "commands", "shared.md"),
          `---
description: mimocode version
---
from mimocode`,
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.gen(function* () {
          const cmd = yield* Command.Service
          const c = yield* cmd.get("shared")
          expect(c?.description).toBe("mimocode version")
        }).pipe(Effect.provide(layer), Effect.runPromise)
      },
    })
  })

  // 兜底：单个插件的畸形 command 文件（frontmatter 合法但字段类型非法）
  // 不应打挂整个 command 服务——与 skill 的 safeParse+return 策略一致。
  test("malformed command file does not crash command service", async () => {
    // subtask 应是 boolean，写字符串触发 schema 失败
    await writePluginCommand("bad-plugin", "broken", `---
description: broken
subtask: "yes"
---
should be skipped`)
    // 同插件目录放一个好文件，验证它仍能加载
    await writePluginCommand("bad-plugin", "good", `---
description: good one
---
this works`)

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.gen(function* () {
          const cmd = yield* Command.Service
          const list = yield* cmd.list()
          // 坏文件被跳过
          expect(list.find((c) => c.name === "broken")).toBeUndefined()
          // 好文件正常加载
          const good = list.find((c) => c.name === "good")
          expect(good?.description).toBe("good one")
          // 内置 command 仍可用（未被打挂）
          expect(list.find((c) => c.name === "init")).toBeDefined()
        }).pipe(Effect.provide(layer), Effect.runPromise)
      },
    })
  })
})
