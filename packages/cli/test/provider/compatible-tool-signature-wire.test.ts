import { expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test"
import { streamText } from "ai"
import { ProviderTransform, type Provider } from "../../src/provider"
import {
  captureCompatibleToolSignature,
  compatibleToolCallMetadata,
} from "../../src/provider/compatible-tool-signature"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"

const text = { text: true, image: false, video: false, audio: false, pdf: false }
const model: Provider.Model = {
  id: ModelID.make("model"),
  providerID: ProviderID.make("test"),
  name: "Test",
  api: { id: "model", npm: "@ai-sdk/openai-compatible", url: "https://example.test/v1" },
  capabilities: {
    input: text,
    output: text,
    temperature: true,
    reasoning: false,
    toolcall: true,
    attachment: false,
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1000, output: 100 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}
const sessionID = SessionID.make("session")
function assistant(messageID: MessageID, parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      role: "assistant",
      id: messageID,
      sessionID,
      parentID: MessageID.make("user"),
      modelID: model.id,
      providerID: model.providerID,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/example", root: "/tmp/example" },
      time: { created: 0 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "tool-calls",
    },
    parts,
  }
}

function response(calls: { id: string; signature?: string }[]) {
  const tool_calls = calls.map(({ id, signature }, index) => ({
    index,
    id,
    type: "function",
    function: { name: "lookup", arguments: JSON.stringify({ key: id }) },
    extra_content: { google: { thought_signature: signature, ignored: true } },
  }))
  return {
    lines: [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls }, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ],
  }
}

test("does not project absent or unrelated fields or change other SDKs", () => {
  const metadata = { test: { thoughtSignature: "signed" }, google: { unrelated: true } }
  for (const npm of ["@ai-sdk/openai", "@ai-sdk/google", "@ai-sdk/github-copilot"]) {
    expect(compatibleToolCallMetadata(metadata, { ...model, api: { ...model.api, npm } })).toBe(metadata)
  }
  const native = { ...model, api: { ...model.api, npm: "@ai-sdk/google" } }
  const captured = captureCompatibleToolSignature({ test: { thoughtSignature: "one-call" } }, model, "test.chat")
  expect(compatibleToolCallMetadata(captured, model, "alternate.chat")).toEqual({
    google: { thoughtSignature: "one-call" },
  })
  expect(compatibleToolCallMetadata(captured, native, "google.chat")).toBeUndefined()
  expect(compatibleToolCallMetadata(metadata, model, "another.chat")).toBe(metadata)
  expect(compatibleToolCallMetadata(undefined, model)).toBeUndefined()
  for (const signature of ["", null, 42]) {
    expect(
      compatibleToolCallMetadata({ google: { thoughtSignature: signature, unrelated: true } }, model, "google.chat"),
    ).toEqual({ google: { unrelated: true } })
    expect(
      compatibleToolCallMetadata({ openaiCompatible: { thoughtSignature: signature } }, model, "openaiCompatible.chat"),
    ).toBeUndefined()
  }
})

// Exercise the SDK's configured metadata name, including the name that collides with
// its wire passthrough. Never copy extra response fields onto calls or tool results.
test.each([
  { name: "test", key: "test" },
  { name: "custom-name.route", key: "custom-name" },
  { name: "custom-name.route", key: "customName" },
  { name: "openai-compatible", key: "openai-compatible" },
  { name: "openai-compatible", key: "openaiCompatible" },
  { name: "openaiCompatible", key: "openaiCompatible" },
  { name: "google", key: "google" },
  { name: "providerExecuted", key: "providerExecuted" },
  { name: "openaiCompatible", key: "openaiCompatible", replayAs: "new-alias" },
])("reconstructs signed tool calls for $name (metadata key $key, case %#)", async ({ name, key, replayAs }) => {
  const first = " first \t"
  const second = " second \t"
  const cache = { cache_control: { type: "ephemeral" } }
  const server = startScriptedLLMServer([
    response([{ id: "serial", signature: first }]),
    response([{ id: "unsigned" }, { id: "signed", signature: second }]),
    { lines: textStopResponse("done") },
  ])
  try {
    const language = createOpenAICompatible({ name, baseURL: server.origin })(model.api.id)
    const history: MessageV2.WithParts[] = []
    for (let step = 0; step < 2; step++) {
      const messageID = MessageID.make(`assistant-${step}`)
      const result = await language.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Look up entries." }] }],
        providerOptions: { [key]: {} },
      })
      const calls = (await convertReadableStreamToArray(result.stream)).filter((part) => part.type === "tool-call")
      history.push(
        assistant(
          messageID,
          calls.map((call, index) => {
            const metadata = call.providerMetadata
            return {
              type: "tool",
              tool: call.toolName,
              id: PartID.make(call.toolCallId),
              callID: call.toolCallId,
              sessionID,
              messageID,
              // Replay must preserve existing options even when the SDK's name collides with a wire namespace.
              metadata: metadata && {
                ...metadata,
                ...(key !== "openaiCompatible" &&
                  key !== "google" && { [key]: { ...metadata[key], notForReplay: true } }),
                google: { ...metadata.google, unrelated: true },
                openaiCompatible: { ...metadata.openaiCompatible, ...cache },
              },
              state: {
                status: "completed",
                input: JSON.parse(call.input),
                output: `value:${call.toolCallId}`,
                title: "lookup",
                metadata: {},
                time: { start: 0, end: calls.length - index },
              }, // second parallel call completed first
            }
          }),
        ),
      )
    }
    const replay = replayAs
      ? createOpenAICompatible({ name: replayAs, baseURL: server.origin })(model.api.id)
      : language
    const messages = await MessageV2.toModelMessages(history, model, { languageProvider: replay.provider })
    const parts = messages.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content) ? message.content : [],
    )
    const signed = parts.find((part) => part.type === "tool-call" && part.toolCallId === "signed")
    const request = streamText({
      model: replay,
      messages: ProviderTransform.message(messages, model, {}),
      maxRetries: 0,
    })
    expect(await request.text).toBe("done")
    const sent: unknown[] = server.captures[2].messages
    const call = (id: string, signature?: string) => ({
      id,
      type: "function",
      function: { name: "lookup", arguments: JSON.stringify({ key: id }) },
      ...(signature && { ...cache, extra_content: { google: { thought_signature: signature } } }),
    })
    expect(sent).toEqual([
      { role: "assistant", content: "", tool_calls: [call("serial", first)] },
      { role: "tool", content: "value:serial", tool_call_id: "serial", ...cache },
      { role: "assistant", content: "", tool_calls: [call("unsigned"), call("signed", second)] },
      { role: "tool", content: "value:unsigned", tool_call_id: "unsigned" },
      { role: "tool", content: "value:signed", tool_call_id: "signed", ...cache },
    ])
    if (signed?.type !== "tool-call") throw new Error("Expected signed tool call")
    expect(signed.providerOptions?.google).toEqual({ thoughtSignature: second, unrelated: true })
  } finally {
    await server.stop()
  }
})
