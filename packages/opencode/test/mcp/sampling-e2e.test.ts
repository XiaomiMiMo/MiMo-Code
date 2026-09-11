import { test, expect, describe, afterEach } from "bun:test"
import path from "path"
import { Effect } from "effect"
import type { Client as ClientType } from "@modelcontextprotocol/sdk/client/index.js"
import type { McpServer as McpServerType } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod/v4"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { AppRuntime } from "../../src/effect/app-runtime"
import { EffectBridge } from "../../src/effect"
import { McpSampling } from "../../src/mcp/sampling"
import { DEFAULT_CHUNK_TIMEOUT } from "../../src/provider/provider"
import { MCP } from "../../src/mcp/index"
import { Permission } from "../../src/permission"
import type { SessionID } from "../../src/session/schema"
import { wav } from "./wav-fixture"

/**
 * END-TO-END proof of MCP client-side sampling over a REAL bidirectional
 * JSON-RPC link.
 *
 * A real SDK `McpServer` exposes `transcribe_audio_fixture`. While that tool is
 * executing — i.e. while our side is still awaiting the `tools/call` response —
 * the server issues `sampling/createMessage` back at us carrying a 16 kHz mono
 * WAV. Our production handler (`McpSampling.serve`, the same function
 * `src/mcp/index.ts` wires up) selects a model, runs it, and answers. The server
 * then finishes its tool call with the transcript it received.
 *
 * The provider is mocked at the HTTP boundary only, so the audio genuinely passes
 * through the real `@ai-sdk/openai-compatible` conversion layer and we can assert
 * on the bytes that reached the wire. No real model and no real API key are used.
 *
 * THE SDK IS LOADED FROM ITS CJS BUILD ON PURPOSE. Sibling files
 * (lifecycle.test.ts, oauth-*.test.ts) call
 * `mock.module("@modelcontextprotocol/sdk/client/index.js")` at module scope.
 * Bun's module mocks are process-wide, survive across test files, cannot be
 * bypassed by importing the same module through an absolute path or a file URL,
 * and CI shards by file — so which mocks are live when this file runs is not
 * something a file name can control. The package's `dist/cjs` tree is a different
 * set of physical files and therefore a different set of module records, so it is
 * immune. Every SDK value below comes from that single realm so no cross-realm
 * classes are mixed. The `harness integrity` test fails loudly if this ever stops
 * yielding the genuine `Client`.
 */

/** The real SDK, loaded from `dist/cjs` so no `mock.module` can intercept it. */
const sdk = await (async () => {
  const esmEntry = Bun.resolveSync("@modelcontextprotocol/sdk/client/index.js", import.meta.dir)
  const cjsClient = esmEntry.replace(`${path.sep}esm${path.sep}`, `${path.sep}cjs${path.sep}`)
  const cjsDir = path.dirname(path.dirname(cjsClient))
  const load = async (relative: string) => {
    const mod: any = await import(path.join(cjsDir, relative))
    return mod.Client || mod.McpServer || mod.InMemoryTransport || mod.CallToolResultSchema ? mod : mod.default
  }
  const [client, server, inMemory, types] = await Promise.all([
    load("client/index.js"),
    load("server/mcp.js"),
    load("inMemory.js"),
    load("types.js"),
  ])
  return {
    Client: client.Client as unknown as typeof ClientType,
    McpServer: server.McpServer as unknown as typeof McpServerType,
    InMemoryTransport: inMemory.InMemoryTransport,
    CallToolResultSchema: types.CallToolResultSchema,
    CreateMessageRequestSchema: types.CreateMessageRequestSchema,
    CreateMessageResultSchema: types.CreateMessageResultSchema,
  }
})()

const {
  Client,
  McpServer,
  InMemoryTransport,
  CallToolResultSchema,
  CreateMessageRequestSchema,
  CreateMessageResultSchema,
} = sdk

const TRANSCRIPT = "the quick brown fox jumps over the lazy dog"
const SESSION = "ses_sampling_e2e" as SessionID

// A single self-contained config provider. `npm` + `models` + `apiKey` are all
// declared so the provider loads deterministically without env-key autoload,
// mirroring test/provider/model-groups.test.ts.
const PROVIDER_ID = "samplingfixture"

const PROVIDERS = {
  [PROVIDER_ID]: {
    name: "Sampling Fixture",
    npm: "@ai-sdk/openai-compatible",
    env: [],
    api: "https://example.invalid/v1",
    options: { apiKey: "test-key", baseURL: "https://example.invalid/v1" },
    models: {
      "mimo-v2.5": {
        name: "MiMo v2.5",
        tool_call: true,
        modalities: { input: ["text", "image", "audio"], output: ["text"] },
        limit: { context: 128_000, output: 8_000 },
      },
      "mimo-text-only": {
        name: "MiMo Text Only",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 128_000, output: 8_000 },
      },
    },
  },
}

interface Wire {
  bodies: Array<any>
  restore: () => void
}

/**
 * One `chat.completion.chunk` envelope. `id`/`model` are fixed so the deltas below
 * differ only in their content.
 */
const CHUNK = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "mimo-v2.5" }

/**
 * Split text into deltas that CONCATENATE BACK TO IT EXACTLY — whitespace is kept
 * with the word it follows — because the round-trip assertions compare the
 * assembled result against the original string byte for byte.
 */
function splitDeltas(text: string): ReadonlyArray<string> {
  return text.match(/\S+\s*/g) ?? [text]
}

function sseEvent(payload: object) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function deltaEvent(content: string) {
  return sseEvent({ ...CHUNK, choices: [{ index: 0, delta: { content }, finish_reason: null }] })
}

function finishEvents(finishReason = "stop") {
  return (
    sseEvent({
      ...CHUNK,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }) + "data: [DONE]\n\n"
  )
}

/**
 * Replace global fetch with an OpenAI-compatible chat-completions stub.
 *
 * SERVER-SENT EVENTS, because sampling calls `streamText`: the adapter requests
 * `stream: true` and parses `text/event-stream`. This fixture used to answer with a
 * single non-streaming JSON completion, and the conversion is not cosmetic — a JSON
 * body does NOT fail loudly against a streaming adapter, it yields a stream
 * carrying no text deltas at all, so every transcript assertion would have started
 * comparing against `""`. The assertions themselves are untouched: same text, same
 * `stopReason`, same audio bytes on the wire.
 */
function stubProvider(text: string): Wire {
  const original = globalThis.fetch
  const bodies: Array<any> = []
  globalThis.fetch = (async (url: any, init: any) => {
    const href = typeof url === "string" ? url : (url?.url ?? String(url))
    if (!href.includes("example.invalid")) return original(url, init)
    bodies.push(JSON.parse(init.body as string))
    return new Response(splitDeltas(text).map(deltaEvent).join("") + finishEvents(), {
      headers: { "content-type": "text/event-stream" },
    })
  }) as typeof fetch
  return { bodies, restore: () => (globalThis.fetch = original) }
}

/**
 * Like `stubProvider`, but the chat-completions call NEVER answers — the shape of
 * a provider that has accepted the request and gone quiet. `release()` settles the
 * abandoned calls after the assertions so no promise is left dangling.
 *
 * `signals` captures the `AbortSignal` each captive call was issued with, which is
 * how a test can assert that abandoning a request actually ABORTED the provider
 * call rather than merely stopping our own waiting for it.
 */
function stubProviderHang(): Wire & { signals: Array<AbortSignal | undefined>; release: () => void } {
  const original = globalThis.fetch
  const bodies: Array<any> = []
  const signals: Array<AbortSignal | undefined> = []
  const pending: Array<(response: Response) => void> = []
  globalThis.fetch = (async (url: any, init: any) => {
    const href = typeof url === "string" ? url : (url?.url ?? String(url))
    if (!href.includes("example.invalid")) return original(url, init)
    bodies.push(JSON.parse(init.body as string))
    signals.push(init?.signal as AbortSignal | undefined)
    return new Promise<Response>((resolve) => pending.push(resolve))
  }) as typeof fetch
  return {
    bodies,
    signals,
    restore: () => (globalThis.fetch = original),
    release: () => {
      for (const resolve of pending.splice(0)) {
        resolve(
          new Response(deltaEvent("too late") + finishEvents(), {
            headers: { "content-type": "text/event-stream" },
          }),
        )
      }
    },
  }
}

/**
 * A provider that streams deltas SLOWLY, and can stop mid-stream and never finish.
 *
 * `gapMs` is the pause before each delta, i.e. exactly the inter-chunk gap the
 * stall detector measures — which is what makes both halves of that detector
 * testable: gaps under the bound must NOT stall, and going quiet must. With
 * `thenSilent` the response body stays open forever after the last delta, which is
 * the shape of a provider that answered, started producing, and died — distinct
 * from `stubProviderHang`, where nothing ever arrives at all.
 */
