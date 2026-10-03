import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Config } from "../../src/config"
import { Provider } from "../../src/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { refreshProviders } from "../../src/provider/refresh"

const id = ProviderID.make("refresh-test")
const modelId = ModelID.make("example")
const config = (key: string, limit = 1000) => ({
  provider: { [id]: { npm: "@ai-sdk/openai-compatible", options: { apiKey: key, baseURL: "http://127.0.0.1:1/v1" },
    models: { [modelId]: { name: "Example", limit: { context: limit, output: 100 } } } } },
  mcp: { unchanged: { type: "remote" as const, url: "http://127.0.0.1:1/mcp", enabled: false } },
})
const view = () => AppRuntime.runPromise(Effect.gen(function* () {
  const provider = yield* Provider.Service
  const model = yield* provider.getModel(id, modelId)
  return { instance: Instance.current, model, provider: yield* provider.getProvider(id),
    language: yield* provider.getLanguage(model), config: yield* Config.Service.use(s => s.get()) }
}))
afterEach(async () => { await Instance.disposeAll() })

// Desktop engine-runtime [TP-R12-01]: model refresh preserves instance and static configuration.
test("refresh changes model and SDK config without disposing the shared directory instance", async () => {
  await using tmp = await tmpdir({ config: config("before") })
  const before = await Instance.provide({ directory: tmp.path, fn: view })
  const disposed: unknown[] = []
  const onEvent = (e: GlobalEvent) => { if (e.payload.type === "server.instance.disposed") disposed.push(e) }
  GlobalBus.on("event", onEvent)
  try {
    await Bun.write(path.join(tmp.path, "mimocode.json"), JSON.stringify({ ...config("after", 2000), mcp: {} }))
    expect(await refreshProviders()).toEqual({ state: "applied" })
    const after = await Instance.provide({ directory: tmp.path, fn: view })
    expect(after.instance).toBe(before.instance)
    expect(after.provider.options.apiKey).toBe("after")
    expect(after.model.limit.context).toBe(2000)
    expect(after.language).not.toBe(before.language)
    expect(after.config.mcp).toEqual(before.config.mcp)
    expect(disposed).toEqual([])
  } finally { GlobalBus.off("event", onEvent) }
})

// Desktop engine-runtime [TP-R12-02]: execution reservations and requests remain authoritative.
test("busy execution defers refresh and update admission holds new requests", async () => {
  await using tmp = await tmpdir({ config: config("before") })
  await Instance.provide({ directory: tmp.path, fn: view })
  const release = Instance.claim(tmp.path)
  expect(await refreshProviders()).toEqual({ state: "pending" })
  release()
  const entered = Promise.withResolvers<void>()
  const unblock = Promise.withResolvers<void>()
  const refresh = Instance.updateIdle(async () => { entered.resolve(); await unblock.promise })
  await entered.promise
  let requested = false
  const request = Instance.provide({ directory: tmp.path, fn: () => { requested = true } })
  await Promise.resolve()
  expect(requested).toBe(false)
  expect(() => Instance.claim(tmp.path)).toThrow("Instance busy")
  unblock.resolve()
  expect(await refresh).toBe(true)
  await request
  expect(requested).toBe(true)
})

// Desktop engine-runtime [TP-R12-03]: all candidates must succeed before any instance publishes.
test("invalid config leaves existing models usable and a later refresh recovers", async () => {
  await using tmp = await tmpdir({ config: config("before") })
  const before = await Instance.provide({ directory: tmp.path, fn: view })
  await Bun.write(path.join(tmp.path, "mimocode.json"), "{ invalid")
  await expect(refreshProviders()).rejects.toThrow()
  const failed = await Instance.provide({ directory: tmp.path, fn: view })
  expect(failed.language).toBe(before.language)
  expect(failed.instance).toBe(before.instance)
  await Bun.write(path.join(tmp.path, "mimocode.json"), JSON.stringify(config("after")))
  expect(await refreshProviders()).toEqual({ state: "applied" })
  expect((await Instance.provide({ directory: tmp.path, fn: view })).provider.options.apiKey).toBe("after")
})

