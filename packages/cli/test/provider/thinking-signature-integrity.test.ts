import { describe, expect, test } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { ProviderTransform } from "../../src/provider"

// Regression for Opus 400 `Invalid signature in thinking block` /
// "The block is bound to a different conversation".
//
// A thinking signature binds (thinking text + the prefix before it). The live
// failure shipped `{ thinking: "", signature: <old> }` after a history rewrite
// blanked the text and kept the signature. Signed empty thinking is legal only
// when it was produced that way; a non-empty thinking block must never leave
// the wire with its text blanked or its signature detached.

const model = {
  id: "anthropic/claude-opus-5-5",
  providerID: "anthropic",
  api: { id: "claude-opus-5-5", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
  name: "Claude Opus",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200000, output: 8192 },
  status: "active",
  options: {},
  headers: {},
} as any

const reply = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
}

async function outbound(prompt: unknown) {
  let captured: any
  const anthropic = createAnthropic({
    apiKey: "test-key",
    fetch: (async (_url: any, init: any) => {
      captured = JSON.parse(init.body as string)
      return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } })
    }) as any,
  })
  await anthropic("claude-opus-5-5").doGenerate({ prompt } as any)
  return captured
}

function thinkingBlocks(body: any) {
  return body.messages.flatMap((message: any) =>
    (message.content as any[]).filter((part) => part.type === "thinking"),
  )
}

describe("thinking signature integrity on the wire", () => {
  test("a non-empty thinking block keeps its text and signature paired", async () => {
    const text = "plan: read the spec, then the code"
    const signature = "sig-intact-1"
    const body = await outbound(
      ProviderTransform.message(
        [
          { role: "user", content: [{ type: "text", text: "start" }] },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text, providerOptions: { anthropic: { signature } } },
              { type: "text", text: "done" },
            ],
          },
          { role: "user", content: [{ type: "text", text: "next" }] },
        ] as any,
        model,
        {},
      ),
    )

    expect(thinkingBlocks(body)).toEqual([{ type: "thinking", thinking: text, signature }])
  })

  test("replay of the same history does not rewrite thinking text or signature", async () => {
    const history = [
      { role: "user", content: [{ type: "text", text: "start" }] },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "first turn thinking",
            providerOptions: { anthropic: { signature: "sig-a" } },
          },
          { type: "text", text: "answer-a" },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "continue" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "second turn thinking",
            providerOptions: { anthropic: { signature: "sig-b" } },
          },
          { type: "text", text: "answer-b" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ] as any

    const first = thinkingBlocks(await outbound(ProviderTransform.message(history, model, {})))
    const second = thinkingBlocks(await outbound(ProviderTransform.message(history, model, {})))

    expect(first).toEqual([
      { type: "thinking", thinking: "first turn thinking", signature: "sig-a" },
      { type: "thinking", thinking: "second turn thinking", signature: "sig-b" },
    ])
    expect(second).toEqual(first)
  })

  test("signed empty thinking is preserved as empty+signature (legal origin), not re-signed", async () => {
    const signature = "sig-empty-origin"
    const body = await outbound(
      ProviderTransform.message(
        [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "", providerOptions: { anthropic: { signature } } },
              { type: "text", text: "done" },
            ],
          },
          { role: "user", content: [{ type: "text", text: "next" }] },
        ] as any,
        model,
        {},
      ),
    )

    expect(thinkingBlocks(body)).toEqual([{ type: "thinking", thinking: "", signature }])
  })
})
