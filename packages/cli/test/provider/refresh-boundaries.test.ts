// Regression boundaries for docs/compose/spec/provider-local-refresh.md (S2–S5).
import { test, expect, afterEach } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Auth } from "../../src/auth"

const call = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }] }
const completion = () =>
  Response.json({
    id: "resp_example",
    object: "response",
    status: "completed",
    created_at: 1,
    model: "example",
    output: [
      {
        type: "message",
        id: "msg_example",
        role: "assistant",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
        status: "completed",
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  })
afterEach(async () => {
  Auth.inject(undefined)
  await Instance.disposeAll()
})

test("real xAI Provider can make a second request after its own OAuth renewal", async () => {
  await using tmp = await tmpdir({
    config: {
      enabled_providers: ["xai"],
      provider: { xai: { npm: "@ai-sdk/xai", models: { example: { limit: { context: 1000, output: 100 } } } } },
    },
  })
  await AppRuntime.runPromise(
    Auth.Service.use((s) =>
      s.set("xai", { type: "oauth", access: "example-before", refresh: "example-refresh-before", expires: 1 }),
    ),
  )
  const language = await Instance.provide({
    directory: tmp.path,
    fn: () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          return yield* provider.getLanguage(yield* provider.getModel(ProviderID.make("xai"), ModelID.make("example")))
        }),
      ),
  })
  const original = globalThis.fetch
  let tokens = 0
  let calls = 0
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes("token")) {
        tokens++
        return Response.json({
          access_token: "example-after",
          refresh_token: "example-refresh-after",
          expires_in: 3600,
        })
      }
      calls++
      return completion()
    },
    { preconnect: original.preconnect },
  ) as typeof fetch
  try {
    await language.doGenerate(call)
    const renewed = await AppRuntime.runPromise(Auth.Service.use((s) => s.get("xai")))
    await language.doGenerate(call)
    expect(tokens).toBe(1)
    expect(renewed).toMatchObject({ type: "oauth", access: "example-after", refresh: "example-refresh-after" })
    expect(calls).toBe(2)
  } finally {
    globalThis.fetch = original
    await AppRuntime.runPromise(Auth.Service.use((s) => s.remove("xai")))
  }
})

test.each(["directory", "all"] as const)(
  "%s disposal queued behind one update cannot enter during the next update",
  async (scope) => {
    const { registerDisposer } = await import("../../src/effect/instance-registry")
    await using tmp = await tmpdir()
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const firstEntered = Promise.withResolvers<void>()
    const firstRelease = Promise.withResolvers<void>()
    const secondEntered = Promise.withResolvers<void>()
    const secondRelease = Promise.withResolvers<void>()
    let inSecond = false
    let disposedDuringSecond = false
    const off = registerDisposer(async (directory) => {
      if (directory === tmp.path && inSecond) disposedDuringSecond = true
    })
    const first = Instance.updateIdle(async () => {
      firstEntered.resolve()
      await firstRelease.promise
    })
    await firstEntered.promise
    const disposal = scope === "all" ? Instance.disposeAll() : Instance.disposeDirectory(tmp.path)
    const second = first.then(() =>
      Instance.updateIdle(async () => {
        inSecond = true
        secondEntered.resolve()
        await secondRelease.promise
        inSecond = false
      }),
    )
    firstRelease.resolve()
    try {
      await secondEntered.promise
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(disposedDuringSecond).toBe(false)
    } finally {
      secondRelease.resolve()
      await second
      await disposal
      off()
    }
  },
)

test("refresh does not rewrite configuration for a cold instance", async () => {
  const { refreshProviders } = await import("../../src/provider/refresh")
  await using tmp = await tmpdir()
  const file = `${tmp.path}/mimocode.json`
  const original = JSON.stringify({ model: "test/example" })
  await Bun.write(file, original)
  await Instance.provide({ directory: tmp.path, fn: () => {} })
  expect(await Bun.file(file).text()).toBe(original)
  expect(await refreshProviders()).toEqual({ state: "applied" })
  const rewritten = await Bun.file(file).text()
  expect(rewritten).toBe(original)
})