function stubProviderTrickle(input: {
  deltas: ReadonlyArray<string>
  gapMs: number
  thenSilent?: boolean
}): Wire & { signals: Array<AbortSignal | undefined>; release: () => void } {
  const original = globalThis.fetch
  const bodies: Array<any> = []
  const signals: Array<AbortSignal | undefined> = []
  const closers: Array<() => void> = []
  let abandoned = false
  globalThis.fetch = (async (url: any, init: any) => {
    const href = typeof url === "string" ? url : (url?.url ?? String(url))
    if (!href.includes("example.invalid")) return original(url, init)
    bodies.push(JSON.parse(init.body as string))
    signals.push(init?.signal as AbortSignal | undefined)
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true
        const close = () => {
          if (!open) return
          open = false
          try {
            controller.close()
          } catch {
            // Already closed or cancelled by the consumer; nothing to do.
          }
        }
        closers.push(close)
        for (const delta of input.deltas) {
          await new Promise((resolve) => setTimeout(resolve, input.gapMs))
          if (!open || abandoned) return
          controller.enqueue(encoder.encode(deltaEvent(delta)))
        }
        // Hold the connection open and silent: the stall detector, not the end of
        // the stream, has to be what ends this request.
        if (input.thenSilent) return
        if (!open) return
        controller.enqueue(encoder.encode(finishEvents()))
        close()
      },
      cancel() {
        abandoned = true
      },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch
  return {
    bodies,
    signals,
    restore: () => (globalThis.fetch = original),
    release: () => {
      abandoned = true
      for (const close of closers.splice(0)) close()
    },
  }
}

let wire: Wire | undefined

afterEach(() => {
  wire?.restore()
  wire = undefined
})

interface Harness {
  client: ClientType
  server: McpServerType
  /** Sampling requests the server issued, and what it got back. */
  samplingOutcomes: Array<{ ok: boolean; detail: unknown }>
  /** True while the fixture tool is mid-execution. */
  toolActive: () => boolean
  /**
   * `notifications/progress` messages that actually reached the server. Recorded
   * off the transport, not off our own bookkeeping, so a test cannot pass because
   * we counted an intention rather than a delivered message.
   */
  progressNotifications: Array<any>
}

/**
 * A real client/server pair over InMemoryTransport, with our production sampling
 * handler registered on the client exactly as `src/mcp/index.ts` registers it.
 */
async function harness(input: {
  audio?: { data: string; mimeType: string }
  hints?: Array<{ name: string }>
  text?: string
  /** Abort the sampling request once a permission prompt is pending. */
  cancelAfterAsk?: boolean
  /**
   * Passed straight through to `server.server.request`. Supplying it is the ONLY
   * way a progress token comes into existence: the SDK mints one solely when its
   * caller asked for progress (`if (options?.onprogress) { ... progressToken:
   * messageId }`, shared/protocol.js). Omitting it models a server that never
   * opted in — and then our side must send nothing at all.
   */
  onprogress?: (progress: any) => void
  /** The server's own per-request timeout; left at the SDK's 60 s when absent. */
  requestTimeout?: number
}): Promise<Harness> {
  const server = new McpServer({ name: "fixture", version: "1.0.0" })
  const samplingOutcomes: Array<{ ok: boolean; detail: unknown }> = []
  let active = false

  server.registerTool(
    "transcribe_audio_fixture",
    {
      description: "Transcribes bundled fixture audio by asking the client to sample a model.",
      inputSchema: { note: z.string().optional() },
    },
    async () => {
      active = true
      try {
        // Server -> client REQUEST issued while the client is still awaiting this
        // tool's own response. If either direction blocked the other, this await
        // would never settle.
        const content = input.audio
          ? [
              { type: "text" as const, text: "Transcribe this audio verbatim." },
              { type: "audio" as const, data: input.audio.data, mimeType: input.audio.mimeType },
            ]
          : [{ type: "text" as const, text: input.text ?? "say hello" }]
        const controller = new AbortController()
        if (input.cancelAfterAsk) {
          // Burn JSON-RPC request id 0 first. The SDK drops a cancellation whose
          // `requestId` is 0 (`if (!notification.params.requestId) return` in
          // shared/protocol.js), so the FIRST server-initiated request of a
          // connection is uncancellable upstream. Cancelling a later request
          // exercises the path our handler actually has to survive.
          await server.server.ping()
          // Cancel as soon as the client has raised its approval prompt, i.e.
          // while our handler is genuinely parked mid-request.
          void waitForAsk().then(
            () => controller.abort(new Error("server cancelled sampling")),
            () => controller.abort(new Error("server cancelled sampling")),
          )
        }
        const result = await server.server.request(
          {
            method: "sampling/createMessage",
            params: {
              messages: [{ role: "user", content }],
              systemPrompt: "You are a verbatim transcription engine.",
              maxTokens: 2048,
              ...(input.hints ? { modelPreferences: { hints: input.hints } } : {}),
            },
          },
          CreateMessageResultSchema,
          {
            signal: controller.signal,
            ...(input.onprogress ? { onprogress: input.onprogress } : {}),
            ...(input.requestTimeout !== undefined ? { timeout: input.requestTimeout } : {}),
          },
        )
        samplingOutcomes.push({ ok: true, detail: result })
        return { content: [{ type: "text", text: (result.content as { text: string }).text }] }
      } catch (error: any) {
        samplingOutcomes.push({ ok: false, detail: { code: error?.code, message: error?.message, data: error?.data } })
        return { content: [{ type: "text", text: `SAMPLING_ERROR ${error?.code}` }], isError: true }
      } finally {
        active = false
      }
    },
  )

  // PRODUCTION's own capability object, not a copy — so a regression that drops
  // `sampling` from src/mcp/index.ts fails these tests instead of passing against
  // a duplicated literal.
  const client = new Client({ name: "mimocode", version: "test" }, MCP.CLIENT_OPTIONS)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)])
  // Tap the SERVER's inbound transport after connect. `Protocol.connect` chains
  // whatever `onmessage` it found, so wrapping the one it installed keeps the
  // SDK's own dispatch intact while letting us see the raw wire messages.
  const progressNotifications: Array<any> = []
  const installed = serverTransport.onmessage?.bind(serverTransport)
  serverTransport.onmessage = (message: any, extra: any) => {
    if (message?.method === "notifications/progress") progressNotifications.push(message)
    installed?.(message, extra)
  }
  return { client, server, samplingOutcomes, toolActive: () => active, progressNotifications }
}

/** Register production sampling handling on a client inside a live Instance. */
function wireSampling(
  client: ClientType,
  serverName = "fixture",
  livenessIntervalMs?: number,
  chunkTimeoutMs?: number,
) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const bridge = yield* EffectBridge.make()
      McpSampling.setActiveSession(client, SESSION)
      McpSampling.serve(serverName, client as never, bridge, livenessIntervalMs, chunkTimeoutMs)
    }),
  )
}

/** Poll the permission service until a sampling prompt is pending. */
async function waitForAsk() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const pending = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        return yield* permission.list()
      }),
    )
    const match = pending.find((item) => item.permission === "mcp_sampling")
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("no mcp_sampling permission request was raised")
}

/** Wait, bounded, for a client's sampling fibers to retire. */
async function drainInFlight(client: object) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (McpSampling.inFlightCount(client) === 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`sampling fibers never drained (${McpSampling.inFlightCount(client)} left)`)
}

function config(extra?: Record<string, unknown>) {
  return {
    $schema: "https://opencode.ai/config.json",
    provider: PROVIDERS,
    // `enabled_providers` is an ALLOWLIST: without it this machine's real
    // provider credentials autoload and sampling would pick a live model.
    enabled_providers: [PROVIDER_ID],
    model: `${PROVIDER_ID}/mimo-v2.5`,
    ...extra,
  }
}

async function withInstance(cfg: object, fn: () => Promise<void>) {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify(cfg))
    },
  })
  await Instance.provide({ directory: tmp.path, fn })
}

describe("harness integrity", () => {
  test("the SDK Client under test is the REAL one, not a sibling file's mock", () => {
    // Real Client extends Protocol and carries these; every test double in
    // test/mcp/ carries neither. If a module mock ever wins the load-order race,
    // this fails instead of letting the whole E2E pass against a stub.
    expect(typeof (Client.prototype as any).assertRequestHandlerCapability).toBe("function")
    expect(typeof (Client.prototype as any).ping).toBe("function")
    expect(typeof (Client.prototype as any).callTool).toBe("function")
  })
})

