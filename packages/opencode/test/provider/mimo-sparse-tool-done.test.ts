import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createOpenaiCompatible } from "../../src/provider/sdk/copilot"
import { Provider, ProviderTransform } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"

// [TP-R11-10] Preserve the sparse marker seen in MiMo streams, using synthetic IDs and arguments.

const item = {
  type: "function_call",
  id: "fc_test",
  call_id: "call_test",
  name: "lookup",
  arguments: '{"key":"example"}',
  status: "completed",
}
const marker = { type: "response.function_call_arguments.done", output_index: 2, item_id: item.id }

function events(done: object = marker, final: object = item) {
  return [
    { type: "response.output_item.added", output_index: 2, item: { ...item, arguments: "", status: "in_progress" } },
    ...['{"key":', '"example"}'].map((delta) => ({
      type: "response.function_call_arguments.delta", output_index: 2, item_id: item.id, delta,
    })),
    done,
    { type: "response.output_item.done", output_index: 2, item: final },
    { type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 6 } } },
  ]
}

async function replay(input: object[], mode: "copilot" | "standard") {
  const options = {
    apiKey: "test-key",
    fetch: (async () => {
      const response = new Response(input.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      })
      return response
    }) as unknown as typeof fetch,
  }
  const sdk = mode === "copilot" ? createOpenaiCompatible({ ...options, name: "openai" }) : createOpenAI(options)
  const result = await sdk.responses("test-model").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Look up example." }] }],
  })
  const parts: LanguageModelV3StreamPart[] = []
  await result.stream.pipeTo(new WritableStream({ write(part) { parts.push(part) } }))
  return parts
}

test("MiMo sparse arguments.done preserves the Copilot tool result without weakening standard OpenAI", async () => {
  for (const mode of ["copilot", "standard"] as const) {
    const parts = await replay(events(), mode)
    if (mode === "standard") {
      expect(parts.filter((part) => part.type === "error")).toHaveLength(1)
      continue
    }
    expect(parts.filter((part) => part.type === "error")).toEqual([])
    expect(parts.filter((part) => part.type === "tool-call")).toMatchObject([
      { toolCallId: item.call_id, toolName: item.name, input: item.arguments },
    ])
    expect(parts.filter((part) => part.type === "tool-input-end")).toHaveLength(1)
    expect(parts.find((part) => part.type === "finish")?.finishReason.unified).toBe("tool-calls")
  }
})

test("MiMo accepts standard arguments.done without duplicate tool calls", async () => {
  const parts = await replay(events({ ...marker, arguments: item.arguments }), "copilot")
  expect(parts.filter((part) => part.type === "error")).toEqual([])
  expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(1)
})

test("a sparse marker alone never invents a tool call", async () => {
  const parts = await replay([marker, events().at(-1)!], "copilot")
  expect(parts.filter((part) => part.type === "tool-call")).toEqual([])
})

test("compatible Responses preserves explicit phase and turn boundaries", async () => {
  for (const endTurn of [true, false, undefined]) {
    const parts = await replay([
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_test", phase: "commentary" } },
      { type: "response.output_text.delta", item_id: "msg_test", delta: "Checking." },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_test", phase: "commentary" } },
      { type: "response.completed", response: { end_turn: endTurn, usage: { input_tokens: 1, output_tokens: 1 } } },
    ], "copilot")
    expect(parts.filter((part) => part.type === "error")).toEqual([])
    expect(parts.find((part) => part.type === "text-end")?.providerMetadata?.openai?.phase).toBe("commentary")
    expect(parts.find((part) => part.type === "finish")?.providerMetadata?.openai?.endTurn).toBe(endTurn)
  }
})

test("configured MiMo aliases use the compatible parser without leaking to OpenAI", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json()
      expect(["deployment-example-a", "deployment-example-b", "mimo-test", "gpt-5.4"]).toContain(body.model)
      if (body.model.startsWith("deployment-")) expect(body.reasoning.summary).toBe("auto")
      return new Response(events().map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
      })
    },
  })
  try {
    await using tmp = await tmpdir({ config: {
      provider: { "test-gateway": {
        npm: "@ai-sdk/openai",
        options: { apiKey: "test-key", baseURL: `http://127.0.0.1:${server.port}/v1` },
        models: Object.fromEntries(["mimo-example-a", "mimo-example-b", "mimo-test", "gpt-5.4"].map((id) => [id, {
          id: id.startsWith("mimo-example") ? id.replace("mimo-", "deployment-") : id,
          limit: { context: 8192, output: 2048 },
        }])),
      } },
    } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      for (const id of ["mimo-example-a", "gpt-5.4", "mimo-example-b", "mimo-test"]) {
        const parts = await AppRuntime.runPromise(Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderID.make("test-gateway"), ModelID.make(id))
          expect(model.api.npm).toBe(id === "gpt-5.4" ? "@ai-sdk/openai" : "@mimo/responses")
          const language = yield* provider.getLanguage(model)
          const result = yield* Effect.promise(() => language.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "Look up example." }] }],
            providerOptions: ProviderTransform.providerOptions(model, {}),
          }))
          const output: LanguageModelV3StreamPart[] = []
          yield* Effect.promise(() => result.stream.pipeTo(new WritableStream({ write(part) { output.push(part) } })))
          return output
        }))
        expect(parts.filter((part) => part.type === "error")).toHaveLength(id === "gpt-5.4" ? 1 : 0)
        if (id !== "gpt-5.4") expect(parts.filter((part) => part.type === "tool-call")).toMatchObject([
          { toolCallId: item.call_id, toolName: item.name, input: item.arguments },
        ])
      }
    } })
  } finally {
    server.stop(true)
  }
})
