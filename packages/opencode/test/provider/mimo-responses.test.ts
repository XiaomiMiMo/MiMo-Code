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
      const bodies: Array<{ input: unknown }> = []
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

// [TP-R11-03] A sparse terminal event must not erase encrypted reasoning from the start.
test("reasoning encryption survives a sparse end event and a stream without an end item", async () => {
  for (const done of [true, false]) {
    const sdk = createOpenaiCompatible({ name: "openai", fetch: (async () => new Response([
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_sparse", encrypted_content: "synthetic-encrypted" } },
      { type: "response.reasoning_text.delta", output_index: 0, item_id: "rs_sparse", content_index: 0, delta: "partial reasoning" },
      ...(done ? [{ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_sparse" } }] : []),
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch });
    const stream = await sdk.responses("mimo-test").doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] });
    const parts = await read(stream.stream);
    expect(parts.find(p => p.type === "reasoning-delta")?.providerMetadata?.openai).toMatchObject({ reasoningEncryptedContent: "synthetic-encrypted" });
    expect(parts.filter(p => p.type === "reasoning-end")).toHaveLength(1);
    expect(parts.find(p => p.type === "reasoning-end")?.providerMetadata?.openai).toEqual({ itemId: "rs_sparse", reasoningEncryptedContent: "synthetic-encrypted" });
  }
});

// [TP-R7-06] Explicitly registered MiMo aliases use both the Codex transport and reasoning options.
test("v2.6-flash-test is a MiMo Responses alias without changing its API model ID", async () => {
  const { Provider, ProviderTransform } = await import("../../src/provider")
  const { ProviderTest } = await import("../fake/provider")
  const { ModelID, ProviderID } = await import("../../src/provider/schema")
  const model = ProviderTest.model({ id: ModelID.make("v2.6-flash-test"), providerID: ProviderID.make("test"), api: { id: "v2.6-flash-test", npm: "@ai-sdk/openai-compatible", url: "https://example.test/v1" } })
  expect(Provider.isMimoOrSmartModel("v2.6-flash-test")).toBe(true)
  expect(Provider.isMimoOrSmartModel("test/v2.6-flash-test")).toBe(true)
  expect(Provider.isMimoOrSmartModel("v2.6-pro-test")).toBe(false)
  expect(Provider.isMimoOrSmartModel("v2.6-flash-test-other")).toBe(false)
  const resolved = Provider.forHarness(model, "codex")
  expect(resolved.api.npm).toBe("@mimo/responses")
  expect(resolved.api.id).toBe("v2.6-flash-test")
  expect(Provider.forHarness(model, "default")).toBe(model)
  const sdk = createOpenaiCompatible({ name: "openai", baseURL: "https://example.test/v1", fetch: (async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe("v2.6-flash-test")
    expect(body.reasoning.summary).toBe("auto")
    expect(body.store).toBe(false)
    expect(body.include).toContain("reasoning.encrypted_content")
    return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', { headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch })
  await read((await sdk.responses(resolved.api.id).doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }], providerOptions: ProviderTransform.providerOptions(resolved, {}) })).stream)
})

// [TP-R11-03] Completing one orphan reasoning item must not reuse another live item's index.
test("interleaved reasoning deltas without start frames retain separate identities", async () => {
  const delta = (id: string, text: string) => ({ type: "response.reasoning_summary_text.delta", item_id: id, summary_index: 0, delta: text })
  const done = (id: string, index: number) => ({ type: "response.output_item.done", output_index: index, item: { type: "reasoning", id } })
  const events = [delta("a", "A"), delta("b", "B"), done("a", 0), delta("c", "C"), delta("b", "2"), done("b", 1), done("c", 2)]
  const sdk = createOpenaiCompatible({ name: "openai", fetch: (async () => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch })
  const result = await sdk.responses("mimo-test").doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] })
  const parts = await read(result.stream)
  const output: Record<string, string> = {}
  for (const part of parts) if (part.type === "reasoning-delta") output[part.id] = (output[part.id] ?? "") + part.delta
  expect(output).toEqual({ "a:0": "A", "b:0": "B2", "c:0": "C" })
  expect(parts.filter(p => p.type === "reasoning-end").map(p => p.id)).toEqual(["a:0", "b:0", "c:0"])
})
