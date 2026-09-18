import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test"
import * as compatible from "@ai-sdk/openai-compatible"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Effect, Layer } from "effect"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Auth } from "../../src/auth"
import { SDKBindingCache } from "../../src/provider/sdk-binding"
import { Config } from "../../src/config"
import { Env } from "../../src/env"
import { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

const it = testEffect(
  Layer.mergeAll(Provider.defaultLayer, Env.defaultLayer, Config.defaultLayer, CrossSpawnSpawner.defaultLayer),
)
const original = compatible.createOpenAICompatible
let constructor: ReturnType<typeof spyOn<typeof compatible, "createOpenAICompatible">>

beforeEach(() => {
  constructor = spyOn(compatible, "createOpenAICompatible").mockImplementation(original)
})
afterEach(() => constructor.mockRestore())

function config(baseURL: string, options: Record<string, unknown> = {}): Config.Info {
  return {
    enabled_providers: ["binding-test"],
    provider: {
      "binding-test": {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL, apiKey: "test-key", ...options },
        models: {
          first: { limit: { context: 8192, output: 1024 } },
          second: { limit: { context: 8192, output: 1024 } },
        },
      },
    },
  }
}

const language = (id = "first") =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderID.make("binding-test"), ModelID.make(id))
    return { model, language: yield* provider.getLanguage(model) }
  })

function http() {
  const requests: { authorization: string | null; tenant: string | null; path: string; model: string }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body: unknown = await request.json()
      if (typeof body !== "object" || body === null || !("model" in body) || typeof body.model !== "string") {
        return Response.json({ error: "invalid model" }, { status: 400 })
      }
      requests.push({
        authorization: request.headers.get("authorization"),
        tenant: request.headers.get("x-tenant"),
        path: new URL(request.url).pathname + new URL(request.url).search,
        model: body.model,
      })
      return Response.json({
        id: "test-response",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "local fixture" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
  })
  return {
    url: server.url.href + "v1",
    requests,
    [Symbol.dispose]: () => server.stop(true),
  }
}

async function generate(model: LanguageModelV3) {
  const response = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] })
  expect(response.content).toContainEqual({ type: "text", text: "local fixture" })
}

