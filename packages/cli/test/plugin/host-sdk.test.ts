import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"

const disableDefault = process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS
process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS = "1"

const { Plugin } = await import("../../src/plugin/index")
const { Instance } = await import("../../src/project/instance")
const { PluginHost } = await import("../../src/plugin/host")

afterAll(() => {
  if (disableDefault === undefined) delete process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS
  else process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS = disableDefault
})

afterEach(async () => {
  await Instance.disposeAll()
})

const ENV = ["MIMOCODE_ONLY_CONFIG_DIR_PLUGINS", "MIMOCODE_CONFIG_DIR"] as const

async function withEnv<T>(env: Partial<Record<(typeof ENV)[number], string>>, fn: () => Promise<T>) {
  const prev = Object.fromEntries(ENV.map((key) => [key, process.env[key]]))
  for (const key of ENV) {
    const value = env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const key of ENV) {
      const value = prev[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function load(dir: string) {
  return Instance.provide({
    directory: dir,
    fn: async () =>
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const hooks = yield* plugin.list()
        const out = { system: [] as string[] }
        yield* plugin.trigger(
          "experimental.chat.system.transform",
          { model: { providerID: "test", modelID: "test/model" } } as never,
          out,
        )
        return { tools: hooks.flatMap((hook) => Object.keys(hook.tool ?? {})), system: out.system }
      }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
  })
}

function toolPlugin(name: string) {
  return [
    'import { tool } from "@mimo-ai/plugin"',
    "export default async () => ({",
    `  tool: { ${name}: tool({ description: "example", args: { value: tool.schema.string() }, execute: async () => "ok" }) },`,
    "})",
    "",
  ].join("\n")
}

describe("plugin host SDK", () => {
  test("serves @mimo-ai/plugin to a plugin directory without node_modules", async () => {
    await using tmp = await tmpdir({
      outsideGit: true,
      init: (dir) => Bun.write(path.join(dir, ".mimocode", "plugins", "example.ts"), toolPlugin("example_tool")),
    })

    const result = await withEnv({}, () => load(tmp.path))
    expect(result.tools).toContain("example_tool")
    expect(await Bun.file(path.join(tmp.path, ".mimocode", "node_modules")).exists()).toBe(false)
  })

  test("serves the @mimo-ai/plugin/tool subpath", async () => {
    await using tmp = await tmpdir({
      outsideGit: true,
      init: (dir) =>
        Bun.write(
          path.join(dir, ".mimocode", "plugins", "example.ts"),
          toolPlugin("subpath_tool").replace('"@mimo-ai/plugin"', '"@mimo-ai/plugin/tool"'),
        ),
    })

    const result = await withEnv({}, () => load(tmp.path))
    expect(result.tools).toContain("subpath_tool")
  })

  test("prefers the host SDK over a plugin-local node_modules copy", async () => {
    await using tmp = await tmpdir({
      outsideGit: true,
      init: async (dir) => {
        const fake = path.join(dir, ".mimocode", "node_modules", "@mimo-ai", "plugin")
        await Bun.write(
          path.join(fake, "package.json"),
          JSON.stringify({ name: "@mimo-ai/plugin", type: "module", exports: { ".": "./index.js" } }),
        )
        await Bun.write(path.join(fake, "index.js"), 'export const tool = "fake"\n')
        await Bun.write(path.join(dir, ".mimocode", "plugins", "example.ts"), toolPlugin("example_tool"))
      },
    })

    const result = await withEnv({}, () => load(tmp.path))
    expect(result.tools).toContain("example_tool")
  })

  test("serves @mimo-ai/plugin to file hooks", async () => {
    await using tmp = await tmpdir({
      outsideGit: true,
      init: (dir) =>
        Bun.write(
          path.join(dir, ".mimocode", "hooks", "example.ts"),
          [
            'import { tool } from "@mimo-ai/plugin"',
            "export default {",
            '  "experimental.chat.system.transform": async (_input, output) => {',
            "    output.system.push(`hook:${typeof tool.schema.string}`)",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
    })

    const result = await withEnv({}, () => load(tmp.path))
    expect(result.system).toContain("hook:function")
  })
})

describe("config-dir-only plugin policy", () => {
  async function setup() {
    return tmpdir({
      outsideGit: true,
      init: async (dir) => {
        const host = path.join(dir, "host-config")
        const project = path.join(dir, "project")
        const hostPlugin = path.join(host, "host-plugin.ts")
        await Bun.write(hostPlugin, toolPlugin("host_tool"))
        await Bun.write(
          path.join(host, "mimocode.json"),
          JSON.stringify({ plugin: [pathToFileURL(hostPlugin).href] }),
        )
        await Bun.write(path.join(project, ".mimocode", "plugins", "project.ts"), toolPlugin("project_tool"))
        await Bun.write(
          path.join(project, ".mimocode", "hooks", "project.ts"),
          'export default { "experimental.chat.system.transform": async (_i, o) => { o.system.push("project-hook") } }\n',
        )
        await fs.mkdir(path.join(host, "hooks"), { recursive: true })
        await Bun.write(
          path.join(host, "hooks", "host.ts"),
          'export default { "experimental.chat.system.transform": async (_i, o) => { o.system.push("host-hook") } }\n',
        )
        return { host, project }
      },
    })
  }

  test("loads everything when the policy is off", async () => {
    await using tmp = await setup()
    const result = await withEnv({ MIMOCODE_CONFIG_DIR: tmp.extra.host }, () => load(tmp.extra.project))
    expect(result.tools).toEqual(expect.arrayContaining(["host_tool", "project_tool"]))
    expect(result.system).toEqual(expect.arrayContaining(["host-hook", "project-hook"]))
  })

  test("loads only MIMOCODE_CONFIG_DIR plugins and hooks when the policy is on", async () => {
    await using tmp = await setup()
    const result = await withEnv(
      { MIMOCODE_ONLY_CONFIG_DIR_PLUGINS: "1", MIMOCODE_CONFIG_DIR: tmp.extra.host },
      () => load(tmp.extra.project),
    )
    expect(result.tools).toContain("host_tool")
    expect(result.tools).not.toContain("project_tool")
    expect(result.system).toContain("host-hook")
    expect(result.system).not.toContain("project-hook")
  })

  test("loads no external plugins when the policy is on without MIMOCODE_CONFIG_DIR", async () => {
    await using tmp = await setup()
    const result = await withEnv({ MIMOCODE_ONLY_CONFIG_DIR_PLUGINS: "1" }, () => load(tmp.extra.project))
    expect(result.tools).not.toContain("project_tool")
    expect(result.system).not.toContain("project-hook")
  })
})

describe("PluginHost.filterOrigins", () => {
  test("keeps only path sources inside MIMOCODE_CONFIG_DIR, resolving symlinks", async () => {
    await using tmp = await tmpdir({
      outsideGit: true,
      init: async (dir) => {
        const host = path.join(dir, "host-config")
        await fs.mkdir(host, { recursive: true })
        await fs.mkdir(path.join(dir, "host-config-other"), { recursive: true })
        await fs.symlink(host, path.join(dir, "host-link"))
        return { host }
      },
    })
    const origin = (source: string) => ({ spec: "file:///tmp/example/plugin.ts", source, scope: "local" as const })
    const inside = origin(path.join(tmp.extra.host, "mimocode.json"))
    const kept = await withEnv(
      { MIMOCODE_ONLY_CONFIG_DIR_PLUGINS: "1", MIMOCODE_CONFIG_DIR: path.join(tmp.path, "host-link") },
      async () =>
        PluginHost.filterOrigins([
          inside,
          origin(tmp.extra.host),
          origin(path.join(tmp.path, "host-config-other", "mimocode.json")),
          origin(path.join(tmp.path, "project", ".mimocode")),
          origin("MIMOCODE_CONFIG_CONTENT"),
          origin("https://example.com/api/config"),
        ]),
    )
    expect(kept).toEqual([inside, origin(tmp.extra.host)])
  })
})