describe("MCP client-side sampling, end to end", () => {
  test("declares the sampling capability during initialize", async () => {
    const h = await harness({ text: "hi" })
    // What the SERVER observed on the wire, not what we passed in.
    expect(h.server.server.getClientCapabilities()).toMatchObject({ sampling: {} })
    // Not-yet-implemented sub-capabilities must stay undeclared.
    const capabilities = h.server.server.getClientCapabilities() as Record<string, any>
    expect(capabilities.sampling.tools).toBeUndefined()
    expect(capabilities.sampling.context).toBeUndefined()
    await h.client.close()
  })

  test("a 30s 16kHz mono WAV round-trips through a nested sampling request without deadlock", async () => {
    wire = stubProvider(TRANSCRIPT)
    const buffer = wav(30)
    const data = buffer.toString("base64")

    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const h = await harness({ audio: { data, mimeType: "audio/wav" }, hints: [{ name: "mimo-v2.5" }] })
      await wireSampling(h.client)

      const result = await h.client.callTool(
        { name: "transcribe_audio_fixture", arguments: {} },
        CallToolResultSchema,
        { timeout: 30_000 },
      )

      // 1. The tool completed, so neither direction blocked the other. This is
      //    the self-lock gate: the fixture tool only returns AFTER its own
      //    sampling request resolved, so a sampling path that waited on the
      //    outstanding tool call would circular-wait and time out here.
      expect(result.isError).toBeFalsy()
      expect((result.content as Array<{ text: string }>)[0].text).toBe(TRANSCRIPT)

      // 2. The server's own sampling call succeeded, with the model we selected.
      expect(h.samplingOutcomes).toHaveLength(1)
      expect(h.samplingOutcomes[0].ok).toBe(true)
      const detail = h.samplingOutcomes[0].detail as any
      expect(detail.model).toBe(`${PROVIDER_ID}/mimo-v2.5`)
      expect(detail.role).toBe("assistant")
      // Verbatim: exactly the provider's text, not a summary.
      expect(detail.content).toEqual({ type: "text", text: TRANSCRIPT })
      expect(detail.stopReason).toBe("endTurn")

      // 3. The WAV really reached the provider as audio, not as text.
      expect(wire!.bodies).toHaveLength(1)
      const parts = wire!.bodies[0].messages.at(-1).content
      expect(parts).toEqual([
        { type: "text", text: "Transcribe this audio verbatim." },
        { type: "input_audio", input_audio: { data, format: "wav" } },
      ])
      // 4. No credential rode along in the JSON-RPC payload the server saw.
      expect(JSON.stringify(detail)).not.toContain("test-key")
      expect(JSON.stringify(detail)).not.toContain("example.invalid")

      await h.client.close()
    })
  }, 60_000)

  // Pins the PRECONDITION for the deadlock coverage above, and is not itself a
  // deadlock proof: the SDK dispatches inbound requests from `onmessage` without
  // awaiting them (shared/protocol.js `_onrequest`), so "the request arrived
  // during the tool call" is guaranteed by the SDK and would pass for free. The
  // real self-lock coverage is the round-trip test above, which drives sampling
  // through the actual model-acquisition path to a returned CreateMessageResult
  // with the tool call still outstanding; making that path wait on the
  // outstanding tool call (a turn lock / serial prompt queue) times it out.
  test("the sampling request is served WHILE the tool call is still in flight", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      let activeDuringSampling: boolean | undefined
      const h = await harness({ text: "hi" })
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          McpSampling.setActiveSession(h.client, SESSION)
          // Wrap the production handler so we can observe tool-call state at the
          // moment the inbound request is dispatched. The handler itself is
          // production code; only the observation is added.
          const spy = {
            setRequestHandler: (schema: never, handler: never) => {
              h.client.setRequestHandler(schema, (async (request: any, extra: any) => {
                activeDuringSampling = h.toolActive()
                return (handler as any)(request, extra)
              }) as never)
            },
          }
          McpSampling.serve("fixture", spy as never, bridge)
        }),
      )

      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBeFalsy()
      // The proof: the fixture tool had NOT returned when we began sampling.
      expect(activeDuringSampling).toBe(true)
      await h.client.close()
    })
  }, 60_000)

  test("audio is refused when only text-capable models are configured, and never downgraded", async () => {
    wire = stubProvider(TRANSCRIPT)
    const data = wav(1).toString("base64")
    const textOnly = {
      ...config(),
      model: `${PROVIDER_ID}/mimo-text-only`,
      provider: {
        [PROVIDER_ID]: {
          ...PROVIDERS[PROVIDER_ID],
          models: { "mimo-text-only": PROVIDERS[PROVIDER_ID].models["mimo-text-only"] },
        },
      },
      mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } },
    }
    await withInstance(textOnly, async () => {
      const h = await harness({ audio: { data, mimeType: "audio/wav" } })
      await wireSampling(h.client)
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBe(true)
      expect(h.samplingOutcomes[0].ok).toBe(false)
      const detail = h.samplingOutcomes[0].detail as any
      expect(detail.code).toBe(-32602)
      expect(detail.message).toMatch(/no configured model can accept/)
      // The structured error names the model and the reason.
      expect(detail.data.rejected).toEqual([
        { model: `${PROVIDER_ID}/mimo-text-only`, reason: "does not accept audio input" },
      ])
      expect(detail.data.required).toContainEqual({ modality: "audio", mimeType: "audio/wav", bytes: 32044 })
      // Nothing was sent to any provider: no silent downgrade to a text call.
      expect(wire!.bodies).toHaveLength(0)
      await h.client.close()
    })
  }, 60_000)

  /**
   * The OTHER fail-closed branch: the adapter's audio support is `unknown`, not
   * known-absent. The test above exercises `unsupported`; nothing exercised
   * `unknown` past the registry's own leaf function.
   *
   * `@ai-sdk/mistral` is bundled (so this stays offline and installs nothing) and
   * carries no entry in the registry's adapter table — exactly the shape of a
   * provider added after that table was written. The model itself declares audio
   * input, so the MODEL gate passes and only the adapter verdict can refuse.
   */
  test("audio is refused when the only audio-declaring model's adapter support is UNKNOWN", async () => {
    wire = stubProvider(TRANSCRIPT)
    const data = wav(1).toString("base64")
    const UNDECLARED_ID = "undeclaredfixture"
    await withInstance(
      config({
        provider: {
          [UNDECLARED_ID]: {
            name: "Undeclared Adapter Fixture",
            npm: "@ai-sdk/mistral",
            env: [],
            api: "https://example.invalid/v1",
            options: { apiKey: "test-key", baseURL: "https://example.invalid/v1" },
            models: {
              "sonic-1": {
                name: "Sonic 1",
                tool_call: true,
                modalities: { input: ["text", "audio"], output: ["text"] },
                limit: { context: 128_000, output: 8_000 },
              },
            },
          },
        },
        enabled_providers: [UNDECLARED_ID],
        model: `${UNDECLARED_ID}/sonic-1`,
        mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } },
      }),
      async () => {
        const h = await harness({ audio: { data, mimeType: "audio/wav" } })
        await wireSampling(h.client)
        const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
          timeout: 30_000,
        })
        expect(result.isError).toBe(true)
        expect(h.samplingOutcomes[0].ok).toBe(false)
        const detail = h.samplingOutcomes[0].detail as any
        expect(detail.code).toBe(-32602)
        expect(detail.message).toMatch(/no configured model can accept/)
        // "has no declared" — NOT "does not accept". An operator can tell an
        // unproven adapter from a disproven one.
        expect(detail.data.rejected).toEqual([
          { model: `${UNDECLARED_ID}/sonic-1`, reason: "has no declared audio support" },
        ])
        // The unproven adapter was not "tried anyway": no request was built, and
        // the bundled Mistral adapter was never even loaded.
        expect(wire!.bodies).toHaveLength(0)
        await h.client.close()
      },
    )
  }, 60_000)

  test("policy deny refuses before any model or provider work", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "deny" } } }), async () => {
      const h = await harness({ text: "hi" })
      await wireSampling(h.client)
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBe(true)
      const detail = h.samplingOutcomes[0].detail as any
      expect(detail.code).toBe(-1)
      expect(detail.message).toMatch(/denied/)
      expect(wire!.bodies).toHaveLength(0)
      await h.client.close()
    })
  }, 60_000)

  /**
   * This test USED to drive its rejection with `permission.mcp_sampling: "deny"`
   * and assert the "user declined" message. That conflated two different refusals,
   * and a ruleset deny is now refused up front (next test) precisely so that
   * `mcp.<server>.sampling: "allow"` cannot bury it — so that config no longer
   * reaches a prompt and no longer produces "declined". The genuine human
   * rejection it never covered is now its own test, below.
   */
  test("policy ask requires approval: no provider call happens until it is answered", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"] } } }), async () => {
      const h = await harness({ text: "hi" })
      await wireSampling(h.client)
      const pending = h.client
        .callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, { timeout: 30_000 })
        .catch(() => undefined)
      const request = await waitForAsk()
      expect(request.permission).toBe("mcp_sampling")
      expect(request.patterns).toEqual(["fixture"])
      // Gated BEHIND the approval, not merely reported after it.
      expect(wire!.bodies).toHaveLength(0)
      expect(McpSampling.inFlightCount(h.client)).toBe(1)
      await AppRuntime.runPromise(McpSampling.cancelAll(h.client))
      await h.client.close()
      await pending
    })
  }, 60_000)

  /**
   * THE GENUINE HUMAN REJECTION — `permission.reply({ reply: "reject" })` against a
   * prompt that was actually raised. Distinct from every "deny" test around it:
   * those refuse before a prompt exists, so they never exercise the approval
   * Deferred at all, and the `-1` declined error in `handle` was therefore
   * unreachable in practice.
   *
   * It was unreachable for a reason, which is what this test pins. `Permission.ask`
   * races the approval Deferred against the caller's `abortSignal`, and sampling
   * always passes `extra.signal`. `Effect.race` resolves with the first *success*
   * and treats a failure as "not a winner"; a rejection FAILS the Deferred and the
   * abort side never settles on its own, so the ask parked forever. `raceFirst`
   * (first side to *complete*, success or failure) is the fix.
   *
   * THERE IS NO LONGER A BOUND TO INJECT AS A SAFETY NET, and that changes what
   * catches a regression rather than whether one is caught. The total bound this
   * test used to set to 8 s is gone (see the deadlines block), so a regression that
   * re-parks the ask now hangs until Bun's own 60 s test timeout instead of being
   * reaped at 8 s with "sampling timed out". Slower, still a FAILURE and never a
   * pass — and the promptness assertion below is unchanged, so the property proven
   * is the same one.
   */
  test("a human rejection answers the server with the declined error and drains the fiber", async () => {
    // The ceiling the answer must beat. Previously expressed as half the injected
    // bound; kept at the same absolute value now that no bound is injected.
    const PROMPT_CEILING = 4_000
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"] } } }), async () => {
      const h = await harness({ text: "hi" })
      await wireSampling(h.client)
      const pending = h.client
        .callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, { timeout: 30_000 })
        .catch(() => undefined)
      const request = await waitForAsk()
      expect(McpSampling.inFlightCount(h.client)).toBe(1)

      const rejectedAt = Date.now()
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          yield* permission.reply({ requestID: request.id, reply: "reject" })
        }),
      )

      // THE SYMPTOM, not the bookkeeping: the server's own sampling request must
      // come back answered. Before the fix it came back with nothing at all.
      for (let attempt = 0; attempt < 400 && h.samplingOutcomes.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(h.samplingOutcomes).toHaveLength(1)
      expect(h.samplingOutcomes[0].ok).toBe(false)
      const detail = h.samplingOutcomes[0].detail as any
      // `-1` + "declined" + `data.server`, all three: our request-timeout error
      // and the SDK's own both use -32001 and both carry `data.timeout`, so code
      // alone cannot tell a declined answer from a reaped one.
      expect(detail.code).toBe(-1)
      expect(String(detail.message)).toMatch(/declined/)
      expect(detail.data).toMatchObject({ server: "fixture" })
      // Answered by the rejection, not by anything expiring.
      expect(Date.now() - rejectedAt).toBeLessThan(PROMPT_CEILING)
      // A refusal never reaches a model.
      expect(wire!.bodies).toHaveLength(0)
      // Polled, not synchronous: the server's request settles when our JSON-RPC
      // error is written, which is not ordered against `serve`'s finally block.
      await drainInFlight(h.client)
      expect(McpSampling.inFlightCount(h.client)).toBe(0)
      await h.client.close()
      await pending
    })
  }, 60_000)

  /**
   * THE MIRROR CASE, so the fix cannot buy the rejection path at the cost of
   * promptness on a real abort. A server-issued cancellation aborts `extra.signal`
   * while the prompt is still pending; the ask must abandon it immediately, not sit
   * there until an outer bound reaps it.
   *
   * This one passes both before and after the fix and is a REGRESSION GUARD, not a
   * reproducer — stated plainly because the two are not the same evidence. Under
   * `race` an abort happened to work only because it fails BOTH sides (the callback
   * resumes with a failure *and* it fails the Deferred), and `race` does surface a
   * failure once every side has failed. The rejection path failed only one side,
   * which is the whole asymmetry. A fix that bought the rejection path by dropping
   * the abort composition would still satisfy the existing cancellation test, which
   * polls for the outcome and so tolerates arriving at the bound; this does not.
   *
   * The promptness ceiling is 5 s and there is now NO outer bound at all — the
   * approval wait is unbounded by design, so the only alternative to the abort path
   * is hanging until Bun's 60 s test timeout. That makes this assertion strictly
   * harder to satisfy by accident than when a 20 s bound stood behind it.
   */
  test("an abort while the prompt is pending abandons it promptly, not by expiring", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"] } } }), async () => {
      const h = await harness({ text: "hi", cancelAfterAsk: true })
      await wireSampling(h.client)
      const startedAt = Date.now()
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBe(true)
      expect(h.samplingOutcomes).toHaveLength(1)
      expect(h.samplingOutcomes[0].ok).toBe(false)
      // The abort answered it, and nothing else could have: the approval wait has no
      // bound, so a regression that lost the abort composition would hang instead.
      expect(Date.now() - startedAt).toBeLessThan(5_000)
      expect(wire!.bodies).toHaveLength(0)
      await drainInFlight(h.client)
      expect(McpSampling.inFlightCount(h.client)).toBe(0)
      await h.client.close()
    })
  }, 60_000)

  test("a permission ruleset deny under policy ask refuses without ever prompting", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(
      config({
        mcp: { fixture: { type: "local", command: ["true"] } },
        permission: { mcp_sampling: "deny" },
      }),
      async () => {
        const h = await harness({ text: "hi" })
        await wireSampling(h.client)
        const result = await h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )
        expect(result.isError).toBe(true)
        const detail = h.samplingOutcomes[0].detail as any
        expect(detail.code).toBe(-1)
        expect(detail.message).toMatch(/denied/)
        // A deny is a refusal, not a human declining a prompt that was raised.
        expect(detail.data).toMatchObject({ server: "fixture", deniedBy: "permission.mcp_sampling" })
        const prompts = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const permission = yield* Permission.Service
            return yield* permission.list()
          }),
        )
        expect(prompts.filter((item) => item.permission === "mcp_sampling")).toHaveLength(0)
        expect(wire!.bodies).toHaveLength(0)
        await h.client.close()
      },
    )
  }, 60_000)

  test("policy ask proceeds when the user approves", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(
      config({
        mcp: { fixture: { type: "local", command: ["true"] } },
        permission: { mcp_sampling: "allow" },
      }),
      async () => {
        const h = await harness({ text: "hi" })
        await wireSampling(h.client)
        const result = await h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )
        expect(result.isError).toBeFalsy()
        expect(h.samplingOutcomes[0].ok).toBe(true)
        await h.client.close()
      },
    )
  }, 60_000)

  test("concurrent sampling requests all complete", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const h = await harness({ text: "hi" })
      await wireSampling(h.client)
      const results = await Promise.all(
        [0, 1, 2, 3].map(() =>
          h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
            timeout: 30_000,
          }),
        ),
      )
      for (const result of results) expect(result.isError).toBeFalsy()
      expect(h.samplingOutcomes).toHaveLength(4)
      expect(h.samplingOutcomes.every((item) => item.ok)).toBe(true)
      // Every fiber was retired from the in-flight set.
      expect(McpSampling.inFlightCount(h.client)).toBe(0)
      await h.client.close()
    })
  }, 60_000)

  test("an oversize audio payload is refused with a structured error", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      // 4 base64 chars per 3 bytes; ask for one byte past the cap.
      const bytes = 20 * 1024 * 1024 + 3
      const data = "A".repeat(Math.ceil(bytes / 3) * 4)
      const h = await harness({ audio: { data, mimeType: "audio/wav" } })
      await wireSampling(h.client)
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBe(true)
      const detail = h.samplingOutcomes[0].detail as any
      expect(detail.code).toBe(-32602)
      // Both configured models are rejected, for DIFFERENT reasons: the
      // text-only one cannot take audio at all, the audio-capable one is over
      // the size cap. Assert the size verdict on the model it applies to.
      const audioCapable = detail.data.rejected.find((item: any) => item.model === `${PROVIDER_ID}/mimo-v2.5`)
      expect(audioCapable.reason).toMatch(/over the .* byte limit for audio/)
      expect(wire!.bodies).toHaveLength(0)
      await h.client.close()
    })
  }, 60_000)

  // The SDK validates AudioContent.data against its own Base64 refinement while
  // parsing the inbound request, so a malformed payload is refused at the protocol
  // boundary and never reaches our handler. Our own base64 check (asserted in
  // sampling.test.ts) is the defence-in-depth layer behind it.
  test("invalid base64 audio is refused at the protocol boundary, before any model work", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const h = await harness({ audio: { data: "!!!not-base64!!!", mimeType: "audio/wav" } })
      await wireSampling(h.client)
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBe(true)
      const detail = h.samplingOutcomes[0].detail as any
      expect(detail.message).toMatch(/Invalid Base64 string/)
      // Nothing reached a provider.
      expect(wire!.bodies).toHaveLength(0)
      await h.client.close()
    })
  }, 60_000)

  test("a cancelled sampling request is answered with a cancellation error, not left hanging", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"] } } }), async () => {
      // Policy defaults to ask, so the request parks on human approval — a
      // deterministic point at which to cancel it.
      const h = await harness({ text: "hi", cancelAfterAsk: true })
      await wireSampling(h.client)
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBe(true)
      expect(h.samplingOutcomes).toHaveLength(1)
      expect(h.samplingOutcomes[0].ok).toBe(false)
      // The server's own request settled rather than hanging to its timeout.
      const detail = h.samplingOutcomes[0].detail as any
      expect(String(detail.message)).toMatch(/cancel/i)
      // No model call was ever made.
      expect(wire!.bodies).toHaveLength(0)
      // The fiber drains. This is polled, not asserted synchronously: the
      // server's request rejects on its own abort immediately, while our side
      // only unwinds once `notifications/cancelled` arrives and aborts the
      // handler's signal, so the two are not ordered.
      await drainInFlight(h.client)
      await h.client.close()
    })
  }, 60_000)

  /**
   * THE SILENCE BOUND, and the reaping it is responsible for. Cancellation (above)
   * was the only exercised exit from a parked request; this exit was implemented and
   * untested. It matters more than a redundant second exit, because the upstream SDK
   * drops a cancellation whose JSON-RPC id is 0 (pinned in the last describe block of
   * this file), which makes this the ONLY thing that reaps the first server-initiated
   * sampling request of a connection when the server abandons it.
   *
   * IT USED TO BE THE TOTAL BOUND THAT DID THIS REAPING, and the rename in this test
   * is not cosmetic: the total bound is gone, so what now catches a provider that
   * never answers is the stall detector, and the error it produces names
   * `phase: "stall"` and reports how much output arrived. That last field is the part
   * a total bound could never have supplied — `chunks: 0` says the provider never
   * produced anything, which is precisely the distinction this exit exists to draw.
   *
   * The bound is INJECTED (1 s) because a test cannot wait out the inherited 8
   * minutes. Production passes nothing and takes the provider's own `chunkTimeout`;
   * that the inherited value is genuinely what applies is proven separately by the
   * config test in the deadlines block, which injects nothing at all.
   */
  test("a provider that never responds is reaped at the silence bound and leaves the in-flight set", async () => {
    const BOUND = 1_000
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      // Warm the provider and the bundled adapter on a client with the DEFAULT
      // bound, so the tight bound below is spent waiting on the provider rather
      // than racing a cold module load.
      const warm = stubProvider(TRANSCRIPT)
      try {
        const first = await harness({ text: "hi" })
        await wireSampling(first.client)
        const ok = await first.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
          timeout: 30_000,
        })
        expect(ok.isError).toBeFalsy()
        await first.client.close()
      } finally {
        warm.restore()
      }

      const hang = stubProviderHang()
      wire = hang
      try {
        const h = await harness({ text: "hi" })
        await wireSampling(h.client, "fixture", undefined, BOUND)
        const result = await h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          // Far longer than BOUND. If OUR bound stopped firing, the SDK's own
          // request timeout would fire here instead — a different error, which the
          // assertions below reject by name rather than by "something timed out".
          { timeout: 20_000 },
        )
        expect(result.isError).toBe(true)
        expect(h.samplingOutcomes).toHaveLength(1)
        expect(h.samplingOutcomes[0].ok).toBe(false)

        const detail = h.samplingOutcomes[0].detail as any
        expect(detail.code).toBe(McpSampling.TIMEOUT_CODE)
        // OURS: the SDK's own timeout says "Request timed out" and carries no
        // `server`, so this pair cannot be satisfied by the SDK's error.
        expect(String(detail.message)).toMatch(/sampling stalled: the model produced no output/)
        expect(detail.data).toMatchObject({ server: "fixture", phase: "stall", timeout: BOUND })
        // NEVER STARTED, not "started and went quiet" — the distinction the removed
        // total bound could not express.
        expect(detail.data.chunks).toBe(0)

        // The model call was genuinely started and then abandoned mid-flight —
        // this is the expiry path, not a pre-flight refusal.
        expect(hang.bodies).toHaveLength(1)

        // THE BOUND MUST REACH THE PROVIDER, not just our own waiting. Interrupting
        // the call fiber does NOT by itself cancel a promise already in flight, so
        // without the abort composition in `handle` the HTTP call would run to
        // completion after we gave up on it — exactly the leak this asserts against.
        // Observed on the signal the provider was handed, so it cannot be satisfied
        // by our own bookkeeping.
        expect(hang.signals).toHaveLength(1)
        expect(hang.signals[0]).toBeInstanceOf(AbortSignal)
        expect(hang.signals[0]!.aborted).toBe(true)

        // THE POINT OF THE GAP: the expired fiber is removed from the in-flight
        // set. `serve`'s finally block runs before the JSON-RPC error is written,
        // so this is asserted SYNCHRONOUSLY; polling would also pass while a leak
        // drained on its own.
        expect(McpSampling.inFlightCount(h.client)).toBe(0)
        await h.client.close()
      } finally {
        hang.release()
      }
    })
  }, 60_000)

  test("cancelAll interrupts sampling still in flight so the server stops waiting", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"] } } }), async () => {
      const h = await harness({ text: "hi" })
      await wireSampling(h.client)
      const pending = h.client
        .callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, { timeout: 30_000 })
        .catch(() => undefined)
      // Park on the approval prompt, then tear the sampling work down underneath
      // it — the client-exit path src/mcp/index.ts runs from closeClient.
      await waitForAsk()
      expect(McpSampling.inFlightCount(h.client)).toBe(1)
      await AppRuntime.runPromise(McpSampling.cancelAll(h.client))

      // The OUTCOME, not the bookkeeping: the server's own sampling request must
      // settle with an error. Asserting only that inFlightCount dropped to 0
      // would pass even if the interrupt were a no-op, because cancelAll clears
      // its tracking set either way.
      for (let attempt = 0; attempt < 200 && h.samplingOutcomes.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(h.samplingOutcomes).toHaveLength(1)
      expect(h.samplingOutcomes[0].ok).toBe(false)
      // The interrupted request never reached a provider.
      expect(wire!.bodies).toHaveLength(0)
      await h.client.close()
      await pending
    })
  }, 60_000)

  /**
   * The case the test above cannot cover: `cancelAll` while the request is parked
   * on the PROVIDER rather than on the approval prompt. `Fiber.interrupt` stops our
   * fiber, but a promise already in flight inside it keeps running unless something
   * aborts it — so without the abort composition in `handle` this teardown would
   * leave a live model call behind with no owner. `sampling: "allow"` removes the
   * prompt so the request is guaranteed to be inside `generateText` when cancelled.
   */
  test("cancelAll aborts a provider call already in flight", async () => {
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const hang = stubProviderHang()
      wire = hang
      try {
        const h = await harness({ text: "hi" })
        await wireSampling(h.client)
        const pending = h.client
          .callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, { timeout: 30_000 })
          .catch(() => undefined)

        // Park INSIDE the provider call, not before it.
        for (let attempt = 0; attempt < 400 && hang.bodies.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(hang.bodies).toHaveLength(1)
        expect(hang.signals[0]).toBeInstanceOf(AbortSignal)
        // Not yet aborted: proves the assertion below observes the cancellation
        // rather than a signal that was already aborted for some other reason.
        expect(hang.signals[0]!.aborted).toBe(false)
        expect(McpSampling.inFlightCount(h.client)).toBe(1)

        await AppRuntime.runPromise(McpSampling.cancelAll(h.client))

        // THE OUTCOME AT THE PROVIDER: the HTTP call was aborted, so no orphaned
        // model call outlives the client that owned it.
        for (let attempt = 0; attempt < 200 && !hang.signals[0]!.aborted; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(hang.signals[0]!.aborted).toBe(true)

        // And the server still gets an answer instead of hanging to its own timeout.
        for (let attempt = 0; attempt < 200 && h.samplingOutcomes.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(h.samplingOutcomes).toHaveLength(1)
        expect(h.samplingOutcomes[0].ok).toBe(false)
        expect(McpSampling.inFlightCount(h.client)).toBe(0)
        await h.client.close()
        await pending
      } finally {
        hang.release()
      }
    })
  }, 60_000)

  /**
   * FAIL-OPEN GUARD. `mcp.<server>.sampling: "allow"` skips the approval prompt, so
   * an explicit `permission.mcp_sampling` deny is never seen by `permission.ask` at
   * all. Unless `handle` evaluates the ruleset itself, the deny is silently
   * discarded and the model runs — a security control that reads as configured and
   * does nothing.
   */
  test("an explicit permission deny wins over mcp.<server>.sampling allow", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(
      config({
        mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } },
        permission: { mcp_sampling: { "*": "allow", fixture: "deny" } },
      }),
      async () => {
        const h = await harness({ text: "hi" })
        await wireSampling(h.client)
        const result = await h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )
        expect(result.isError).toBe(true)
        expect(h.samplingOutcomes).toHaveLength(1)
        expect(h.samplingOutcomes[0].ok).toBe(false)
        const detail = h.samplingOutcomes[0].detail as any
        expect(detail.code).toBe(McpSampling.REJECTED_CODE)
        expect(String(detail.message)).toMatch(/sampling is denied/)
        // Names WHICH control refused, so this cannot be satisfied by the
        // pre-existing `mcp.<server>.sampling: "deny"` branch.
        expect(detail.data).toMatchObject({ server: "fixture", deniedBy: "permission.mcp_sampling" })
        // Refused before any model work, not after.
        expect(wire!.bodies).toHaveLength(0)
        expect(McpSampling.inFlightCount(h.client)).toBe(0)
        await h.client.close()
      },
    )
  }, 60_000)

  test("a server that never samples keeps working unchanged", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const server = new McpServer({ name: "plain", version: "1.0.0" })
      server.registerTool("echo", { description: "echo", inputSchema: { value: z.string() } }, async (args) => ({
        content: [{ type: "text", text: String((args as { value: string }).value) }],
      }))
      const client = new Client({ name: "mimocode", version: "test" }, MCP.CLIENT_OPTIONS)
      const [a, b] = InMemoryTransport.createLinkedPair()
      await Promise.all([client.connect(a), server.server.connect(b)])
      await wireSampling(client, "plain")
      const result = await client.callTool({ name: "echo", arguments: { value: "unchanged" } }, CallToolResultSchema)
      expect((result.content as Array<{ text: string }>)[0].text).toBe("unchanged")
      expect(wire!.bodies).toHaveLength(0)
      await client.close()
    })
  }, 60_000)
})

