import { describe, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { createServer, type ServerResponse } from "node:http"
import path from "path"
import type z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { resetAllMonitors } from "../../src/session/try-best-detector"
import { ProviderError } from "../../src/provider"
import { decide } from "../../src/session/retry"

void Log.init({ print: false })
resetAllMonitors()

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const cfg = (baseURL: string): Partial<Config.Info> => ({
  // Scale the real backoff down; retry.test.ts covers the production 5s→60s ladder.
  retry: {
    network: { initialDelayMs: 20, maxDelayMs: 160, jitterRatio: 0 },
  },
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL,
      },
    },
  },
})

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const statusLayer = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  statusLayer,
).pipe(Layer.provideMerge(infra))
const env = SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps))
const it = testEffect(env)

const boot = Effect.fn("density.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

const user = Effect.fn("density.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("density.assistant")(function* (sessionID: SessionID, parentID: MessageID, root: string) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const disconnectedUpstream = Effect.fn("density.upstream")(function* (phase: "request" | "stream") {
  const hits: Array<{ t: number; method?: string; url?: string }> = []
  let response: ServerResponse | undefined
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => createServer((req, res) => {
      hits.push({ t: Date.now(), method: req.method, url: req.url })
      req.resume()
      if (phase === "request") {
        req.socket.destroy()
        return
      }
      response = res
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":"partial"}}]}\n\n')
    })),
    (server) => Effect.promise(() => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })),
  )
  yield* Effect.promise(() => new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  }))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP listener")
  return { url: `http://127.0.0.1:${address.port}/v1`, hits, disconnect: () => response?.destroy() }
})

describe("retry density instrumentation (upstream transport failure)", () => {
  for (const phase of ["request", "stream"] as const) {
    it.live(
      `${phase} retries preserve event ownership, backoff density, and cancellation`,
      () => Effect.gen(function* () {
        const upstream = yield* disconnectedUpstream(phase)
        yield* provideTmpdirInstance(
          (dir) => Effect.gen(function* () {
            const { processors, session, provider } = yield* boot()
            const bus = yield* Bus.Service
            const status = yield* SessionStatus.Service
            const chat = yield* session.create({})
            const parent = yield* user(chat.id, "ping")
            const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
            const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
            const deltas: string[] = []
            const offDelta = yield* bus.subscribeCallback(MessageV2.Event.PartDelta, (evt) => {
              if (evt.properties.sessionID !== chat.id || evt.properties.messageID !== msg.id) return
              deltas.push(evt.properties.delta)
              // Disconnect only after the processor has consumed output, not merely after headers were written.
              upstream.disconnect()
            })

            const retries: Array<z.infer<typeof Session.Event.RetryAttempt.properties>> = []
            const states: Array<{ t: number; status: SessionStatus.RetryInfo }> = []
            const observed = yield* Deferred.make<void>()
            const offRetry = yield* bus.subscribeCallback(Session.Event.RetryAttempt, (evt) => {
              if (evt.properties.sessionID !== chat.id) return
              retries.push(evt.properties)
              if (retries.length === 6) Deferred.doneUnsafe(observed, Effect.void)
            })
            const offStatus = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
              if (evt.properties.sessionID !== chat.id || evt.properties.status.type !== "retry") return
              states.push({ t: Date.now(), status: evt.properties.status })
            })
            yield* Effect.addFinalizer(() => Effect.sync(() => {
              offRetry()
              offStatus()
              offDelta()
            }))
            const handle = yield* processors.create({
              assistantMessage: msg,
              sessionID: chat.id,
              model: mdl,
            })
            const run = yield* handle.process({
              user: parent,
              sessionID: chat.id,
              model: mdl,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "ping" }],
              tools: {},
            }).pipe(Effect.forkChild)

            yield* Deferred.await(observed).pipe(Effect.timeout("32 seconds"))
            expect(handle.message.error).toBeUndefined()
            expect((yield* status.get(chat.id)).type).toBe(phase === "request" ? "busy" : "retry")
            yield* Fiber.interrupt(run)
            const exit = yield* Fiber.await(run)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
            if (phase === "request") {
              expect(handle.message.error?.name).toBe("MessageAbortedError")
              const stored = MessageV2.get({ sessionID: chat.id, messageID: msg.id })
              expect(stored.info).toMatchObject({ role: "assistant", error: { name: "MessageAbortedError" } })
            }

            // Keep observers and the upstream alive past the cancelled wait to catch reopened requests.
            yield* Effect.sleep("350 millis")
            expect(upstream.hits).toHaveLength(6)
            for (const hit of upstream.hits) expect(hit).toMatchObject({ method: "POST", url: "/v1/chat/completions" })
            expect(deltas).toEqual(phase === "stream" ? Array(6).fill("partial") : [])
            expect(retries).toHaveLength(6)
            const waits = [20, 40, 80, 160, 160, 160]
            for (const [i, retry] of retries.entries()) {
              expect(retry).toMatchObject({
                sessionID: chat.id,
                messageID: phase === "request" ? parent.id : msg.id,
                attempt: i + 1,
                phaseAttempt: i + 1,
                maxAttempts: 0,
                phase,
                scope: phase === "request" ? "request" : "live-step",
                kind: "network",
              })
              expect(retry.hostCode).toBeUndefined()
              expect(retry.reason.length).toBeGreaterThan(0)
              if (phase === "request") expect(retry.nextDelayMs).toBe(waits[i]!)
              expect(retry.nextDelayMs).toBeGreaterThanOrEqual(0)
              expect(retry.nextDelayMs).toBeLessThanOrEqual(waits[i]!)
              if (i > 0) {
                expect(upstream.hits[i]!.t - upstream.hits[i - 1]!.t).toBeGreaterThanOrEqual(waits[i - 1]! - 2)
              }
            }
            expect(states).toHaveLength(phase === "request" ? 0 : 6)
            for (const [i, state] of states.entries()) {
              expect(state.status).toMatchObject({
                attempt: i + 1, phaseAttempt: i + 1, phase: "stream", scope: "live-step",
                message: retries[i]!.reason,
              })
              expect(state.status.next - upstream.hits[i]!.t).toBeGreaterThanOrEqual(waits[i]!)
              expect(state.status.next - state.t).toBeLessThanOrEqual(waits[i]!)
              if (i > 0) expect(upstream.hits[i]!.t).toBeGreaterThanOrEqual(states[i - 1]!.status.next - 2)
            }
          }),
          { git: true, config: cfg(upstream.url) },
        )
      }),
      60_000,
    )
  }

  it.live("classifies DNS-failure and connection-refused shapes as retryable", () =>
    Effect.sync(() => {
      const refused = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }),
      })
      const dns = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND proxy.invalid"), { code: "ENOTFOUND" }),
      })
      const eai = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo EAI_AGAIN proxy"), { code: "EAI_AGAIN" }),
      })
      expect(ProviderError.isRetryableNetworkError(refused)).toBe(true)
      expect(ProviderError.isRetryableNetworkError(eai)).toBe(true)
      // ENOTFOUND may surface only as undici "fetch failed" — message path must still retry.
      expect(ProviderError.isRetryableNetworkError(dns) || /fetch failed/i.test(String(dns.message))).toBe(true)
      const dRefused = decide(refused, "request")
      const dDns = decide(dns, "request")
      expect(dRefused.retryable).toBe(true)
      expect(dRefused.kind).toBe("network")
      expect(dDns.retryable).toBe(true)
    }),
  )
})
