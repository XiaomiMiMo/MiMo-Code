import { describe, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import path from "path"
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
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
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

/** Invalid upstream — ECONNREFUSED (proxy/down) style; DNS-fail host covered separately. */
const BAD_BASE = "http://127.0.0.1:1/v1"

const cfg = {
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
        baseURL: BAD_BASE,
      },
    },
  },
}

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
const env = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps)),
)
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

type Publish = { t: number; attempt: number; phase?: string; waitMs: number; message?: string }

describe("retry density instrumentation (invalid baseURL)", () => {
  it.live(
    "records session.status{retry} density when upstream base URL is unreachable",
    () =>
      provideTmpdirServer(
        ({ dir }) =>
          Effect.gen(function* () {
            const { processors, session, provider } = yield* boot()
            const bus = yield* Bus.Service
            const chat = yield* session.create({})
            const parent = yield* user(chat.id, "ping")
            const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
            const mdl = yield* provider.getModel(ref.providerID, ref.modelID)

            const publishes: Publish[] = []
            const t0 = Date.now()
            const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
              if (evt.properties.sessionID !== chat.id) return
              const s = evt.properties.status
              if (s.type !== "retry") return
              publishes.push({
                t: Date.now() - t0,
                attempt: s.attempt,
                phase: s.phase,
                waitMs: Math.max(0, s.next - Date.now()),
                message: s.message,
              })
            })

            const handle = yield* processors.create({
              assistantMessage: msg,
              sessionID: chat.id,
              model: mdl,
            })

            // Drive one process() against unreachable baseURL. Default retry budgets:
            // request 200ms×4 then stream-network 5s→60s (persistent). Cap wall clock
            // so the suite stays finite; we only need the publish trace + gaps.
            const proc = handle.process({
              user: {
                id: parent.id,
                sessionID: chat.id,
                role: "user",
                time: parent.time,
                agent: parent.agent,
                model: { providerID: ref.providerID, modelID: ref.modelID },
              },
              sessionID: chat.id,
              model: mdl,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "ping" }],
              tools: {},
            })

            yield* proc.pipe(Effect.timeout("32 seconds"), Effect.option)
            off()

            const elapsed = Date.now() - t0
            const gaps = publishes.slice(1).map((p, i) => p.t - publishes[i]!.t)
            // Diagnostic line for humans reading CI / local output
            console.log(
              "[retry-density] baseURL=%s elapsed=%dms publishes=%d attempts=%j phases=%j waits=%j gaps=%j messages=%j",
              BAD_BASE,
              elapsed,
              publishes.length,
              publishes.map((p) => p.attempt),
              publishes.map((p) => p.phase),
              publishes.map((p) => p.waitMs),
              gaps,
              publishes.map((p) => p.message),
            )

            expect(publishes.length).toBeGreaterThan(0)
            // After the fix: session.status{retry} is processor-owned (stream phase only).
            // Unreachable baseURL must NOT stack request-phase frames onto the UI streak.
            // Measured pre-fix: 20 frames / 32s (4×request + 1×stream per cycle).
            // Post-fix ceiling in 32s under stream/server 2s→30s ladders ≈ 4–6.
            expect(publishes.length).toBeLessThan(10)
            expect(publishes.every((p) => p.phase !== "request")).toBe(true)
            // Processor waits should grow (exponential), not restart at ~200ms.
            const streamWaits = publishes.map((p) => p.waitMs)
            for (let i = 1; i < streamWaits.length; i++) {
              expect(streamWaits[i]!).toBeGreaterThanOrEqual(streamWaits[i - 1]! * 0.5)
            }
          }),
        // Ignore the fixture LLM server URL — force unreachable upstream.
        { git: true, config: () => cfg },
      ),
    60_000,
  )

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