/**
 * DEADLINES AND KEEPALIVE.
 *
 * One wall-clock bound used to wrap a human decision and a machine call together,
 * and nothing kept the counterparty's own timer alive. These tests pin the symptoms
 * of that, not the bookkeeping around it.
 *
 * WHAT IS LEFT TO BOUND, after three invented bounds were removed: only SILENCE
 * FROM THE PROVIDER, and its value is the provider layer's own `chunkTimeout`
 * rather than a number sampling picked. There is no total bound and no approval
 * bound, so two of the expiries these tests used to distinguish no longer exist.
 *
 * THE SILENCE BOUND IS INJECTED HERE so the suite runs in CI time. That is a
 * property of the tests, not of the proofs: production passes nothing and inherits
 * `DEFAULT_CHUNK_TIMEOUT` (8 minutes), or whatever the operator configured for that
 * provider. Sub-second bounds prove the MECHANISM, never that a production value is
 * right; the inherited value is pinned separately by a constant assertion, and no
 * test that finishes in seconds also waits out eight minutes.
 */
describe("sampling deadlines and liveness", () => {
  test("a liveness notification is emitted while the model call is in flight", async () => {
    // 400 ms beats inside a 2.5 s silence bound: several land, and the count is
    // asserted as a floor so a slow CI box cannot fail it.
    const CHUNK_BOUND = 2_500
    const INTERVAL = 400
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const warm = stubProvider(TRANSCRIPT)
      try {
        const first = await harness({ text: "hi" })
        await wireSampling(first.client)
        await first.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
          timeout: 30_000,
        })
        await first.client.close()
      } finally {
        warm.restore()
      }

      const hang = stubProviderHang()
      wire = hang
      try {
        const seen: Array<any> = []
        const h = await harness({
          text: "hi",
          // The server OPTS IN. This is what makes the SDK mint a token at all.
          onprogress: (progress) => seen.push(progress),
          // Generous, so the server's own timer is not what ends this.
          requestTimeout: 30_000,
        })
        await wireSampling(h.client, "fixture", INTERVAL, CHUNK_BOUND)
        const result = await h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )
        expect(result.isError).toBe(true)

        // THE SYMPTOM: notifications genuinely crossed the wire. Observed on the
        // server's transport, so our own counters cannot satisfy this.
        expect(h.progressNotifications.length).toBeGreaterThanOrEqual(2)
        // And the server's own handler ran, i.e. the token we echoed back matched
        // the one it minted — an unmatched token lands in `_onprogress`'s
        // "unknown token" error branch instead.
        expect(seen.length).toBeGreaterThanOrEqual(2)

        const first = h.progressNotifications[0].params
        // THE FALSY-ZERO TRAP, guarded on purpose: this is the first
        // server-initiated request of the connection, so its message id — and
        // therefore its progress token — is `0`. The SDK's own cancel path drops
        // `requestId` 0 for exactly this reason; our token check must test for
        // `undefined`, not for truthiness.
        expect(first.progressToken).toBe(0)
        // LIVENESS FROM EVIDENCE: a monotonic tick and NO `total`, because
        // streaming still cannot say how many chunks are coming, so no fraction is
        // computable and none is implied. The message reports what was OBSERVED —
        // and this provider answered nothing at all, so it must say so rather than
        // claim output. `chunks === 0` is the distinction the whole signal exists
        // for; counting the SDK's own `start` part would have reported "1 chunk"
        // for this stone-dead call.
        expect(first.progress).toBe(1)
        expect(first.total).toBeUndefined()
        expect(String(first.message)).toMatch(/no output yet/)
        expect(String(first.message)).not.toMatch(/streaming/)
        // And no model text rode along on the progress channel. Nothing was
        // produced here, but the assertion is about the CHANNEL, not this call:
        // partial content is deliberately never sent — see `heartbeat`.
        for (const notification of h.progressNotifications) {
          expect(String(notification.params.message)).not.toMatch(/quick brown fox/)
        }
        const ticks = h.progressNotifications.map((n) => n.params.progress)
        expect(ticks).toEqual([...ticks].sort((a, b) => a - b))
        expect(new Set(ticks).size).toBe(ticks.length)

        // AND IT CANNOT MASK A HUNG CALL. Beats went out the whole time and the
        // silence bound still fired: the notifications reset the PEER's timer, never
        // ours. Asserted on the error the server actually received. `phase: "stall"`
        // is now the ONLY expiry a model call can produce — `"model"` and `"total"`
        // were removed with their bounds.
        const detail = h.samplingOutcomes[0].detail as any
        expect(detail.code).toBe(McpSampling.TIMEOUT_CODE)
        expect(detail.data).toMatchObject({ server: "fixture", phase: "stall", timeout: CHUNK_BOUND })
        expect(hang.signals[0]!.aborted).toBe(true)
        await h.client.close()
      } finally {
        hang.release()
        hang.restore()
      }
    })
  }, 60_000)

  test("no liveness notification is emitted when the server supplied no progress token", async () => {
    const CHUNK_BOUND = 1_500
    const INTERVAL = 200
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const warm = stubProvider(TRANSCRIPT)
      try {
        const first = await harness({ text: "hi" })
        await wireSampling(first.client)
        await first.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
          timeout: 30_000,
        })
        await first.client.close()
      } finally {
        warm.restore()
      }

      const hang = stubProviderHang()
      wire = hang
      try {
        // NO `onprogress`, so no `_meta.progressToken` exists on the request.
        const h = await harness({ text: "hi", requestTimeout: 30_000 })
        // Interval far below the bound, so "nothing was sent" is a real absence
        // and not simply a window too short for the first beat to fall in.
        await wireSampling(h.client, "fixture", INTERVAL, CHUNK_BOUND)
        const errors: Array<unknown> = []
        h.server.server.onerror = (error) => errors.push(error)
        const result = await h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )
        expect(result.isError).toBe(true)
        // The model call really did run long enough for many beats to have fired
        // had we been sending any.
        expect(hang.bodies).toHaveLength(1)
        expect(h.progressNotifications).toHaveLength(0)
        // A notification sent against a token the peer never minted is not merely
        // wasted: `_onprogress` reports it to the peer as an error. Nothing did.
        expect(errors).toHaveLength(0)
        await h.client.close()
      } finally {
        hang.release()
        hang.restore()
      }
    })
  }, 60_000)

  test("an unanswered approval is NOT timed out: the prompt stays pending and a late answer still succeeds", async () => {
    // THE BOUND THIS REPLACES. A 30 s wall-clock bound used to end the approval
    // wait and report `phase: "approval"`. `permission/index.ts` has no such bound
    // for an ordinary interactive ask — only a FORWARDED ask
    // (FORWARD_DENY_TIMEOUT_MS) and a skip-all forced ask are bounded, and this ask
    // is neither — so a TUI prompt waits indefinitely while sampling gave up.
    //
    // PROVING AN ABSENCE needs a positive observation, not a longer wait: the
    // request must still be ALIVE after a stretch in which the old bound (had it
    // been injectable, which it no longer is) would have killed it, and it must
    // still be answerable. Both halves are asserted, so a machine that somehow
    // resolved the prompt early fails the test rather than proving less.
    const PENDING_WINDOW = 1_800
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"] } } }), async () => {
      wire = stubProvider(TRANSCRIPT)
      // Generous peer timeout: the SERVER's own timer must not be what ends this,
      // or the test would be measuring the SDK rather than us.
      const h = await harness({ text: "hi", requestTimeout: 30_000 })
      await wireSampling(h.client)
      const call = h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      const ask = await waitForAsk()

      // Deliberately answer NOTHING for a window several times the poll interval
      // and well past the old 30 s bound's shape at test scale.
      await new Promise((resolve) => setTimeout(resolve, PENDING_WINDOW))

      // STILL PENDING, and the model was never charged for the wait.
      const stillPending = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          return yield* permission.list()
        }),
      )
      expect(stillPending.some((item) => item.id === ask.id)).toBe(true)
      expect(McpSampling.inFlightCount(h.client)).toBe(1)
      expect((wire as Wire).bodies).toHaveLength(0)
      // No error reached the server: nothing expired.
      expect(h.samplingOutcomes).toHaveLength(0)

      // A LATE ANSWER STILL WORKS. Under the old bound this reply arrived after the
      // request had already been failed, so the transcript below could not exist.
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          yield* permission.reply({ requestID: ask.id, reply: "once" })
        }),
      )
      const result = await call
      expect(result.isError).toBeFalsy()
      expect((result.content as Array<{ text: string }>)[0].text).toBe(TRANSCRIPT)
      expect(h.samplingOutcomes[0].ok).toBe(true)
      expect((wire as Wire).bodies).toHaveLength(1)
      await h.client.close()
    })
  }, 90_000)

  test("a per-provider chunkTimeout from mimocode.json is what bounds a silent sampling call", async () => {
    // THE REUSE, END TO END AND WITHOUT AN INJECTED PARAMETER. `wireSampling` passes
    // no bound here, so the value can only have come from the operator's provider
    // config — the same `chunkTimeout` key `provider.ts` reads for the main chat
    // path. That is the whole point of deleting DEFAULT_SAMPLING_STALL_TIMEOUT: one
    // knob, one value, no second number to drift.
    const CONFIGURED = 700
    const cfg = config({
      mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } },
      provider: {
        [PROVIDER_ID]: {
          ...PROVIDERS[PROVIDER_ID],
          options: { ...PROVIDERS[PROVIDER_ID].options, chunkTimeout: CONFIGURED },
        },
      },
    })
    await withInstance(cfg, async () => {
      const warm = stubProvider(TRANSCRIPT)
      try {
        const first = await harness({ text: "hi" })
        await wireSampling(first.client)
        await first.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
          timeout: 30_000,
        })
        await first.client.close()
      } finally {
        warm.restore()
      }
      const hang = stubProviderHang()
      wire = hang
      try {
        const h = await harness({ text: "hi", requestTimeout: 30_000 })
        // NO bound injected — production wiring exactly.
        await wireSampling(h.client)
        const result = await h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )
        expect(result.isError).toBe(true)
        // THE CONFIGURED VALUE IS THE ONE REPORTED. Had sampling kept its own
        // default this would read 45_000; had it ignored config it would read
        // 480_000 and this test would have timed out instead.
        const detail = h.samplingOutcomes[0].detail as any
        expect(detail.code).toBe(McpSampling.TIMEOUT_CODE)
        expect(detail.data).toMatchObject({ server: "fixture", phase: "stall", timeout: CONFIGURED })
        expect(hang.bodies).toHaveLength(1)
        expect(hang.signals[0]!.aborted).toBe(true)
        await h.client.close()
      } finally {
        hang.release()
        hang.restore()
      }
    })
  }, 60_000)

  test("a chunk timeout of 0 disables the silence bound instead of firing instantly", async () => {
    // `provider.ts` treats 0 as "install no bound" (it creates no AbortController;
    // its comment says "incl. 0 / negative to disable"). Sampling has to mean the
    // same thing by it, and the failure mode if it does not is severe rather than
    // cosmetic: `stallWatch` with `stallMs = 0` satisfies `Date.now() - lastAt >= 0`
    // on its first poll, so a 0 arriving here would kill every sampling call
    // immediately instead of removing a bound.
    //
    // ⚠️0 IS INJECTED RATHER THAN CONFIGURED, and that is a finding rather than a
    // convenience. `chunkTimeout` is declared `PositiveInt`
    // (`config/provider.ts:5,111`, i.e. `isGreaterThan(0)`), so `chunkTimeout: 0` is
    // REJECTED BY THE CONFIG SCHEMA and no operator can write it in mimocode.json —
    // which makes provider.ts's own "0 / negative to disable" affordance unreachable
    // from config too. Measured, not assumed: configuring 0 here made the provider
    // unresolvable and no HTTP call went out at all. So this guards the value
    // arriving through the parameter, which is the only route that exists.
    const ALIVE_WINDOW = 1_200
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const warm = stubProvider(TRANSCRIPT)
      try {
        const first = await harness({ text: "hi" })
        await wireSampling(first.client)
        await first.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
          timeout: 30_000,
        })
        await first.client.close()
      } finally {
        warm.restore()
      }
      const hang = stubProviderHang()
      wire = hang
      try {
        const h = await harness({ text: "hi", requestTimeout: 30_000 })
        await wireSampling(h.client, "fixture", undefined, 0)
        const call = h.client
          .callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, { timeout: 30_000 })
          .catch(() => undefined)
        await new Promise((resolve) => setTimeout(resolve, ALIVE_WINDOW))
        // The provider call went out and is STILL RUNNING: no bound was installed.
        // With a `stallMs = 0` watcher this would have been aborted on the first poll,
        // ~25 ms in, and `samplingOutcomes` would already hold a stall error.
        expect(hang.bodies).toHaveLength(1)
        expect(hang.signals[0]!.aborted).toBe(false)
        expect(McpSampling.inFlightCount(h.client)).toBe(1)
        expect(h.samplingOutcomes).toHaveLength(0)
        // Let it finish so the tool call settles rather than leaking a promise.
        hang.release()
        await call
        await h.client.close()
      } finally {
        hang.release()
        hang.restore()
      }
    })
  }, 60_000)

  // ⚠️THIS TEST IS A CHANGE-DETECTOR, NOT A PROOF OF BEHAVIOUR, and it is labelled
  // as such rather than counted as coverage: every assertion below compares a
  // constant against another constant or a literal, so the only way to make it fail
  // is to edit what it pins. Nothing here exercises a code path, and no revert probe
  // exists for it because there is no mechanism to revert. What it guards is the one
  // thing a comment cannot: that the silence bound does not quietly become a second
  // number again, and that the three deleted bounds do not come back.
  test("the liveness interval is sampling's only self-chosen number, and the silence bound is the provider's", () => {
    expect(McpSampling.DEFAULT_LIVENESS_INTERVAL).toBe(15_000)
    // Several beats must fit inside one peer timeout window (the SDK's 60 s
    // DEFAULT_REQUEST_TIMEOUT_MSEC). That is now the whole of this number's job: it
    // used to be justified against the stall bound as well, and that ratio is void.
    expect(McpSampling.DEFAULT_LIVENESS_INTERVAL * 3).toBeLessThan(60_000)

    // THE SAME VALUE, NOT A SECOND NUMBER. With nothing configured and nothing
    // injected, sampling's silence bound IS the provider layer's, so the two cannot
    // drift apart the way 45 s and 480 s had.
    expect(McpSampling.chunkTimeoutFor({}, PROVIDER_ID)).toBe(DEFAULT_CHUNK_TIMEOUT)
    expect(DEFAULT_CHUNK_TIMEOUT).toBe(480_000)

    // AND THE DELETED BOUNDS STAY DELETED. Each was a number with no precedent in
    // this repo, so re-exporting any of them would mean one had come back.
    expect(Object.keys(McpSampling)).not.toContain("DEFAULT_SAMPLING_TIMEOUT")
    expect(Object.keys(McpSampling)).not.toContain("DEFAULT_SAMPLING_STALL_TIMEOUT")
    expect(Object.keys(McpSampling)).not.toContain("DEFAULT_SAMPLING_APPROVAL_TIMEOUT")
  })
})