// Desktop engine-runtime [TP-R12-03]: a later candidate failure must not partially update earlier instances.
test("provider refresh commits neither directory when the second candidate is invalid", async () => {
  await using first = await tmpdir({ config: config("first-before") })
  await using second = await tmpdir({ config: config("second-before") })
  const before = await Instance.provide({ directory: first.path, fn: view })
  await Instance.provide({ directory: second.path, fn: view })
  await Bun.write(path.join(first.path, "mimocode.json"), JSON.stringify(config("first-after")))
  await Bun.write(path.join(second.path, "mimocode.json"), "{ invalid")
  await expect(refreshProviders()).rejects.toThrow()
  const retained = await Instance.provide({ directory: first.path, fn: view })
  expect(retained.language).toBe(before.language)
  expect(retained.config.provider?.[id]?.options?.apiKey).toBe("first-before")
  await Bun.write(path.join(second.path, "mimocode.json"), JSON.stringify(config("second-after")))
  expect(await refreshProviders()).toEqual({ state: "applied" })
  expect((await Instance.provide({ directory: first.path, fn: view })).provider.options.apiKey).toBe("first-after")
  expect((await Instance.provide({ directory: second.path, fn: view })).provider.options.apiKey).toBe("second-after")
})

// Desktop engine-runtime [TP-R12-02]: HTTP request occupancy and teardown are separate from execution claims.
test("active requests and pending cleanup both defer provider refresh", async () => {
  const { registerDisposer } = await import("../../src/effect/instance-registry")
  await using tmp = await tmpdir({ config: config("before") })
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const request = Instance.provide({ directory: tmp.path, fn: async () => { entered.resolve(); await finish.promise } })
  try {
    await entered.promise
    expect(await refreshProviders()).toEqual({ state: "pending" })
  } finally { finish.resolve(); await request }
  const closing = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const off = registerDisposer(async (directory) => {
    if (directory === tmp.path) { closing.resolve(); await closed.promise }
  })
  const dispose = Instance.disposeDirectory(tmp.path)
  try {
    await closing.promise
    expect(await refreshProviders()).toEqual({ state: "pending" })
  } finally { closed.resolve(); await dispose; off() }
})

// Desktop engine-runtime [TP-R12-01]: an initialized plugin's model contribution survives even before the Provider is first read.
test("refresh preserves plugin model configuration before first Provider initialization", async () => {
  const { Plugin } = await import("../../src/plugin")
  await using tmp = await tmpdir()
  const plugin = path.join(tmp.path, "example-plugin.mjs")
  await Bun.write(plugin, `export default async () => ({ config(config) {
    config.provider ??= {};
    config.provider["refresh-test"] = { npm: "@ai-sdk/openai-compatible", options: { apiKey: "plugin-key", baseURL: "http://127.0.0.1:1/v1" },
      models: { example: { name: "Plugin model", limit: { context: 2000, output: 100 } } } };
  } });`)
  await Bun.write(path.join(tmp.path, "mimocode.json"), JSON.stringify({ plugin: [plugin] }))
  await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
    const service = yield* Config.Service
    const wait = service.waitForDependencies
    // This local fixture has no package dependencies; keep npm/network outside this regression.
    yield* Effect.acquireUseRelease(
      Effect.sync(() => Object.assign(service, { waitForDependencies: () => Effect.void })),
      () => Plugin.Service.use(s => s.init()),
      () => Effect.sync(() => { Object.assign(service, { waitForDependencies: wait }) }),
    )
  })) })
  expect(await refreshProviders()).toEqual({ state: "applied" })
  const result = await Instance.provide({ directory: tmp.path, fn: view })
  expect(result.provider.options.apiKey).toBe("plugin-key")
  expect(result.model.name).toBe("Plugin model")
})
