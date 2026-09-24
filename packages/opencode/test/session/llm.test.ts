import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { pathToFileURL } from "node:url"
import path from "path"
import { APICallError, tool, type ModelMessage } from "ai"
import { ToolCompat } from "../../src/util"
import { Cause, Effect, Exit, Stream } from "effect"
import z from "zod"
import { makeRuntime } from "../../src/effect/run-service"
import { LLM } from "../../src/session/llm"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider"
import { ProviderTransform } from "../../src/provider"
import { ModelsDev } from "../../src/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRetry } from "../../src/session/retry"
import { SessionID, MessageID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { InstanceRef } from "../../src/effect/instance-ref"
import { GlobalBus } from "../../src/bus/global"
import { HostErrorRegistry } from "../../src/error/host-registry"

async function getModel(providerID: ProviderID, modelID: ModelID) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* provider.getModel(providerID, modelID)
    }),
  )
}

const llm = makeRuntime(LLM.Service, LLM.defaultLayer)

async function drain(input: LLM.StreamInput) {
  return llm.runPromise((svc) => svc.stream(input).pipe(Stream.runDrain))
}

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    path: string
    response: Response | ((req: Request, capture: Capture) => Response | Promise<Response>)
    resolve: (value: Capture) => void
  }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function timeout(ms: number) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
}

function waitStreamingRequest(pathname: string) {
  const request = deferred<Capture>()
  const requestAborted = deferred<void>()
  const responseCanceled = deferred<void>()
  const encoder = new TextEncoder()

  state.queue.push({
    path: pathname,
    resolve: request.resolve,
    response(req: Request) {
      req.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true })

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  `data: ${JSON.stringify({
                    id: "chatcmpl-abort",
                    object: "chat.completion.chunk",
                    choices: [{ delta: { role: "assistant" } }],
                  })}`,
                ].join("\n\n") + "\n\n",
              ),
            )
          },
          cancel() {
            responseCanceled.resolve()
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
  })

  return {
    request: request.promise,
    requestAborted: requestAborted.promise,
    responseCanceled: responseCanceled.promise,
  }
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }

      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }

      return typeof next.response === "function"
        ? await next.response(req, { url, headers: req.headers, body })
        : next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  void state.server?.stop()
})

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