/**
 * STREAMING, AND THE STALL SIGNAL IT MAKES POSSIBLE.
 *
 * A non-streaming model call is opaque: "has this hung?" is unanswerable from
 * inside it, so the only available defence was a total wall-clock bound and a
 * guessed number to fill it. These tests pin the two things streaming buys —
 * liveness reported from OBSERVED output, and a stall detector that fires on real
 * silence — plus the thing it must NOT change, which is the single-result response
 * contract a server sees.
 *
 * EVERY BOUND HERE IS INJECTED so the suite runs in CI time, exactly as in the
 * block above: production passes none and inherits the provider's `chunkTimeout`
 * (8 minutes by default), with no total bound behind it. Sub-second bounds prove
 * the MECHANISM, never that any particular production value is right; the inherited
 * value is pinned separately by the constant assertions, and no test that finishes
 * in seconds also waits out eight minutes.
 */
describe("sampling streams, and a stalled stream is observable", () => {
  test("the model call streams, and the single-result contract is unchanged", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const h = await harness({ text: "hi" })
      await wireSampling(h.client)
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      // THE SWITCH ITSELF, asserted FIRST and observed at the PROVIDER's HTTP
      // boundary rather than by inspecting our own call site: a streaming request
      // is what went out. Checked before the result so that a non-streaming
      // regression is reported as "the request was not a stream" rather than as
      // some downstream symptom of it.
      expect(wire!.bodies).toHaveLength(1)
      expect(wire!.bodies[0].stream).toBe(true)
      // And the fixture really did answer in several deltas, so the assembled text
      // below was concatenated from a stream and not delivered in one piece.
      expect(splitDeltas(TRANSCRIPT).length).toBeGreaterThan(1)
      expect(result.isError).toBeFalsy()

      // THE CONTRACT DID NOT MOVE. Still one `CreateMessageResult`, still text-only,
      // still the same four fields with the same values — the server cannot tell
      // from its result that anything changed, which is the point.
      const detail = h.samplingOutcomes[0].detail as any
      expect(h.samplingOutcomes).toHaveLength(1)
      expect(h.samplingOutcomes[0].ok).toBe(true)
      expect(detail.role).toBe("assistant")
      expect(detail.content).toEqual({ type: "text", text: TRANSCRIPT })
      expect(detail.model).toBe(`${PROVIDER_ID}/mimo-v2.5`)
      expect(detail.stopReason).toBe("endTurn")
      // No extra field crept in alongside the streaming change.
      expect(Object.keys(detail).sort()).toEqual(["content", "model", "role", "stopReason"])
      await h.client.close()
    })
  }, 60_000)

  test("liveness reports OBSERVED output, and never the model's text", async () => {
    // Slow enough that several beats land mid-stream, so the notifications describe
    // a call in progress rather than one already finished.
    const INTERVAL = 150
    const trickle = stubProviderTrickle({ deltas: splitDeltas(TRANSCRIPT), gapMs: 120 })
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const warm = stubProvider(TRANSCRIPT)
      try {
        const first = await harness({ text: "hi" })
        await wireSampling(first.client)
        await first.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
          timeout: 30_000,
        })
        await first.client.close()
      } finally {
        warm.restore()
      }

      wire = trickle
      try {
        const h = await harness({ text: "hi", onprogress: () => {}, requestTimeout: 30_000 })
        await wireSampling(h.client, "fixture", INTERVAL, 20_000)
        const result = await h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )
        // The call SUCCEEDED, so these beats were emitted around real output.
        expect(result.isError).toBeFalsy()
        expect((result.content as Array<{ text: string }>)[0].text).toBe(TRANSCRIPT)

        expect(h.progressNotifications.length).toBeGreaterThanOrEqual(2)
        const messages = h.progressNotifications.map((n) => String(n.params.message))
        // THE UPGRADE OVER A FIXED TICK: at least one beat reports output the
        // provider actually produced. A timer-driven tick cannot say this, which is
        // why it could not tell "our process is alive" from "the model is working".
        expect(messages.some((m) => /model streaming, \d+ chunks \/ \d+ characters/.test(m))).toBe(true)
        // Counts only ever go forward, and the last beat saw real characters.
        const counts = messages
          .map((m) => m.match(/(\d+) chunks \/ (\d+) characters/))
          .filter((m): m is RegExpMatchArray => m !== null)
          .map((m) => [Number(m[1]), Number(m[2])] as const)
        expect(counts.length).toBeGreaterThanOrEqual(1)
        const chunkCounts = counts.map(([c]) => c)
        expect(chunkCounts).toEqual(chunkCounts.slice().sort((a, b) => a - b))
        expect(counts.at(-1)![1]).toBeGreaterThan(0)

        // AND NO PARTIAL CONTENT WENT OUT. `onprogress` asks for liveness, not for
        // output, and a request that later fails delivers no text at all — so a
        // prefix on this channel would disclose in the failure case exactly what
        // the contract says was never delivered. Checked word by word so no single
        // delta leaked either.
        for (const message of messages) {
          for (const word of TRANSCRIPT.split(" ")) expect(message).not.toContain(word)
        }
        expect(h.progressNotifications.every((n) => n.params.total === undefined)).toBe(true)
        await h.client.close()
      } finally {
        trickle.release()
        trickle.restore()
      }
    })
  }, 90_000)

  test("a stalled stream is reported as a stall, distinctly from the model bound, and says whether output ever started", async () => {
    const CHUNK_BOUND = 700

    // PHASE 1 — the provider never answers at all. Nothing is produced, so the
    // stall must say `chunks: 0`.
    let never: any
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const warm = stubProvider(TRANSCRIPT)
      try {
        const first = await harness({ text: "hi" })
        await wireSampling(first.client)
        await first.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
          timeout: 30_000,
        })
        await first.client.close()
      } finally {
        warm.restore()
      }
      const hang = stubProviderHang()
      wire = hang
      try {
        const h = await harness({ text: "hi", requestTimeout: 30_000 })
        // Model bound and approval bound left LARGE on purpose: if the stall
        // detector did not exist, one of those would have to be what ends this, and
        // the assertions below would see `phase: "model"` or `phase: "total"`.
        await wireSampling(h.client, "fixture", 10_000, CHUNK_BOUND)
        const result = await h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )
        expect(result.isError).toBe(true)
        never = h.samplingOutcomes[0].detail
        expect(hang.bodies).toHaveLength(1)
        // THE STALL REACHES THE PROVIDER, not just our own waiting for it.
        expect(hang.signals[0]!.aborted).toBe(true)
        await h.client.close()
      } finally {
        hang.release()
        hang.restore()
      }
    })

    // PHASE 2 — the provider answers, streams a few deltas, then goes quiet
    // forever. Output DID start, so the stall must say so.
    let died: any
    const trickle = stubProviderTrickle({ deltas: ["the ", "quick ", "brown "], gapMs: 80, thenSilent: true })
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const warm = stubProvider(TRANSCRIPT)
      try {
        const first = await harness({ text: "hi" })
        await wireSampling(first.client)
        await first.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
          timeout: 30_000,
        })
        await first.client.close()
      } finally {
        warm.restore()
      }
      wire = trickle
      try {
        const h = await harness({ text: "hi", requestTimeout: 30_000 })
        await wireSampling(h.client, "fixture", 10_000, CHUNK_BOUND)
        const result = await h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )
        expect(result.isError).toBe(true)
        died = h.samplingOutcomes[0].detail
        await h.client.close()
      } finally {
        trickle.release()
        trickle.restore()
      }
    })

    // Both are still `-32001` and both still carry `data.server` — that field is
    // the ONLY discriminator against the SDK's own `-32001`, since `data.timeout`
    // is set by our bounds too.
    expect(never.code).toBe(McpSampling.TIMEOUT_CODE)
    expect(died.code).toBe(McpSampling.TIMEOUT_CODE)
    expect(never.data).toMatchObject({ server: "fixture", phase: "stall", timeout: CHUNK_BOUND, chunks: 0 })
    expect(died.data).toMatchObject({ server: "fixture", phase: "stall", timeout: CHUNK_BOUND })
    // THE OBSERVABILITY PAYOFF, and the reason this is not merely a shorter
    // timeout: the error itself distinguishes a provider that never produced
    // anything from one that produced and then died.
    expect(never.data.chunks).toBe(0)
    expect(never.data.characters).toBe(0)
    expect(died.data.chunks).toBeGreaterThan(0)
    expect(died.data.characters).toBeGreaterThan(0)
    // `"stall"` IS NOW THE WHOLE PHASE VOCABULARY. The three expiries this used to
    // be distinguished from are gone with their bounds, so these are no longer
    // "distinct from a sibling" checks but a guard that none of them comes back
    // wearing this error's clothes. Asserted positively as well, so the check cannot
    // pass merely because `phase` went missing. (Matched, not compared: `McpError`
    // prefixes `MCP error -32001: ` on each hop.)
    for (const detail of [never, died]) {
      expect(String(detail.message)).toMatch(/sampling stalled: the model produced no output/)
      expect(String(detail.message)).not.toMatch(/waiting for the model/)
      expect(String(detail.message)).not.toMatch(/waiting for approval/)
      expect(detail.data.phase).toBe("stall")
      expect(detail.data.phase).not.toBe("model")
      expect(detail.data.phase).not.toBe("total")
      expect(detail.data.phase).not.toBe("approval")
    }
  }, 120_000)

  test("a slow stream is not a stalled one: every chunk resets the clock", async () => {
    // The stream runs for MANY TIMES the stall bound in total while never pausing
    // for as long as the bound. That combination is the whole property: a bound on
    // the GAP, not on the duration. Were the clock not reset per chunk, this call
    // would be killed at ~CHUNK_BOUND despite producing output the entire time.
    const CHUNK_BOUND = 900
    const GAP = 250
    const deltas = splitDeltas(TRANSCRIPT)
    expect(deltas.length * GAP).toBeGreaterThan(CHUNK_BOUND * 2)
    const trickle = stubProviderTrickle({ deltas, gapMs: GAP })
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"], sampling: "allow" } } }), async () => {
      const warm = stubProvider(TRANSCRIPT)
      try {
        const first = await harness({ text: "hi" })
        await wireSampling(first.client)
        await first.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
          timeout: 30_000,
        })
        await first.client.close()
      } finally {
        warm.restore()
      }
      wire = trickle
      try {
        const h = await harness({ text: "hi", requestTimeout: 30_000 })
        await wireSampling(h.client, "fixture", 10_000, CHUNK_BOUND)
        const started = Date.now()
        const result = await h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )
        const elapsed = Date.now() - started
        expect(result.isError).toBeFalsy()
        expect((result.content as Array<{ text: string }>)[0].text).toBe(TRANSCRIPT)
        // It genuinely outlived the stall bound, so "it did not stall" is a real
        // result and not an artefact of the call finishing too fast to test.
        expect(elapsed).toBeGreaterThan(CHUNK_BOUND)
        expect(h.samplingOutcomes[0].ok).toBe(true)
        await h.client.close()
      } finally {
        trickle.release()
        trickle.restore()
      }
    })
  }, 90_000)
})

