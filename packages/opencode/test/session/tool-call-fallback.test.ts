import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { jsonSchema, tool } from "ai"
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
import { raw, TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

// ===== provider config: @ai-sdk/openai (npm) pointed at TestLLMServer =====
const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function cfg() {
  return {
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai",
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
        options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
      },
    },
  }
}

function providerCfg(url: string) {
  const base = cfg()
  return {
    ...base,
    provider: {
      test: {
        ...base.provider.test,
        options: { ...base.provider.test.options, baseURL: url },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
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
  status,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps)),
)

const it = testEffect(env)

function user(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    const msg = yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
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
}

function assistant(sessionID: SessionID, parentID: MessageID, root: string) {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    const msg: MessageV2.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: root, root },
      cost: 0,
      tokens: {
        total: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      time: { created: Date.now() },
      finish: "end_turn",
    }
    yield* session.updateMessage(msg)
    return msg
  })
}

// Ark shape: `output_item.added` function_call WITHOUT `arguments`; arguments
// arrive via `function_call_arguments.delta/done`. With the pristine
// @ai-sdk/openai 3.0.84 the added chunk fails zod (required `arguments`),
// is dropped, and `tool-input-start` never fires — the stream still emits
// `tool-input-end` + `tool-call`.
const ARK_SSE = [
  { type: "response.created", response: { id: "resp_1", created_at: 1, model: "m" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 1, item: { call_id: "call_1", name: "bash", type: "function_call", id: "fc_1", status: "in_progress" } },
  { type: "response.function_call_arguments.delta", delta: '{"command":', item_id: "fc_1", output_index: 1 },
  { type: "response.function_call_arguments.delta", delta: '"echo hello"}', item_id: "fc_1", output_index: 1 },
  { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: '{"command": "echo hello"}' },
  { type: "response.output_item.done", output_index: 1, item: { call_id: "call_1", name: "bash", type: "function_call", id: "fc_1", arguments: '{"command": "echo hello"}', status: "completed" } },
  { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }, output: [{ id: "fc_1", call_id: "call_1", name: "bash", type: "function_call", arguments: '{"command": "echo hello"}' }] } },
]

describe("session processor tool-call fallback", () => {
  it.live("creates a tool part when output_item.added lacks arguments (Ark shape)", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const processors = yield* SessionProcessor.Service
          const session = yield* Session.Service
          const provider = yield* Provider.Service

          yield* llm.push(raw({ passthrough: true, head: ARK_SSE, tail: [] }))

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "hi")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

          const input = {
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {
              bash: tool({
                description: "Run a bash command",
                inputSchema: jsonSchema({
                  type: "object",
                  properties: { command: { type: "string" } },
                  required: ["command"],
                }),
                execute: async ({ command }: { command: string }) => `executed:${command}`,
              }),
            },
          } satisfies LLM.StreamInput

          yield* handle.process(input)

          const toolParts = MessageV2.parts(msg.id).filter((part) => part.type === "tool")
          expect(toolParts.length).toBeGreaterThan(0)
          expect(toolParts[0].tool).toBe("bash")
          expect(toolParts[0].callID).toBe("call_1")
          expect(toolParts[0].state.status).toBe("completed")
        }),
      { git: true, config: (url) => providerCfg(url) },
    ),
  )
})