// engine-runtime: [TP-R12-10]
describe("Provider SDK bindings", () => {
  // [TP-R12-10]
  it.live("keeps binding identities and single-flight behavior on Node", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const entry = fileURLToPath(new URL("../../src/provider/sdk-binding.ts", import.meta.url))
      const output = path.join(dir, "sdk-binding.mjs")
      const build = spawnSync(process.execPath, ["build", entry, "--target=node", "--outfile", output], {
        encoding: "utf8",
      })
      expect(build.status, build.stderr).toBe(0)
      const run = spawnSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `
        import assert from "node:assert/strict"
        import { SDKBindingCache } from ${JSON.stringify(pathToFileURL(output).href)}
        const cache = new SDKBindingCache()
        const local = Symbol("local")
        assert.equal(cache.key({ local }), cache.key({ local }))
        assert.notEqual(cache.key({ local }), cache.key({ local: Symbol("local") }))
        assert.equal(cache.key(Symbol.for("registry")), cache.key(Symbol.for("registry")))
        assert.notEqual(cache.key({ Authorization: "a", authorization: "b" }), cache.key({ authorization: "b", Authorization: "a" }))
        const languageModel = () => ({})
        const first = { languageModel }
        const second = { languageModel }
        assert.notEqual(cache.reference(first), cache.reference(second))
        assert.equal(cache.reference(first), cache.reference(first))
        let getterCalls = 0
        const getter = Object.defineProperty({}, "secret", { get() { getterCalls++; return "not-read" } })
        cache.key(getter)
        assert.equal(getterCalls, 0)
        let calls = 0
        const create = () => { calls++; return first }
        const key = cache.key({ local })
        const values = await Promise.all([cache.get(key, create), cache.get(key, create)])
        assert.equal(calls, 1)
        assert.equal(values[0], values[1])
        console.log("node-sdk-binding-ok")
      `,
        ],
        { encoding: "utf8" },
      )
      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout).toContain("node-sdk-binding-ok")
    }),
  )

  // [TP-R12-01] [TP-R12-03] Count real constructors AND exercise the returned models over local HTTP.
  it.live(
    "reuses a binding across directories, not mutable model projections, and survives one Instance disposal",
    () =>
      Effect.gen(function* () {
        using server = http()
        const first = yield* provideTmpdirInstance(() => language(), { config: config(server.url) }).pipe(Effect.scoped)
        const second = yield* provideTmpdirInstance(() => language(), { config: config(server.url) })
        expect(constructor).toHaveBeenCalledTimes(1)
        expect(first.model).not.toBe(second.model)
        expect(first.model.limit).not.toBe(second.model.limit)
        expect(first.language).not.toBe(second.language)
        first.model.limit.context = 17
        expect(second.model.limit.context).toBe(8192)
        yield* Effect.promise(() => generate(first.language))
        yield* Effect.promise(() => generate(second.language))
        expect(server.requests.map((request) => request.authorization)).toEqual(["Bearer test-key", "Bearer test-key"])
      }),
  )

  // [TP-R12-01] Identical concurrent input must not construct twice after the dynamic import await.
  it.live("coalesces concurrent binding construction across models and directories", () =>
    Effect.gen(function* () {
      using server = http()
      const results = yield* Effect.all(
        ["first", "second"].map((id) => provideTmpdirInstance(() => language(id), { config: config(server.url) })),
        { concurrency: "unbounded" },
      )
      expect(constructor).toHaveBeenCalledTimes(1)
      yield* Effect.promise(() => Promise.all(results.map((result) => generate(result.language))))
      expect(server.requests.map((request) => request.model).sort()).toEqual(["first", "second"])
    }),
  )

  // [TP-R12-02] Credentials, headers and substituted endpoint environment are effective constructor inputs.
  it.live("does not merge different API keys, headers or effective env", () =>
    Effect.gen(function* () {
      using server = http()
      const a = yield* provideTmpdirInstance(() => language(), { config: config(server.url) })
      const b = yield* provideTmpdirInstance(() => language(), { config: config(server.url, { apiKey: "other-key" }) })
      const c = yield* provideTmpdirInstance(() => language(), {
        config: config(server.url, { headers: { "x-tenant": "other-tenant" } }),
      })
      const d = yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const env = yield* Env.Service
            yield* env.set("BINDING_TEST_ENDPOINT", server.url + "/env")
            return yield* language()
          }),
        { config: config("${BINDING_TEST_ENDPOINT}") },
      )
      expect(constructor).toHaveBeenCalledTimes(4)
      yield* Effect.promise(() => Promise.all([a, b, c, d].map((result) => generate(result.language))))
      expect(server.requests).toContainEqual({
        authorization: "Bearer other-key",
        tenant: null,
        path: "/v1/chat/completions",
        model: "first",
      })
      expect(server.requests).toContainEqual({
        authorization: "Bearer test-key",
        tenant: "other-tenant",
        path: "/v1/chat/completions",
        model: "first",
      })
      expect(server.requests.some((request) => request.path === "/v1/env/chat/completions")).toBe(true)
    }),
  )

  // [TP-R12-02] [TP-R12-10] Header enumeration order is observable after case folding.
  it.live("preserves case-duplicate header order across Instances without an API key", () =>
    Effect.gen(function* () {
      using server = http()
      const headers = [
        { Authorization: "upper-token", authorization: "lower-token" },
        { authorization: "lower-token", Authorization: "upper-token" },
      ]
      for (const entry of headers) {
        yield* Effect.promise(() =>
          generate(original({ name: "binding-test", baseURL: server.url, headers: entry }).languageModel("first")),
        )
      }
      // Establish the uncached SDK/HTTP behavior independently of Provider's cache.
      expect(server.requests.map((request) => request.authorization)).toEqual(["lower-token", "upper-token"])
      for (const entry of headers) {
        const result = yield* provideTmpdirInstance(() => language(), {
          config: config(server.url, { apiKey: undefined, headers: entry }),
        })
        yield* Effect.promise(() => generate(result.language))
      }
      expect(server.requests.map((request) => request.authorization)).toEqual([
        "lower-token",
        "upper-token",
        "lower-token",
        "upper-token",
      ])
      expect(constructor).toHaveBeenCalledTimes(2)
    }),
  )

  // [TP-R12-02] [TP-R12-10] SDK instances need reference identity even when their methods are shared.
  it.live("uses the new plain-object SDK after model headers change", () =>
    Effect.gen(function* () {
      using server = http()
      const cfg = config(server.url, { fixturePlainSDK: true })
      cfg.provider!["binding-test"].npm = new URL("./sdk-binding-fixture.ts", import.meta.url).href
      const pair = yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(ProviderID.make("binding-test"), ModelID.make("first"))
            model.headers = { "x-tenant": "first-binding" }
            const first = yield* provider.getLanguage(model)
            model.headers = { "x-tenant": "second-binding" }
            const second = yield* provider.getLanguage(model)
            return { first, second, repeated: yield* provider.getLanguage(model) }
          }),
        { config: cfg },
      )
      yield* Effect.promise(() => generate(pair.first))
      yield* Effect.promise(() => generate(pair.second))
      expect(server.requests.map((request) => request.tenant)).toEqual(["first-binding", "second-binding"])
      expect(pair.first).not.toBe(pair.second)
      expect(pair.repeated).toBe(pair.second)
      expect(constructor).toHaveBeenCalledTimes(2)
    }),
  )

  // [TP-R12-01] [TP-R12-10] Symbol-valued opaque options must retain identity on repeat/concurrent lookup.
  it.live("reuses Symbol-valued inputs for repeated and concurrent binding requests", () =>
    Effect.gen(function* () {
      using server = http()
      const local = Symbol("binding-token")
      const registered = Symbol.for("binding-token")
      const values = [local, registered, Symbol.iterator]
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const info = yield* provider.getProvider(ProviderID.make("binding-test"))
            for (const [index, symbol] of values.entries()) {
              info.options.bindingToken = symbol
              const pair = yield* Effect.all([language(), language("second")], { concurrency: "unbounded" })
              expect(constructor).toHaveBeenCalledTimes(index + 1)
              const repeated = yield* language()
              expect(repeated.language).toBe(pair[0].language)
              yield* Effect.promise(() => Promise.all(pair.map((result) => generate(result.language))))
            }
            info.options.bindingToken = Symbol("binding-token")
            yield* language()
            expect(constructor).toHaveBeenCalledTimes(4)
          }),
        { config: config(server.url) },
      )
      const cache = new SDKBindingCache()
      for (const symbol of values) {
        expect(cache.key({ symbol })).toBe(cache.key({ symbol }))
      }
      expect(cache.key({ symbol: local })).not.toBe(cache.key({ symbol: Symbol("binding-token") }))
      expect(cache.key({ symbol: local })).not.toBe(cache.key({ symbol: registered }))
      expect(cache.key({ symbol: registered })).toBe(cache.key({ symbol: Symbol.for("binding-token") }))
      expect(server.requests).toHaveLength(6)
    }),
  )

  // [TP-R12-02] Effective Env is part of binding identity even when the endpoint is explicit.
  it.live("separates effective environment snapshots and resolves env credentials", () =>
    Effect.gen(function* () {
      using server = http()
      const cfg = config(server.url)
      cfg.provider!["binding-test"].env = ["BINDING_TEST_API_KEY"]
      delete cfg.provider!["binding-test"].options!.apiKey
      const results = yield* Effect.all(
        ["env-key-a", "env-key-b"].map((key) =>
          provideTmpdirInstance(
            () =>
              Effect.gen(function* () {
                const env = yield* Env.Service
                yield* env.set("BINDING_TEST_API_KEY", key)
                return yield* language()
              }),
            { config: cfg },
          ),
        ),
        { concurrency: "unbounded" },
      )
      expect(constructor).toHaveBeenCalledTimes(2)
      yield* Effect.promise(() => Promise.all(results.map((result) => generate(result.language))))
      expect(
        server.requests.map((request) => request.authorization).sort((a, b) => (a ?? "").localeCompare(b ?? "")),
      ).toEqual(["Bearer env-key-a", "Bearer env-key-b"])
      // Same explicit credentials/options, different remaining effective env.
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const env = yield* Env.Service
            yield* env.set("BINDING_TEST_SCOPE", "a")
            yield* language()
            yield* env.set("BINDING_TEST_SCOPE", "b")
            yield* language()
          }),
        { config: config(server.url) },
      )
      expect(constructor).toHaveBeenCalledTimes(4)
    }),
  )

  // [TP-R12-02] JSON.stringify drops fetch functions, including two closures inside ONE Instance.
  it.live("keeps customFetch identities distinct inside one Instance and across Instances", () =>
    Effect.gen(function* () {
      using server = http()
      const seen: string[] = []
      const customFetch = (owner: string) => async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(owner)
        return fetch(input, init)
      }
      const pair = yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const info = yield* provider.getProvider(ProviderID.make("binding-test"))
            info.options.fetch = customFetch("first")
            const first = yield* language()
            info.options.fetch = customFetch("second")
            const second = yield* language("second")
            return [first, second]
          }),
        { config: config(server.url) },
      )
      const third = yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const info = yield* provider.getProvider(ProviderID.make("binding-test"))
            info.options.fetch = customFetch("third")
            return yield* language()
          }),
        { config: config(server.url) },
      )
      yield* Effect.promise(async () => {
        for (const result of [...pair, third]) await generate(result.language)
      })
      expect(seen).toEqual(["first", "second", "third"])
      expect(constructor).toHaveBeenCalledTimes(3)
    }),
  )

  // [TP-R12-03] Failed construction must not poison the shared binding for a later request.
  it.live("retries failed initialization", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          using server = http()
          const provider = yield* Provider.Service
          const info = yield* provider.getProvider(ProviderID.make("binding-test"))
          info.options.baseURL = server.url
          constructor.mockImplementationOnce(() => {
            throw new Error("fixture init failed")
          })
          const failure = yield* Effect.exit(language())
          expect(failure._tag).toBe("Failure")
          const result = yield* language()
          expect(constructor).toHaveBeenCalledTimes(2)
          yield* Effect.promise(() => generate(result.language))
        }),
      { config: config("http://127.0.0.1:1/v1") },
    ),
  )

  // [TP-R12-02] The same factory import/options can still depend on the real project context.
  it.live("keeps third-party factory context isolated and preserves construction coalescing inside an Instance", () =>
    Effect.gen(function* () {
      using server = http()
      const cfg = config(server.url)
      cfg.provider!["binding-test"].npm = new URL("./sdk-binding-fixture.ts", import.meta.url).href
      const pair = yield* Effect.all(
        [0, 1].map(() =>
          provideTmpdirInstance(
            (directory) =>
              Effect.gen(function* () {
                const provider = yield* Provider.Service
                yield* provider.list()
                const models = yield* Effect.all([language(), language("second")], { concurrency: "unbounded" })
                return { directory, models }
              }),
            { config: cfg },
          ),
        ),
        { concurrency: "unbounded" },
      )
      expect(constructor).toHaveBeenCalledTimes(2)
      yield* Effect.promise(() =>
        Promise.all(pair.flatMap((entry) => entry.models.map((model) => generate(model.language)))),
      )
      for (const entry of pair)
        expect(server.requests.filter((request) => request.tenant === entry.directory)).toHaveLength(2)
    }),
  )

  // [TP-R12-02] Auth loader output is not a substitute for Plugin Host identity.
  it.live("does not share plugin auth bindings even when a loader returns identical plain data", () =>
    Effect.gen(function* () {
      using server = http()
      Auth.inject(JSON.stringify({ "binding-test": { type: "api", key: "test-key" } }))
      yield* Effect.addFinalizer(() => Effect.sync(() => Auth.inject(undefined)))
      const cfg = config(server.url)
      cfg.plugin = [new URL("./sdk-binding-fixture.ts", import.meta.url).href]
      const first = yield* provideTmpdirInstance(() => language(), { config: cfg })
      const second = yield* provideTmpdirInstance(() => language(), { config: cfg })
      expect(constructor).toHaveBeenCalledTimes(2)
      yield* Effect.promise(() => Promise.all([generate(first.language), generate(second.language)]))
      expect(server.requests.map((request) => request.authorization)).toEqual(["Bearer test-key", "Bearer test-key"])
    }),
  )

  // [TP-R12-02] Non-serializable objects must not share via an empty JSON representation.
  it.live("distinguishes opaque object identities and keeps shared nested options independent", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          using server = http()
          const provider = yield* Provider.Service
          const info = yield* provider.getProvider(ProviderID.make("binding-test"))
          info.options.baseURL = server.url
          info.options.queryParams = { tenant: "first" }
          const first = yield* language()
          info.options.queryParams.tenant = "second"
          const second = yield* language()
          const metadata = (tenant: string) =>
            new (class {
              async extractMetadata() {
                return { "binding-test": { tenant } }
              }
              createStreamExtractor() {
                return { processChunk() {}, buildMetadata: () => ({ "binding-test": { tenant } }) }
              }
            })()
          info.options.metadataExtractor = metadata("opaque-first")
          const third = yield* language()
          info.options.metadataExtractor = metadata("opaque-second")
          const fourth = yield* language()
          expect(constructor).toHaveBeenCalledTimes(4)
          yield* Effect.promise(async () => {
            await generate(first.language)
            await generate(second.language)
            const call = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "test" }] }] }
            expect((await third.language.doGenerate(call)).providerMetadata?.["binding-test"]).toEqual({
              tenant: "opaque-first",
            })
            expect((await fourth.language.doGenerate(call)).providerMetadata?.["binding-test"]).toEqual({
              tenant: "opaque-second",
            })
          })
          expect(server.requests[0].path).toContain("tenant=first")
          expect(server.requests[1].path).toContain("tenant=second")
        }),
      { config: config("http://127.0.0.1:1/v1") },
    ),
  )

  // [TP-R12-03] Eviction drops only cached references, not live models/SDKs.
  it.live("bounds the shared cache and leaves evicted models usable", () =>
    Effect.gen(function* () {
      using server = http()
      const first = yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const info = yield* provider.getProvider(ProviderID.make("binding-test"))
            const first = yield* language()
            for (let i = 0; i < 128; i++) {
              info.options.apiKey = `test-key-${i}`
              yield* language()
            }
            return first
          }),
        { config: config(server.url) },
      )
      const next = yield* provideTmpdirInstance(() => language(), { config: config(server.url) })
      expect(constructor).toHaveBeenCalledTimes(130)
      yield* Effect.promise(() => generate(first.language))
      yield* Effect.promise(() => generate(next.language))
      expect(server.requests.map((request) => request.authorization)).toEqual(["Bearer test-key", "Bearer test-key"])
    }),
  )

  // [TP-R12-03] Exercise the production cache with a delayed real constructor:
  // waiters share the same failure, then the next request can build successfully.
  it.live("single-flights pending failure and retry, with constructor identity in the key", () =>
    Effect.promise(async () => {
      using server = http()
      const cache = new SDKBindingCache()
      const gate = Promise.withResolvers<void>()
      let attempts = 0
      const create = async () => {
        attempts++
        await gate.promise
        throw new Error("fixture pending failure")
      }
      const input = { name: "binding-test", baseURL: server.url, apiKey: "test-key" }
      const key = cache.key({ factory: original, options: input })
      const first = cache.get(key, create)
      const second = cache.get(key, create)
      gate.resolve()
      expect((await Promise.allSettled([first, second])).map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
      ])
      expect(attempts).toBe(1)
      const sdk = await cache.get(key, () => original(input))
      expect(
        await cache.get(key, () => {
          throw new Error("must reuse")
        }),
      ).toBe(sdk)
      expect(cache.key({ factory: (options: typeof input) => original(options), options: input })).not.toBe(key)
      expect(key).not.toContain("test-key")
      await generate(sdk.languageModel("first"))
    }),
  )

  // [TP-R12-03] Capacity pressure must never evict an in-flight binding and start it twice.
  it.live("bounds pending initialization without losing coalescing under capacity pressure", () =>
    Effect.promise(async () => {
      using server = http()
      const cache = new SDKBindingCache()
      const gate = Promise.withResolvers<void>()
      let attempts = 0
      const pending = Array.from({ length: 128 }, (_, i) =>
        cache.get(String(i), async () => {
          attempts++
          await gate.promise
          return original({ name: "binding-test", baseURL: server.url, apiKey: `test-${i}` })
        }),
      )
      const overflow = cache.get("overflow", async () => {
        attempts++
        return original({ name: "binding-test", baseURL: server.url })
      })
      const duplicate = cache.get("0", () => {
        throw new Error("in-flight binding was evicted")
      })
      await Promise.resolve()
      expect(attempts).toBe(128)
      gate.resolve()
      const results = await Promise.all(pending)
      expect(await duplicate).toBe(results[0])
      await overflow
      expect(attempts).toBe(129)
      await generate(results[0].languageModel("first"))
    }),
  )

  // [TP-R12-02] Refresh must compare new resolved inputs, not reuse the prior directory's SDK.
  it.live("uses new config inputs after explicit config invalidation", () =>
    Effect.gen(function* () {
      using server = http()
      const directory = yield* tmpdirScoped({ config: config(server.url) })
      const before = yield* language().pipe(provideInstance(directory))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(directory, "mimocode.json"),
          JSON.stringify(config(server.url, { apiKey: "refreshed-key" })),
        ),
      )
      const cfg = yield* Config.Service
      yield* cfg.invalidate(true)
      const after = yield* language().pipe(provideInstance(directory))
      expect(constructor).toHaveBeenCalledTimes(2)
      yield* Effect.promise(() => generate(before.language))
      yield* Effect.promise(() => generate(after.language))
      expect(server.requests.map((request) => request.authorization)).toEqual([
        "Bearer test-key",
        "Bearer refreshed-key",
      ])
      yield* cfg.invalidate(true)
    }),
  )
})