describe("the approval prompt", () => {
  test("carries server, model, content types and audio size, and no credentials", async () => {
    wire = stubProvider(TRANSCRIPT)
    const buffer = wav(2)
    const data = buffer.toString("base64")
    await withInstance(
      // No `permission` entry at all, and no per-server `sampling` policy, so
      // mcp_sampling defaults to ask and a real prompt must be published.
      config({ mcp: { fixture: { type: "local", command: ["true"] } } }),
      async () => {
        const h = await harness({ audio: { data, mimeType: "audio/wav" }, hints: [{ name: "mimo-v2.5" }] })
        await wireSampling(h.client)

        // Start the call WITHOUT awaiting: it cannot finish until the prompt is
        // answered, which is the behaviour under test.
        const pending = h.client.callTool(
          { name: "transcribe_audio_fixture", arguments: {} },
          CallToolResultSchema,
          { timeout: 30_000 },
        )

        const request = await waitForAsk()
        expect(request.permission).toBe("mcp_sampling")
        expect(request.patterns).toEqual(["fixture"])
        expect(request.metadata).toMatchObject({
          server: "fixture",
          model: `${PROVIDER_ID}/mimo-v2.5`,
          requestedModel: ["mimo-v2.5"],
          audio: [{ mimeType: "audio/wav", bytes: buffer.length }],
          systemPrompt: "You are a verbatim transcription engine.",
          textPrompt: "Transcribe this audio verbatim.",
          maxTokens: 2048,
        })
        expect([...(request.metadata.contentTypes as string[])].sort()).toEqual(["audio", "text"])

        // No credential, base URL or raw audio payload in the prompt.
        const serialized = JSON.stringify(request)
        expect(serialized).not.toContain("test-key")
        expect(serialized).not.toContain("example.invalid")
        expect(serialized).not.toContain(data.slice(0, 64))

        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const permission = yield* Permission.Service
            yield* permission.reply({ requestID: request.id, reply: "once" })
          }),
        )

        const result = await pending
        expect(result.isError).toBeFalsy()
        expect((result.content as Array<{ text: string }>)[0].text).toBe(TRANSCRIPT)
        await h.client.close()
      },
    )
  }, 60_000)

  test("a session-less sampling request under policy ask fails closed instead of hanging", async () => {
    wire = stubProvider(TRANSCRIPT)
    await withInstance(config({ mcp: { fixture: { type: "local", command: ["true"] } } }), async () => {
      const h = await harness({ text: "hi" })
      // Deliberately NOT calling setActiveSession: no turn is in flight, so an
      // `ask` would publish a prompt nothing is listening for.
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          McpSampling.serve("fixture", h.client as never, bridge)
        }),
      )
      const result = await h.client.callTool({ name: "transcribe_audio_fixture", arguments: {} }, CallToolResultSchema, {
        timeout: 30_000,
      })
      expect(result.isError).toBe(true)
      const detail = h.samplingOutcomes[0].detail as any
      expect(detail.code).toBe(-1)
      expect(detail.message).toMatch(/no active session/)
      expect(wire!.bodies).toHaveLength(0)
      await h.client.close()
    })
  }, 60_000)
})

