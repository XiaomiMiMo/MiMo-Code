import { describe, expect, test } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { ProviderTransform } from "../../src/provider"

// WIRE-LEVEL proof of the `{"role":"user","content":[]}` producer.
//
// Asserting on `MessageV2.toModelMessages` output is two transformation layers
// short of the wire. What the provider actually receives is built by
// @ai-sdk/anthropic's `convertToAnthropicMessagesPrompt` from a
// `LanguageModelV3Prompt`. So these tests capture the real outbound HTTP body by
// injecting `fetch` into the provider factory.
//
// The bug: `ensureTrailingUserMessage` appended `{ role: "user", content:
// "Continue." }` — a BARE STRING. `ProviderTransform.message` is typed for
// `ModelMessage[]` (string content legal) but runs on a `LanguageModelV3Prompt`
// (user content must be an array of parts); the mismatch is silenced by the
// `@ts-expect-error` at session/llm.ts:670. @ai-sdk/anthropic then iterates the
// string CHARACTER BY CHARACTER (`for (let j = 0; j < content.length; j++)` with
// a `switch (part.type)` that has cases for only text/file and no default), so
// nothing is pushed and the message ships as `content: []`.

const model = {
  id: "anthropic/claude-3-5-sonnet",
  providerID: "anthropic",
  api: { id: "claude-3-5-sonnet-20241022", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
  name: "Claude 3.5 Sonnet",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0.003, output: 0.015, cache: { read: 0.0003, write: 0.00375 } },
  limit: { context: 200000, output: 8192 },
  status: "active",
  options: {},
  headers: {},
} as any

const reply = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-3-5-sonnet-20241022",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
}

// Sends `prompt` through the real provider and returns the parsed HTTP body.
async function outbound(prompt: unknown) {
  let captured: any
  const anthropic = createAnthropic({
    apiKey: "test-key",
    fetch: (async (_url: any, init: any) => {
      captured = JSON.parse(init.body as string)
      return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } })
    }) as any,
  })
  await anthropic("claude-3-5-sonnet-20241022").doGenerate({ prompt } as any)
  return captured
}

// A conversation that ends with a content-bearing assistant — the one condition
// under which `ensureTrailingUserMessage` appends a continuation turn.
const endsWithAssistant = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
  { role: "assistant", content: [{ type: "text", text: "done" }] },
]

describe("the trailing continuation turn reaches the wire with non-empty content", () => {
  test("CONTROL: a bare-string user content is shipped as content: [] (the producer)", async () => {
    const body = await outbound([...endsWithAssistant, { role: "user", content: "Continue." }])
    const last = body.messages[body.messages.length - 1]
    expect(last.role).toBe("user")
    // Proof of the defect mechanism, and proof this test would catch a regression.
    expect(last.content).toEqual([])
  })

  test("CONTROL: the part-array form is shipped intact", async () => {
    const body = await outbound([
      ...endsWithAssistant,
      { role: "user", content: [{ type: "text", text: "Continue." }] },
    ])
    const last = body.messages[body.messages.length - 1]
    expect(last.content).toEqual([{ type: "text", text: "Continue." }])
  })

  test("ensureTrailingUserMessage's appended turn survives to the wire", async () => {
    // @ts-expect-error mirrors session/llm.ts:670 — message() is typed for
    // ModelMessage[] but is applied to a LanguageModelV3Prompt in production.
    const transformed = ProviderTransform.message(endsWithAssistant, model, {})
    const body = await outbound(transformed)
    const last = body.messages[body.messages.length - 1]
    expect(last.role).toBe("user")
    // `applyCaching` may also attach a cache_control marker to the last part;
    // what matters is that a real text part is present at all.
    expect(last.content).toHaveLength(1)
    expect(last.content[0].type).toBe("text")
    expect(last.content[0].text).toBe("Continue.")
  })

  test("NO message reaches the wire with empty content", async () => {
    // @ts-expect-error see above
    const body = await outbound(ProviderTransform.message(endsWithAssistant, model, {}))
    const empty = body.messages
      .map((msg: any, index: number) => ({ index, role: msg.role, length: msg.content.length }))
      .filter((entry: any) => entry.length === 0)
    expect(empty).toEqual([])
  })
})
