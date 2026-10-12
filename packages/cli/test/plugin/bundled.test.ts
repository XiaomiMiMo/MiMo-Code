import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { PluginLoader } from "../../src/plugin/loader"
import { readV1Plugin } from "../../src/plugin/shared"
import { tmpdir } from "../fixture/fixture"

test("loads bundled SDK helpers from a plugin outside the development environment", async () => {
  await using tmp = await tmpdir({ outsideGit: true })
  const build = await Bun.build({
    entrypoints: [path.resolve(import.meta.dirname, "../../../../examples/plugins/greeting/src/server.ts")],
    target: "node",
    format: "esm",
  })
  expect(build.success).toBe(true)
  const file = path.join(tmp.path, "plugin.js")
  await Bun.write(file, build.outputs[0])
  const loaded = await PluginLoader.loadExternal({
    items: [{ spec: pathToFileURL(file).href, scope: "local", source: tmp.path }],
    kind: "server",
  })
  expect(loaded).toHaveLength(1)
  const plugin = readV1Plugin(loaded[0].mod, loaded[0].spec, "server")
  expect(plugin?.id).toBe("example.greeting")
  if (typeof plugin?.server !== "function") throw new Error("Expected a server plugin")
  const hooks = await plugin.server()
  expect(hooks.tool.greet.args.name.parse("Example")).toBe("Example")
  expect(await hooks.tool.greet.execute({ name: "Example" })).toBe("Hello, Example!")
  expect(await Bun.file(path.join(tmp.path, "node_modules", "@mimo-ai", "plugin", "package.json")).exists()).toBe(false)
})

test("explains missing runtime dependencies for file plugins without hiding the module error", async () => {
  await using tmp = await tmpdir({ outsideGit: true })
  const file = path.join(tmp.path, "plugin.js")
  await Bun.write(file, 'import "./missing-runtime.js"\nexport default { id: "example", server: async () => ({}) }\n')
  const errors: unknown[] = []
  const loaded = await PluginLoader.loadExternal({
    items: [{ spec: pathToFileURL(file).href, scope: "local", source: tmp.path }],
    kind: "server",
    report: {
      error(_candidate, _retry, _stage, error) {
        errors.push(error)
      },
    },
  })
  expect(loaded).toHaveLength(0)
  expect(errors).toHaveLength(1)
  expect(String(errors[0])).toContain("missing-runtime.js")
  expect(String(errors[0])).toContain("Bundle your plugin's runtime dependencies")
  expect(String(errors[0])).toContain("examples/plugins/greeting/README.md")
})

test("preserves ordinary plugin errors without dependency migration advice", async () => {
  await using tmp = await tmpdir({ outsideGit: true })
  const file = path.join(tmp.path, "plugin.js")
  await Bun.write(file, 'throw new Error("example initialization failed")\n')
  const errors: unknown[] = []
  await PluginLoader.loadExternal({
    items: [{ spec: pathToFileURL(file).href, scope: "local", source: tmp.path }],
    kind: "server",
    report: {
      error(_candidate, _retry, _stage, error) {
        errors.push(error)
      },
    },
  })
  expect(errors).toHaveLength(1)
  expect(String(errors[0])).toBe("Error: example initialization failed")
})
