import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"

const disableDefault = process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS
process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS = "1"

const { Plugin } = await import("../../src/plugin/index")
const { Instance } = await import("../../src/project/instance")

afterEach(async () => {
  await Instance.disposeAll()
})

afterAll(() => {
  if (disableDefault === undefined) {
    delete process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS
    return
  }
  process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS = disableDefault
})

async function project(source: string) {
  return tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "plugin.ts")
      await Bun.write(file, source)
      await Bun.write(
        path.join(dir, "mimocode.json"),
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(file).href],
          },
          null,
          2,
        ),
      )
    },
  })
}

describe("plugin.trigger", () => {
  test("runs synchronous hooks without crashing", async () => {
    await using tmp = await project(
      [
        "export default async () => ({",
        '  "experimental.chat.system.transform": (_input, output) => {',
        '    output.system.unshift("sync")',
        "  },",
        "})",
        "",
      ].join("\n"),
    )

    const out = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const out = { system: [] as string[] }
          yield* plugin.trigger(
            "experimental.chat.system.transform",
            {
              model: {
                providerID: "anthropic",
                modelID: "claude-sonnet-4-6",
              } as any,
            },
            out,
          )
          return out
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(out.system).toEqual(["sync"])
  })

  test("awaits asynchronous hooks", async () => {
    await using tmp = await project(
      [
        "export default async () => ({",
        '  "experimental.chat.system.transform": async (_input, output) => {',
        "    await Bun.sleep(1)",
        '    output.system.unshift("async")',
        "  },",
        "})",
        "",
      ].join("\n"),
    )

    const out = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const out = { system: [] as string[] }
          yield* plugin.trigger(
            "experimental.chat.system.transform",
            {
              model: {
                providerID: "anthropic",
                modelID: "claude-sonnet-4-6",
              } as any,
            },
            out,
          )
          return out
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(out.system).toEqual(["async"])
  })

  test("skips plugins that return undefined instead of a hook object", async () => {
    await using tmp = await project(["export default async () => {}", ""].join("\n"))

    const out = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const listed = yield* plugin.list()
          const output = { message: { role: "user" } as any, parts: [] as any[] }
          yield* plugin.trigger("chat.message", { sessionID: "ses_test" }, output)
          return { listed, output }
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(out.listed.every((hook) => hook != null && typeof hook === "object")).toBe(true)
    expect(out.output.parts).toEqual([])
  })

  test("chat.message is a no-op when no plugin implements the hook", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), "{}")
      },
    })

    const output = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const output = { message: { role: "user" } as any, parts: [] as any[] }
          return yield* plugin.trigger("chat.message", { sessionID: "ses_test" }, output)
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(output.parts).toEqual([])
  })

  test("still runs valid hooks when another plugin returns undefined", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const empty = path.join(dir, "empty.ts")
        const valid = path.join(dir, "valid.ts")
        await Bun.write(empty, ["export default async () => {}", ""].join("\n"))
        await Bun.write(
          valid,
          [
            "export default async () => ({",
            '  "chat.message": (_input, output) => {',
            '    output.parts.push({ type: "text", text: "ok" })',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(dir, "mimocode.json"),
          JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(empty).href, pathToFileURL(valid).href],
            },
            null,
            2,
          ),
        )
      },
    })

    const output = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const output = { message: { role: "user" } as any, parts: [] as any[] }
          return yield* plugin.trigger("chat.message", { sessionID: "ses_test" }, output)
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(output.parts).toEqual([{ type: "text", text: "ok" }])
  })
})