test("active server-initiated MCP sampling defers refresh", async () => {
  const { refreshProviders } = await import("../../src/provider/refresh")
  const { McpSampling } = await import("../../src/mcp/sampling")
  const { EffectBridge } = await import("../../src/effect")
  await using tmp = await tmpdir({
    config: {
      model: "review/example",
      enabled_providers: ["review"],
      provider: {
        review: {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "example-key", baseURL: "https://example.invalid/v1" },
          models: { example: { limit: { context: 1000, output: 100 } } },
        },
      },
    },
  })
  let handler: Parameters<import("../../src/mcp/sampling").SamplingClient["setRequestHandler"]>[1]
  await Instance.provide({
    directory: tmp.path,
    fn: () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          McpSampling.serve(
            "example",
            {
              setRequestHandler(_schema, next) {
                handler = next
              },
            },
            bridge,
            undefined,
            undefined,
            "allow",
          )
        }),
      ),
  })
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => {
      started.resolve()
      await finish.promise
      return new Response(
        'data: {"id":"chatcmpl-example","object":"chat.completion.chunk","created":1,"model":"example","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-example","object":"chat.completion.chunk","created":1,"model":"example","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    },
    { preconnect: original.preconnect },
  ) as typeof fetch
  const request = handler!(
    { params: { messages: [{ role: "user", content: { type: "text", text: "hello" } }], maxTokens: 20 } },
    {},
  )
  try {
    await started.promise
    const refresh = await refreshProviders()
    expect(refresh).toEqual({ state: "pending" })
  } finally {
    finish.resolve()
    await request
    globalThis.fetch = original
  }
  expect(await refreshProviders()).toEqual({ state: "applied" })
})

test("an old sampling owner cannot claim an absent or replacement instance", async () => {
  await using tmp = await tmpdir()
  const owner = await Instance.provide({ directory: tmp.path, fn: () => Instance.current })
  await Instance.disposeDirectory(tmp.path)
  let entered = false
  const stale = () =>
    Instance.provide({
      directory: tmp.path,
      expected: owner,
      fn: () => {
        entered = true
      },
    })
  await expect(stale()).rejects.toThrow("Instance busy")
  const replacement = await Instance.provide({ directory: tmp.path, fn: () => Instance.current })
  expect(replacement).not.toBe(owner)
  await expect(stale()).rejects.toThrow("Instance busy")
  expect(entered).toBe(false)
  expect(await Instance.provide({ directory: tmp.path, fn: () => Instance.current })).toBe(replacement)
})

test("sampling cancellation can finish while its owning instance is closing", async () => {
  await using tmp = await tmpdir()
  const { EffectBridge } = await import("../../src/effect")
  const { McpSampling } = await import("../../src/mcp/sampling")
  const { registerDisposer } = await import("../../src/effect/instance-registry")
  let handler: Parameters<import("../../src/mcp/sampling").SamplingClient["setRequestHandler"]>[1]
  const client: import("../../src/mcp/sampling").SamplingClient = {
    setRequestHandler(_schema, next) {
      handler = next
    },
  }
  await Instance.provide({
    directory: tmp.path,
    fn: () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          McpSampling.serve("example", client, bridge, undefined, undefined, "allow")
        }),
      ),
  })
  const closingEntered = Promise.withResolvers<void>()
  const beginCancel = Promise.withResolvers<void>()
  const escape = Promise.withResolvers<void>()
  let cancelled = false
  let cancellation: Promise<void> | undefined
  const off = registerDisposer(async (directory) => {
    if (directory !== tmp.path) return
    closingEntered.resolve()
    await beginCancel.promise
    cancellation = AppRuntime.runPromise(McpSampling.cancelAll(client)).then(() => {
      cancelled = true
    })
    // Real MCP teardown waits for cancellation; the escape keeps a failing test clean.
    await Promise.race([cancellation, escape.promise])
  })
  const disposal = Instance.disposeDirectory(tmp.path)
  await closingEntered.promise
  const request = handler!(
    { params: { messages: [{ role: "user", content: { type: "text", text: "hello" } }], maxTokens: 20 } },
    {},
  ).catch(() => {})
  expect(McpSampling.inFlightCount(client)).toBe(1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  beginCancel.resolve()
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(cancelled).toBe(true)
  } finally {
    escape.resolve()
    await disposal
    await cancellation
    await request
    off()
  }
})
