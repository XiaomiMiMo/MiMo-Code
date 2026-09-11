import { describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { ModelCapability } from "../../src/provider/capability-registry"

/**
 * WIRE-LEVEL substantiation of the Model Capability Registry's audio verdicts.
 *
 * The registry is only trustworthy if "supported" and "unsupported" describe what
 * the installed adapters actually do. Asserting the table against itself would be
 * circular, so each case here drives the REAL adapter with an `audio/*` file part
 * and checks the serialized request body (or the thrown rejection). An adapter
 * upgrade that changes this behaviour fails here rather than silently making the
 * registry lie.
 */

const AUDIO = Buffer.from("RIFFfake").toString("base64")

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
}

const OPENAI_REPLY = {
  id: "1",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

const ANTHROPIC_REPLY = {
  id: "m1",
  type: "message",
  role: "assistant",
  model: "c",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
}

const GOOGLE_REPLY = {
  candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
}

/** Returns the serialized parts for an audio part, or the thrown error message. */
async function sendAudio(
  factory: "openai-compatible" | "anthropic" | "google",
  mediaType: string,
): Promise<{ parts: unknown } | { error: string }> {
  let captured: any
  const capture = (reply: unknown) =>
    (async (_url: unknown, init: { body: string }) => {
      captured = JSON.parse(init.body)
      return json(reply)
    }) as never
  const prompt = [{ role: "user", content: [{ type: "file", data: AUDIO, mediaType }] }]
  try {
    if (factory === "openai-compatible") {
      const provider = createOpenAICompatible({
        name: "t",
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        fetch: capture(OPENAI_REPLY),
      })
      await provider("m").doGenerate({ prompt } as never)
      return { parts: captured.messages[0].content }
    }
    if (factory === "anthropic") {
      const provider = createAnthropic({ apiKey: "test-key", fetch: capture(ANTHROPIC_REPLY) })
      await provider("claude-3-5-sonnet-20241022").doGenerate({ prompt } as never)
      return { parts: captured.messages[0].content }
    }
    const provider = createGoogleGenerativeAI({ apiKey: "test-key", fetch: capture(GOOGLE_REPLY) })
    await provider("gemini-2.0-flash").doGenerate({ prompt } as never)
    return { parts: captured.contents[0].parts }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

describe("@ai-sdk/openai-compatible audio behaviour matches the registry", () => {
  test.each(["audio/wav", "audio/mp3", "audio/mpeg"])("%s is serialized as input_audio", async (mediaType) => {
    // The registry declares exactly this MIME set as supported.
    expect(ModelCapability.adapterDeclaration("@ai-sdk/openai-compatible").audio.mimeTypes).toContain(mediaType)
    const outcome = await sendAudio("openai-compatible", mediaType)
    expect(outcome).not.toHaveProperty("error")
    if ("error" in outcome) throw new Error("unreachable")
    expect(outcome.parts).toEqual([{ type: "input_audio", input_audio: { data: AUDIO, format: expect.any(String) } }])
  })

  test.each(["audio/flac", "audio/ogg"])("%s is refused by the adapter, so the registry excludes it", async (mediaType) => {
    const declaration = ModelCapability.adapterDeclaration("@ai-sdk/openai-compatible").audio
    expect(declaration.mimeTypes).not.toContain(mediaType)
    const outcome = await sendAudio("openai-compatible", mediaType)
    expect(outcome).toHaveProperty("error")
    if (!("error" in outcome)) throw new Error("unreachable")
    expect(outcome.error).toMatch(/not supported/)
  })
})

describe("@ai-sdk/anthropic audio is KNOWN-ABSENT", () => {
  test("an audio/wav part is refused, which is why the registry says unsupported", async () => {
    expect(ModelCapability.adapterDeclaration("@ai-sdk/anthropic").audio.support).toBe("unsupported")
    const outcome = await sendAudio("anthropic", "audio/wav")
    expect(outcome).toHaveProperty("error")
    if (!("error" in outcome)) throw new Error("unreachable")
    expect(outcome.error).toMatch(/audio\/wav/)
    expect(outcome.error).toMatch(/not supported/)
  })
})

describe("@ai-sdk/google carries any audio MIME", () => {
  test.each(["audio/wav", "audio/flac", "audio/ogg", "audio/mp3"])(
    "%s passes through as inlineData, which is why the registry says any",
    async (mediaType) => {
      expect(ModelCapability.adapterDeclaration("@ai-sdk/google").audio.mimeTypes).toBe("any")
      const outcome = await sendAudio("google", mediaType)
      expect(outcome).not.toHaveProperty("error")
      if ("error" in outcome) throw new Error("unreachable")
      expect(outcome.parts).toEqual([{ inlineData: { mimeType: mediaType, data: AUDIO } }])
    },
  )
})
