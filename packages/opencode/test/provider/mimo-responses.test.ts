import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { expect, test } from "bun:test"
import { createOpenaiCompatible } from "../../src/provider/sdk/copilot"

async function read(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const reader = stream.getReader()
  const parts: LanguageModelV3StreamPart[] = []
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    parts.push(next.value)
  }
  return parts
}

// [TP-R11-02][TP-R11-03] Synthetic reasoning text, never production conversation content.
for (const type of ["response.reasoning_summary_text.delta", "response.reasoning_text.delta", "response.reasoning_content.delta"]) {
  for (const start of [true, false]) {
    test(`Responses preserves ${type}, explicit start=${start}`, async () => {
      const events = [
        ...(start ? [{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_test" } }] : []),
        { type, item_id: "rs_test", output_index: 0, summary_index: 0, content_index: 0, delta: "synthetic " },
        { type, item_id: "rs_test", output_index: 0, summary_index: 0, content_index: 0, delta: "reasoning" },
        { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_test", encrypted_content: "test-encrypted" } },
        { type: "response.output_text.delta", item_id: "msg_test", delta: "answer" },
        { type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 6 } } },
      ]
      const bodies: any[] = []
      const sdk = createOpenaiCompatible({ name: "openai", baseURL: "https://example.test/v1", fetch: (async (url, init) => {
        expect(String(url)).toBe("https://example.test/v1/responses")
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })
      }) as typeof fetch })
      const language = sdk.responses("mimo-test")
      const response = await language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }], providerOptions: { openai: { store: false } } })
      const parts = await read(response.stream)
      expect(parts.filter(p => p.type === "error")).toEqual([])
      expect(parts.filter(p => p.type === "reasoning-delta").map(p => p.delta).join("")).toBe("synthetic reasoning")
      expect(parts.filter(p => p.type === "text-delta").map(p => p.delta).join("")).toBe("answer")
      expect(parts.filter(p => p.type === "reasoning-start")).toHaveLength(1)
      const end = parts.find(p => p.type === "reasoning-end")!
      expect(end.providerMetadata?.openai).toMatchObject({ itemId: "rs_test", reasoningEncryptedContent: "test-encrypted" })
      const next = await language.doStream({ prompt: [
        { role: "user", content: [{ type: "text", text: "test" }] },
        { role: "assistant", content: [{ type: "reasoning", text: "synthetic reasoning", providerOptions: end.providerMetadata }] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ], providerOptions: { openai: { store: false } } })
      await read(next.stream)
      expect(bodies[1].input).toContainEqual({ type: "reasoning", id: "rs_test", encrypted_content: "test-encrypted", summary: [{ type: "summary_text", text: "synthetic reasoning" }] })
    })
  }
}

// [TP-R11-01] Protocol selection uses resolved API identity, including aliases.
test("MiMo Responses transport view keeps identity and original metadata", async () => {
  const { Provider, ProviderTransform } = await import("../../src/provider")
  const { ProviderTest } = await import("../fake/provider")
  const { ModelID, ProviderID } = await import("../../src/provider/schema")
  const model = ProviderTest.model({ id: ModelID.make("deployment"), providerID: ProviderID.make("test"), family: "mimo", api: { id: "mimo-v2.6", npm: "@ai-sdk/openai-compatible", url: "https://example.test/v1" } })
  const codex = Provider.forHarness(model, "codex")
  expect(codex.api.npm).toBe("@mimo/responses")
  expect(codex.id).toBe(model.id)
  expect(codex.providerID).toBe(model.providerID)
  expect(codex.api.url).toBe(model.api.url)
  expect(Provider.forHarness(model, "default")).toBe(model)
  expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
  expect(ProviderTransform.providerOptions(codex, {})).toEqual({ openai: { store: false, include: ["reasoning.encrypted_content"], reasoningSummary: "auto" } })
})