async function loadFixture(providerID: string, modelID: string) {
  const fixturePath = path.join(import.meta.dir, "../tool/fixtures/models-api.json")
  const data = await Filesystem.readJson<Record<string, ModelsDev.Provider>>(fixturePath)
  const provider = data[providerID]
  if (!provider) {
    throw new Error(`Missing provider in fixture: ${providerID}`)
  }
  const model = provider.models[modelID]
  if (!model) {
    throw new Error(`Missing model in fixture: ${modelID}`)
  }
  return { provider, model }
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("session.llm.stream", () => {
  for (const withType of [false, true]) {
    for (const behavior of ["terminal", "persistent", "context"] as const) {
      test(`compatible post-output ${behavior} preserves raw error structure (type=${withType})`, async () => {
        const server = state.server
        if (!server) throw new Error("Server not initialized")
        const providerID = ProviderID.make("vivgrid")
        const source = await loadFixture(providerID, "gemini-3.1-pro-preview")
        const code = behavior === "terminal" ? 50002 : 50112
        const frame = {
          ...(withType ? { type: "error" } : {}),
          error: { code, type: behavior === "context" ? "context_length_exceeded" : "upstream_error", message: "upstream IO failed" },
        }
        await using tmp = await tmpdir({ config: {
          enabled_providers: [providerID],
          provider: { [providerID]: { npm: "@ai-sdk/openai-compatible", options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } },
        } })
        const request = waitRequest("/chat/completions", createEventResponse([
          { id: "chat-host", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
          { id: "chat-host", object: "chat.completion.chunk", choices: [{ delta: { content: "Partial output" } }] },
          frame,
        ], true))
        const recovered = behavior === "persistent" ? waitRequest("/chat/completions", new Response(createChatStream("Recovered"), {
          status: 200, headers: { "Content-Type": "text/event-stream" },
        })) : undefined
        HostErrorRegistry.loadHostErrorCatalog({ protocolVersion: 2, rules: [{
          match: { providerID, response: behavior === "terminal" && !withType
            ? { kind: "json", value: frame }
            : { kind: "field", path: "error.code", value: code } },
          code: "host.compatible", retryClass: behavior === "terminal" ? "terminal" : "persistent",
        }] })
        try {
          await Instance.provide({ directory: tmp.path, fn: async () => {
            const model = await getModel(providerID, ModelID.make(source.model.id))
            expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
            const sessionID = SessionID.make("session-compatible-host")
            const agent = { name: "test", mode: "primary", options: {}, permission: [{ permission: "*", pattern: "*", action: "allow" }] } satisfies Agent.Info
            const user = { id: MessageID.make("user-compatible-host"), sessionID, role: "user", time: { created: Date.now() }, agent: agent.name,
              model: { providerID, modelID: model.id } } satisfies MessageV2.User
            let attempts = 0
            let failure: ReturnType<typeof MessageV2.fromError> | undefined
            let retries = 0
            const exit = await llm.runPromise((svc) => Effect.suspend(() => {
              attempts++
              return svc.stream({ user, sessionID, model, agent, system: [], messages: [{ role: "user", content: "Hello" }], tools: {}, retries: 0 }).pipe(
                Stream.runCollect,
                Effect.flatMap((events) => {
                  expect(events.some((event) => event.type === "raw")).toBe(false)
                  expect(events.some((event) => event.type === "text-delta")).toBe(true)
                  const error = events.find((event) => event.type === "error")
                  if (!error || error.type !== "error") return Effect.succeed(events)
                  failure = MessageV2.fromError(error.error, { providerID })
                  return Effect.fail(error.error)
                }),
              )
            }).pipe(Effect.retry(SessionRetry.policy({
              parse: (error) => MessageV2.fromError(error, { providerID }),
              budget: () => ({ mode: "bounded", maxRetries: 0, maxElapsedMs: 1, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }),
              set: (info) => Effect.sync(() => { retries++; expect(info.hostCode).toBe("host.compatible") }),
            })), Effect.exit))
            await request
            expect(failure).toBeDefined()
            if (!failure) throw new Error("Expected a provider failure")
            if (behavior === "context") {
              expect(failure.name).toBe("ContextOverflowError")
              expect(failure.data.hostCode).toBeUndefined()
              expect(SessionRetry.decide(failure).retryable).toBe(false)
            } else {
              expect(failure.data).toMatchObject({ hostCode: "host.compatible", hostRetryClass: behavior })
            }
            expect(MessageV2.fromError(JSON.parse(JSON.stringify(failure)), { providerID })).toEqual(failure)
            expect(Exit.isSuccess(exit)).toBe(behavior === "persistent")
            expect(attempts).toBe(behavior === "persistent" ? 2 : 1)
            expect(retries).toBe(behavior === "persistent" ? 1 : 0)
            await recovered
          } })
        } finally {
          HostErrorRegistry.loadHostErrorCatalog({ protocolVersion: 2, rules: [] })
        }
      })
    }
  }

  for (const origin of ["plugin", "tool repair"] as const) {
    test(`${origin} APICallError lookalike cannot acquire a provider host binding`, async () => {
      const server = state.server
      if (!server) throw new Error("Server not initialized")
      const source = await loadFixture("openai", "gpt-5.2")
      const raw = new APICallError({ message: "local extension failure", url: "https://example.com", requestBodyValues: {}, statusCode: 403,
        responseBody: JSON.stringify({ error: { code: 90100 } }), isRetryable: false })
      const repair = origin === "tool repair" ? spyOn(ToolCompat, "repairToolCall").mockRejectedValue(raw) : undefined
      await using tmp = await tmpdir({ init: async (dir) => {
        const plugin = path.join(dir, "plugin.ts")
        if (origin === "plugin") await Bun.write(plugin, `import { APICallError } from ${JSON.stringify(import.meta.resolve("ai"))};
export default async () => ({ "chat.params": async () => { throw new APICallError({ message: "plugin preparation failure", url: "https://example.com", requestBodyValues: {}, statusCode: 403, responseBody: '{"error":{"code":90100}}', isRetryable: false }); } });`)
        await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify({
          enabled_providers: ["openai"],
          ...(origin === "plugin" ? { plugin: [pathToFileURL(plugin).href] } : {}),
          provider: { openai: { npm: "@ai-sdk/openai", options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } },
        }))
      } })
      const request = origin === "tool repair" ? waitRequest("/responses", createEventResponse([
        { type: "response.created", response: { id: "resp-repair", created_at: 1, model: source.model.id, service_tier: null } },
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_repair", call_id: "call_repair", name: "missing_tool", arguments: "" } },
        { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_repair", call_id: "call_repair", name: "missing_tool", arguments: "{}", status: "completed" } },
        { type: "response.completed", response: { incomplete_details: null, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null }, service_tier: null } },
      ], true)) : undefined
      HostErrorRegistry.loadHostErrorCatalog({ protocolVersion: 2, rules: [{
        match: { providerID: ProviderID.openai, response: { kind: "field", path: "error.code", value: 90100 } },
        code: "host.provider_only", retryClass: "terminal",
      }] })
      try {
        await Instance.provide({ directory: tmp.path, fn: async () => {
          const model = await getModel(ProviderID.openai, ModelID.make(source.model.id))
          const sessionID = SessionID.make("session-source-isolation")
          const agent = { name: "test", mode: "primary", options: {}, permission: [{ permission: "*", pattern: "*", action: "allow" }] } satisfies Agent.Info
          const user = { id: MessageID.make("user-source-isolation"), sessionID, role: "user", time: { created: Date.now() }, agent: agent.name,
            model: { providerID: ProviderID.openai, modelID: model.id } } satisfies MessageV2.User
          const exit = await llm.runPromise((svc) => svc.stream({
            user, sessionID, model, agent, system: [], messages: [{ role: "user", content: "Hello" }], retries: 0,
            tools: { known: tool({ description: "Known tool", inputSchema: z.object({}), execute: async () => "ok" }) },
          }).pipe(Stream.runCollect, Effect.exit))
          await request
          if (origin === "plugin") {
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isSuccess(exit)) throw new Error("Expected plugin failure")
            const error = Cause.squash(exit.cause)
            expect(APICallError.isInstance(error)).toBe(true)
            expect(MessageV2.fromError(error, { providerID: ProviderID.openai }).data.hostCode).toBeUndefined()
          } else {
            expect(repair).toHaveBeenCalledTimes(1)
            const errors = Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : exit.value.flatMap((event) => "error" in event && event.error ? [event.error] : [])
            expect(errors.length).toBeGreaterThan(0)
            for (const error of [...errors, raw]) expect(MessageV2.fromError(error, { providerID: ProviderID.openai }).data.hostCode).toBeUndefined()
          }
        } })
      } finally {
        repair?.mockRestore()
        HostErrorRegistry.loadHostErrorCatalog({ protocolVersion: 2, rules: [] })
      }
    })
  }

  test("host API binding survives a provider error after streamed output", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    const source = await loadFixture("openai", "gpt-5.2")
    await using tmp = await tmpdir({ config: {
      enabled_providers: ["openai"],
      provider: { openai: { npm: "@ai-sdk/openai", options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } },
    } })
    const frame = { type: "error", sequence_number: 2, error: { code: "90100", type: "upstream_failure", message: "fetch failed ECONNRESET" } }
    const request = waitRequest("/responses", createEventResponse([
      { type: "response.created", response: { id: "resp-host", created_at: 1, model: source.model.id, service_tier: null } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "item-host" } },
      { type: "response.output_text.delta", item_id: "item-host", delta: "Partial output", logprobs: null },
      frame,
    ], true))
    HostErrorRegistry.loadHostErrorCatalog({ protocolVersion: 2, rules: [{
      match: { providerID: ProviderID.openai, response: { kind: "field", path: "error.code", value: "90100" } },
      code: "host.stream_failure", retryClass: "terminal",
    }] })
    try {
      await Instance.provide({ directory: tmp.path, fn: async () => {
        const model = await getModel(ProviderID.openai, ModelID.make(source.model.id))
        const sessionID = SessionID.make("session-host-stream")
        const agent = { name: "test", mode: "primary", options: {}, permission: [{ permission: "*", pattern: "*", action: "allow" }] } satisfies Agent.Info
        const user = { id: MessageID.make("user-host-stream"), sessionID, role: "user", time: { created: Date.now() }, agent: agent.name,
          model: { providerID: ProviderID.openai, modelID: model.id } } satisfies MessageV2.User
        const events = await llm.runPromise((svc) => svc.stream({
          user, sessionID, model, agent, system: [], messages: [{ role: "user", content: "Hello" }], tools: {}, retries: 0,
        }).pipe(Stream.runCollect))
        await request
        expect(events.some((event) => event.type === "text-delta")).toBe(true)
        const error = events.find((event) => event.type === "error")
        if (!error || error.type !== "error") throw new Error("Expected provider failure")
        expect(MessageV2.fromError(error.error, { providerID: ProviderID.openai })).toMatchObject({
          name: "APIError", data: { hostCode: "host.stream_failure", hostRetryClass: "terminal" },
        })
      } })
    } finally {
      HostErrorRegistry.loadHostErrorCatalog({ protocolVersion: 2, rules: [] })
    }
  })

  test("request retry events follow Effect InstanceRef instead of a different ambient ALS instance", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    const source = await loadFixture("openai", "gpt-5.2")
    const config = {
      enabled_providers: ["openai"],
      provider: { openai: {
        npm: "@ai-sdk/openai",
        options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` },
      } },
      retry: {
        network: { initialDelayMs: 5, maxDelayMs: 5, jitterRatio: 0 },
        server: { initialDelayMs: 5, maxDelayMs: 5, jitterRatio: 0 },
        rateLimit: { initialDelayMs: 5, maxDelayMs: 5, jitterRatio: 0 },
      },
    }
    await using ambient = await tmpdir({ config })
    await using owner = await tmpdir({ config })
    const sessionID = SessionID.make("session-retry-instance-ref")
    const received: Array<{ kind: string; hostCode?: string }> = []
    const misplaced: Array<{ kind: string }> = []
    const directories: string[] = []
    const onGlobal = (event: { directory?: string; payload: { type: string; properties?: { sessionID?: string } } }) => {
      if (event.payload.type === Session.Event.RetryAttempt.type && event.payload.properties?.sessionID === sessionID) {
        directories.push(event.directory ?? "")
      }
    }
    const target = await Instance.provide({ directory: owner.path, fn: async () => ({
      context: Instance.current,
      model: await getModel(ProviderID.openai, ModelID.make(source.model.id)),
      unsubscribe: Bus.subscribe(Session.Event.RetryAttempt, (event) => {
        if (event.properties.sessionID === sessionID) received.push(event.properties)
      }),
    }) })
    const unsubscribeAmbient = await Instance.provide({ directory: ambient.path, fn: () =>
      Bus.subscribe(Session.Event.RetryAttempt, (event) => {
        if (event.properties.sessionID === sessionID) misplaced.push(event.properties)
      }),
    })
    HostErrorRegistry.loadHostErrorCatalog({ protocolVersion: 2, rules: [408, 429, 503].map((statusCode) => ({
      match: { providerID: ProviderID.openai, statusCode, response: { kind: "field", path: "error.code", value: 90100 } },
      code: `host.${statusCode}`, retryClass: "persistent",
    })) })
    GlobalBus.on("event", onGlobal)
    try {
      const failures = [408, 429, 503].map((status) => waitRequest("/responses", new Response(
        JSON.stringify({ error: { code: 90100, message: "request failed", type: "upstream_failure" } }),
        { status, headers: { "Content-Type": "application/json" } },
      )))
      const success = waitRequest("/responses", createEventResponse([], true))
      const agent = { name: "test", mode: "primary", options: {}, permission: [{ permission: "*", pattern: "*", action: "allow" }] } satisfies Agent.Info
      const user = {
        id: MessageID.make("user-retry-instance-ref"), sessionID, role: "user", time: { created: Date.now() },
        agent: agent.name, model: { providerID: ProviderID.openai, modelID: target.model.id },
      } satisfies MessageV2.User
      const events = await Instance.provide({ directory: ambient.path, fn: () =>
        llm.runPromise((svc) => svc.stream({
          user, sessionID, model: target.model, agent, system: [],
          messages: [{ role: "user", content: "Hello" }], tools: {}, retries: 0,
        }).pipe(Stream.runCollect, Effect.provideService(InstanceRef, target.context))),
      })
      await Promise.all([...failures, success])
      expect(Array.from(events).some((event) => event.type === "error")).toBe(false)
      expect(misplaced).toEqual([])
      expect(received).toEqual([
        expect.objectContaining({ kind: "unknown", hostCode: "host.408" }),
        expect.objectContaining({ kind: "rate_limit", hostCode: "host.429" }),
        expect.objectContaining({ kind: "server", hostCode: "host.503" }),
      ])
      expect(directories).toEqual([owner.path, owner.path, owner.path])
    } finally {
      target.unsubscribe()
      unsubscribeAmbient()
      GlobalBus.off("event", onGlobal)
      HostErrorRegistry.loadHostErrorCatalog({ protocolVersion: 2, rules: [] })
    }
  }, 15_000)

  test("sends temperature, tokens, and reasoning options for openai-compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "vivgrid"
    const modelID = "gemini-3.1-pro-preview"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-1")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id, variant: "high" },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const maxTokens = (body.max_tokens as number | undefined) ?? (body.max_output_tokens as number | undefined)
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBe("high")
      },
    })
  })

  test("service stream cancellation cancels provider response body promptly", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pending = waitStreamingRequest("/chat/completions")

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-service-abort")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-service-abort"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const ctrl = new AbortController()
        const run = llm.runPromiseExit(
          (svc) =>
            svc
              .stream({
                user,
                sessionID,
                model: resolved,
                agent,
                system: ["You are a helpful assistant."],
                messages: [{ role: "user", content: "Hello" }],
                tools: {},
              })
              .pipe(Stream.runDrain),
          { signal: ctrl.signal },
        )

        await pending.request
        ctrl.abort()

        await Promise.race([pending.responseCanceled, timeout(500)])
        const exit = await run
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        }
        await Promise.race([pending.requestAborted, timeout(500)]).catch(() => undefined)
      },
    })
  })

  test("keeps tools enabled by prompt permissions", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          tools: { question: true },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          permission: [{ permission: "question", pattern: "*", action: "allow" }],
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            question: tool({
              description: "Ask a question",
              inputSchema: z.object({}),
              execute: async () => ({ output: "" }),
            }),
          },
        })

        const capture = await request
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.some((item) => item.function?.name === "question")).toBe(true)
      },
    })
  })

  test("sends responses API payload for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model

    const responseChunks = [
      {
        type: "response.created",
        response: {
          id: "resp-1",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-1",
        delta: "Hello",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(responseChunks, true))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.openai, ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-2")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id, variant: "high" },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")

        const maxTokens = body.max_output_tokens as number | undefined
        expect(maxTokens).toBe(undefined) // match codex cli behavior
      },
    })
  })

  test("serializes only active tools while retaining inactive executors", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const source = await loadFixture("openai", "gpt-5.2")
    let hiddenCalls = 0
    const request = waitRequest(
      "/responses",
      createEventResponse(
        [
          {
            type: "response.created",
            response: {
              id: "resp-active-tools",
              created_at: Math.floor(Date.now() / 1000),
              model: source.model.id,
              service_tier: null,
            },
          },
          {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_hidden",
              call_id: "call_hidden",
              name: "calendar_hidden",
              arguments: "",
              status: "in_progress",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            sequence_number: 2,
            output_index: 0,
            item_id: "fc_hidden",
            delta: '{"private_field":"today"}',
          },
          {
            type: "response.function_call_arguments.done",
            sequence_number: 3,
            output_index: 0,
            item_id: "fc_hidden",
            arguments: '{"private_field":"today"}',
          },
          {
            type: "response.output_item.done",
            sequence_number: 4,
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_hidden",
              call_id: "call_hidden",
              name: "calendar_hidden",
              arguments: '{"private_field":"today"}',
              status: "completed",
            },
          },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          },
        ],
        true,
      ),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "mimocode.json"),
          JSON.stringify({
            enabled_providers: ["openai"],
            provider: {
              openai: {
                npm: "@ai-sdk/openai",
                models: { [source.model.id]: source.model },
                options: { apiKey: "test-openai-key", baseURL: `${server.url.origin}/v1` },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.openai, ModelID.make(source.model.id))
        const sessionID = SessionID.make("session-active-tools-wire")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-active-tools-wire"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.openai, modelID: resolved.id },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: [{ role: "user", content: "find a calendar tool" }],
          tools: {
            mcp_tool_search: tool({
              description: "Search MCP tools",
              inputSchema: z.object({ query: z.string() }),
              execute: async () => ({ title: "", output: "", metadata: {} }),
            }),
            calendar_hidden: tool({
              description: "Secret calendar MCP description",
              inputSchema: z.object({ private_field: z.string() }),
              execute: async () => {
                hiddenCalls++
                return { title: "", output: "", metadata: {} }
              },
            }),
            direct_tool: tool({
              description: "A directly exposed non-MCP tool",
              inputSchema: z.object({}),
              execute: async () => ({ title: "", output: "", metadata: {} }),
            }),
          },
          activeTools: ["mcp_tool_search", "direct_tool"],
        })

        const tools = (await request).body.tools as Array<Record<string, unknown>>
        expect(tools.map((item) => item.name)).toEqual(expect.arrayContaining(["mcp_tool_search", "direct_tool"]))
        expect(tools.map((item) => item.name)).not.toContain("calendar_hidden")
        expect(JSON.stringify(tools)).not.toContain("Secret calendar MCP description")
        expect(JSON.stringify(tools)).not.toContain("private_field")
        expect(hiddenCalls).toBe(1)
      },
    })
  })

  test("retries an OpenAI request that times out before response headers", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const source = await loadFixture("openai", "gpt-5.2")
    const first = deferred<Capture>()
    const second = deferred<Capture>()
    state.queue.push({
      path: "/responses",
      resolve: first.resolve,
      response: async () => {
        await Bun.sleep(500)
        return createEventResponse([], true)
      },
    })
    state.queue.push({
      path: "/responses",
      resolve: second.resolve,
      response: createEventResponse([], true),
    })

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: { [source.model.id]: source.model },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                  headerTimeout: 25,
                },
                // Exercise header-timeout recovery without the production five-second backoff.
                retry: {
                  network: { mode: "bounded", maxRetries: 1, initialDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.openai, ModelID.make(source.model.id))
        const sessionID = SessionID.make("session-test-openai-header-timeout")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-openai-header-timeout"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.openai, modelID: resolved.id },
        } satisfies MessageV2.User
        const retries: Array<{ kind: string; phase: string; nextDelayMs: number }> = []
        const unsubscribe = Bus.subscribe(Session.Event.RetryAttempt, (event) => {
          if (event.properties.sessionID === sessionID) retries.push(event.properties)
        })
        const events = await llm.runPromise((svc) =>
          svc
            .stream({
              user,
              sessionID,
              model: resolved,
              agent,
              system: ["You are a helpful assistant."],
              messages: [{ role: "user", content: "Hello" }],
              tools: {},
            })
            .pipe(Stream.runCollect),
        ).finally(unsubscribe)

        expect(retries).toEqual([expect.objectContaining({ kind: "network", phase: "request", nextDelayMs: 10 })])
        expect(Array.from(events).some((event) => event.type === "error")).toBe(false)
        expect((await first.promise).url.pathname.endsWith("/responses")).toBe(true)
        expect((await second.promise).url.pathname.endsWith("/responses")).toBe(true)
      },
    })
  }, 15_000)

  test("accepts user image attachments as data URLs for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model
    const chunks = [
      {
        type: "response.created",
        response: {
          id: "resp-data-url",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-data-url",
        delta: "Looks good",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(chunks, true))
    const image = `data:image/png;base64,${Buffer.from(
      await Bun.file(path.join(import.meta.dir, "../tool/fixtures/large-image.png")).arrayBuffer(),
    ).toString("base64")}`

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.openai, ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-data-url")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-data-url"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this image" },
                {
                  type: "file",
                  mediaType: "image/png",
                  filename: "large-image.png",
                  data: image,
                },
              ],
            },
          ] as ModelMessage[],
          tools: {},
        })

        const capture = await request
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
      },
    })
  })

  test("sends messages API payload for Anthropic Compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "minimax"
    const modelID = "MiniMax-M2.5"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-1",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-3")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("minimax"), modelID: ModelID.make("MiniMax-M2.5") },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.9)
      },
    })
  })

  test("sends anthropic tool_use blocks with tool_result immediately after them", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("anthropic", "claude-opus-4-6")
    const model = source.model
    const pdf = "JVBERi0xLjQKJSVFT0YK"
    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-tool-order",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["anthropic"],
            provider: {
              anthropic: {
                name: "Anthropic",
                env: ["ANTHROPIC_API_KEY"],
                npm: "@ai-sdk/anthropic",
                api: "https://api.anthropic.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make("anthropic"), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-anthropic-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("user-anthropic-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("anthropic"), modelID: resolved.id, variant: "max" },
        } satisfies MessageV2.User

        const input = [
          {
            info: {
              id: "msg_user",
              sessionID,
              role: "user",
              time: { created: 1 },
              agent: "gentleman",
              model: { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "max" },
            },
            parts: [
              {
                id: "p_user",
                sessionID,
                messageID: "msg_user",
                type: "text",
                text: "Can you check whether there are any PDF files in my home directory?",
              },
            ],
          },
          {
            info: {
              id: "msg_call",
              sessionID,
              parentID: "msg_user",
              role: "assistant",
              mode: "gentleman",
              agent: "gentleman",
              variant: "max",
              path: { cwd: "/root", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: "claude-opus-4-6",
              providerID: "anthropic",
              time: { created: 2, completed: 3 },
              finish: "tool-calls",
            },
            parts: [
              {
                id: "p_step",
                sessionID,
                messageID: "msg_call",
                type: "step-start",
              },
              {
                id: "p_read",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "read",
                callID: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                state: {
                  status: "completed",
                  input: { filePath: "/root" },
                  output: "<path>/root</path>",
                  metadata: {},
                  title: "root",
                  time: { start: 10, end: 11 },
                  attachments: [
                    {
                      id: "p_read_pdf",
                      sessionID,
                      messageID: "msg_call",
                      type: "file",
                      mime: "application/pdf",
                      filename: "report.pdf",
                      url: `data:application/pdf;base64,${pdf}`,
                    },
                  ],
                },
              },
              {
                id: "p_glob",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "glob",
                callID: "toolu_01APxrADs7VozN8uWzw9WwHr",
                state: {
                  status: "completed",
                  input: { pattern: "**/*.pdf", path: "/root" },
                  output: "No files found",
                  metadata: {},
                  title: "root",
                  time: { start: 12, end: 13 },
                },
              },
              {
                id: "p_text",
                sessionID,
                messageID: "msg_call",
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
                time: { start: 14, end: 15 },
              },
            ],
          },
        ] as any[]

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: await MessageV2.toModelMessages(input as any, resolved),
          tools: {
            read: tool({
              description: "Stub read tool",
              inputSchema: z.object({
                filePath: z.string(),
              }),
              execute: async () => ({ output: "stub" }),
            }),
            glob: tool({
              description: "Stub glob tool",
              inputSchema: z.object({
                pattern: z.string(),
                path: z.string().optional(),
              }),
              execute: async () => ({ output: "stub" }),
            }),
          },
        })

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.messages).toStrictEqual([
          {
            role: "user",
            content: [{ type: "text", text: "Can you check whether there are any PDF files in my home directory?" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
              },
              {
                type: "tool_use",
                id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                name: "read",
                input: { filePath: "/root" },
              },
              {
                cache_control: { type: "ephemeral" },
                type: "tool_use",
                id: "toolu_01APxrADs7VozN8uWzw9WwHr",
                name: "glob",
                input: { pattern: "**/*.pdf", path: "/root" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                content: [
                  { type: "text", text: "<path>/root</path>" },
                  {
                    type: "document",
                    source: {
                      type: "base64",
                      media_type: "application/pdf",
                      data: pdf,
                    },
                  },
                ],
              },
              {
                cache_control: { type: "ephemeral" },
                type: "tool_result",
                tool_use_id: "toolu_01APxrADs7VozN8uWzw9WwHr",
                content: "No files found",
              },
            ],
          },
        ])
      },
    })
  })

  test("sends Google API payload for Gemini models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "google"
    const modelID = "gemini-2.5-flash"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      },
    ]
    const request = waitRequest(pathSuffix, createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-google-key",
                  baseURL: `${server.url.origin}/v1beta`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-4")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-4"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body
        const config = body.generationConfig as
          | { temperature?: number; topP?: number; maxOutputTokens?: number }
          | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      },
    })
  })
})