/**
 * UPSTREAM SDK BEHAVIOUR, PINNED — @modelcontextprotocol/sdk 1.27.1.
 *
 * `Protocol._oncancel` opens with `if (!notification.params.requestId) return`
 * (dist/esm/shared/protocol.js:170), so a `notifications/cancelled` naming request
 * id **0** is silently dropped and the receiving handler's `extra.signal` is never
 * aborted. `_requestMessageId` is initialised to 0 (protocol.js:16) and is PER
 * PROTOCOL INSTANCE, counting only the requests that instance SENDS — so the id at
 * risk belongs to the SERVER's outgoing counter, and nothing our client does can
 * advance it. Consequence for us: the FIRST server-initiated sampling request of a
 * connection cannot be cancelled by the server, and the request-timeout bound is
 * the only thing that reaps it.
 *
 * These tests exist so an SDK upgrade is VISIBLE. If upstream drops the falsy
 * check, cases 1 and 2 flip to `aborted === true` and fail here rather than
 * quietly changing behaviour under us.
 */
describe("upstream: a cancellation for JSON-RPC id 0 is dropped by the SDK", () => {
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  interface Pin {
    client: ClientType
    server: McpServerType
    /** Signals handed to the client's sampling handler, in arrival order. */
    signals: AbortSignal[]
    /** Every JSON-RPC message the SERVER put on the wire. */
    sent: Array<any>
    close: () => Promise<void>
  }

  /**
   * A real client whose `sampling/createMessage` handler PARKS, so a server
   * cancellation arrives while the request is genuinely open. A bare SDK handler
   * on purpose: what is under test is the SDK's notification routing, not ours.
   */
  async function pin(): Promise<Pin> {
    const server = new McpServer({ name: "cancelpin", version: "1.0.0" })
    const client = new Client({ name: "mimocode", version: "test" }, MCP.CLIENT_OPTIONS)
    const signals: AbortSignal[] = []
    const release: Array<() => void> = []
    client.setRequestHandler(CreateMessageRequestSchema, (async (_request: any, extra: any) => {
      signals.push(extra.signal)
      await new Promise<void>((resolve) => release.push(resolve))
      return { role: "assistant", content: { type: "text", text: "unused" }, model: "m", stopReason: "endTurn" }
    }) as never)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const sent: Array<any> = []
    const send = serverTransport.send.bind(serverTransport)
    serverTransport.send = ((message: any, options: any) => {
      sent.push(message)
      return send(message, options)
    }) as never
    await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)])
    return {
      client,
      server,
      signals,
      sent,
      close: async () => {
        for (const resolve of release.splice(0)) resolve()
        await client.close()
      },
    }
  }

  /** Issue a server→client sampling request, then abandon it. */
  async function abandonSamplingRequest(p: Pin) {
    const controller = new AbortController()
    const outcome = p.server.server
      .request(
        {
          method: "sampling/createMessage",
          params: { messages: [{ role: "user", content: { type: "text", text: "hi" } }], maxTokens: 16 },
        },
        CreateMessageResultSchema,
        { signal: controller.signal, timeout: 20_000 },
      )
      .then(
        () => "resolved",
        () => "rejected",
      )
    // Do not cancel before the handler has been entered, or there would be no
    // abort controller registered to find and the test would prove nothing.
    for (let attempt = 0; attempt < 200 && p.signals.length === 0; attempt++) await settle(10)
    expect(p.signals).toHaveLength(1)
    controller.abort(new Error("server abandoned the request"))
    expect(await outcome).toBe("rejected")
    // Let the notification cross the in-memory transport.
    await settle(100)
  }

  /** The requestId the server named in its `notifications/cancelled`. */
  function cancelledId(p: Pin) {
    const notification = p.sent.find((message) => message?.method === "notifications/cancelled")
    expect(notification).toBeDefined()
    return notification.params.requestId
  }

  test("case 1: the FIRST server-initiated request is id 0 and its cancellation never aborts our signal", async () => {
    const p = await pin()
    await abandonSamplingRequest(p)
    expect(cancelledId(p)).toBe(0)
    // The bug, measured: the notification was sent and delivered, and the
    // receiving handler's signal is still live.
    expect(p.signals[0].aborted).toBe(false)
    await p.close()
  }, 30_000)

  test("case 2: a CLIENT-side request first does not help — the server's counter is still at 0", async () => {
    const p = await pin()
    // A client→server round trip. This is what "burn id 0 at connection setup"
    // would amount to from our side, and it advances OUR outgoing counter, not
    // the server's — so it cannot make the server's cancellations land.
    await p.client.ping()
    await abandonSamplingRequest(p)
    expect(cancelledId(p)).toBe(0)
    expect(p.signals[0].aborted).toBe(false)
    await p.close()
  }, 30_000)

  test("case 3: once the SERVER has spent id 0, the very same cancellation works", async () => {
    const p = await pin()
    // Only the server can advance its own outgoing id.
    await p.server.server.ping()
    await abandonSamplingRequest(p)
    expect(cancelledId(p)).toBe(1)
    // The control for cases 1 and 2: cancellation delivery works end to end, so
    // their `aborted === false` is the falsy-id check and nothing else.
    expect(p.signals[0].aborted).toBe(true)
    await p.close()
  }, 30_000)
})
