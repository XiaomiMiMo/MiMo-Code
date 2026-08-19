import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { capabilityApp, type CapabilityApp } from "./harness"
import { LLMServerTokens } from "../../src/llm-server/tokens"
import { transcriptionMediaType } from "../../src/llm-server/protocol"
import { tmpdir } from "../fixture/fixture"
import { pathToFileURL } from "node:url"
import path from "node:path"

afterEach(async () => {
  await Instance.disposeAll()
})

/**
 * Audio carried over `POST /v1/chat/completions`, which is how MiMo, Gemini's
 * audio-out models, and `gpt-4o-audio-preview` all do it.
 *
 * The vendor here is a local fake, but the shapes are copied from a verified live
 * exchange with `api.xiaomimimo.com`: synthesis returns base64 in `message.audio`,
 * transcription returns the transcript in `message.content`.
 */


function wav(payload: string) {
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from("....WAVE"), Buffer.from(payload)])
}

/** `headers` is captured only where a test asserts on them, hence optional. */
type Seen = { body: Record<string, unknown>; auth?: string; headers?: Headers }

function vendor(input: { seen: Seen[]; audio?: Buffer; transcript?: string; status?: number; error?: unknown }) {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      input.seen.push({
        body: (await req.json().catch(() => ({}))) as Record<string, unknown>,
        auth: req.headers.get("authorization") ?? undefined,
      })
      if (input.status && input.status >= 400) {
        return new Response(JSON.stringify(input.error ?? { error: { message: "vendor refused" } }), {
          status: input.status,
          headers: { "content-type": "application/json" },
        })
      }
      // The raw passthrough asks for a plain completion; the SDK path (used by the
      // multimodal transcription fallback) asks for a stream. One vendor serves both, so
      // the tests exercise whichever path the code actually chose.
      const last = input.seen[input.seen.length - 1]!.body
      if (last["stream"] === true) {
        const frame = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({
            id: "up-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        return new Response(
          frame({ content: input.transcript ?? "" }, null) + frame({}, "stop") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      const message = input.audio
        ? { role: "assistant", content: "", audio: { data: input.audio.toString("base64"), id: "a1" } }
        : { role: "assistant", content: input.transcript ?? "" }
      return new Response(JSON.stringify({ choices: [{ index: 0, message, finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" },
      })
    },
  })
}

/**
 * Both models declared on ONE provider whose package has no audio factory, which is
 * what forces the chat-completions path. Kinds come from modalities alone.
 */
function config(port: number) {
  return {
    provider: {
      audiochat: {
        name: "Audio over chat",
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "vendor-key-must-not-leak", baseURL: `http://127.0.0.1:${port}/v1` },
        models: {
          tts: { name: "TTS", modalities: { input: ["text" as const], output: ["audio" as const] } },
          asr: { name: "ASR", modalities: { input: ["audio" as const], output: ["text" as const] } },
          chat: { name: "Chat", modalities: { input: ["text" as const], output: ["text" as const] } },
          // A multimodal chat model: hears audio AND reads text. Must stay `language`,
          // because a dedicated ASR endpoint refuses text parts while this one needs an
          // instruction — incompatible request shapes.
          multimodal: {
            name: "Multimodal",
            modalities: { input: ["text" as const, "audio" as const], output: ["text" as const] },
          },
        },
      },
    },
  }
}

async function harness<T>(
  input: { audio?: Buffer; transcript?: string; status?: number; error?: unknown },
  fn: (ctx: { app: CapabilityApp; dir: string; seen: Seen[]; token: string }) => Promise<T>,
) {
  const seen: Seen[] = []
  const upstream = vendor({ ...input, seen })
  try {
    if (!upstream.port) throw new Error("fake vendor did not bind a port")
    await using tmp = await tmpdir({ config: config(upstream.port) })
    const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: {} })
    return await fn({
      app: capabilityApp(tmp.path),
      dir: tmp.path,
      seen,
      token: issued.token,
    })
  } finally {
    await upstream.stop(true)
  }
}

function speech(app: CapabilityApp, token: string, body: unknown) {
  return app.fetch(
    new Request("http://x/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  )
}

function upload(app: CapabilityApp, token: string, fields: Record<string, string | File>) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return app.fetch(
    new Request("http://x/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    }),
  )
}

describe("synthesis over chat completions", () => {
  test("returns the vendor's audio, and puts the text in an assistant message", async () => {
    // The placement is the convention's requirement, not a preference: MiMo does not
    // synthesize target text sent in a `user` message.
    const expected = wav("payload")
    const result = await harness({ audio: expected }, async ({ app, token, seen }) => {
      const res = await speech(app, token, {
        model: "audiochat/tts",
        input: "hello there",
        voice: "Chloe",
        response_format: "wav",
        instructions: "calm, clear",
      })
      return { status: res.status, type: res.headers.get("content-type"), bytes: Buffer.from(await res.arrayBuffer()), seen }
    })
    expect(result.status).toBe(200)
    expect(result.type).toBe("audio/wav")
    expect(result.bytes.equals(expected)).toBe(true)

    const sent = result.seen[0]!.body
    expect(sent["model"]).toBe("tts")
    expect(sent["messages"]).toEqual([
      { role: "user", content: "calm, clear" },
      { role: "assistant", content: "hello there" },
    ])
    expect(sent["audio"]).toEqual({ format: "wav", voice: "Chloe" })
  })

  test("omits the instruction message when the caller gave none", async () => {
    const result = await harness({ audio: wav("x") }, async ({ app, token, seen }) => {
      await speech(app, token, { model: "audiochat/tts", input: "just this" })
      return seen
    })
    expect(result[0]!.body["messages"]).toEqual([{ role: "assistant", content: "just this" }])
  })

  test("the vendor key authenticates upstream and never reaches the caller", async () => {
    const result = await harness({ audio: wav("x") }, async ({ app, token, seen }) => {
      const res = await speech(app, token, { model: "audiochat/tts", input: "hi" })
      return { body: Buffer.from(await res.arrayBuffer()).toString(), seen }
    })
    expect(result.seen[0]!.auth).toBe("Bearer vendor-key-must-not-leak")
    expect(result.body).not.toContain("vendor-key")
  })

  test("an empty audio payload is a 502, not an empty file", async () => {
    const result = await harness({ transcript: "" }, async ({ app, token }) => {
      const res = await speech(app, token, { model: "audiochat/tts", input: "hi" })
      return { status: res.status, body: (await res.json()) as { error: { message: string } } }
    })
    expect(result.status).toBe(502)
    expect(result.body.error.message).toContain("no audio")
  })

  test("an upstream refusal surfaces its reason, including the param half", async () => {
    // MiMo answers `message: "Param Incorrect"` with the actual cause in `param`.
    // Reporting only `message` hid the reason behind a phrase that says nothing.
    const result = await harness(
      { status: 400, error: { error: { message: "Param Incorrect", param: "mime type must be audio/wav" } } },
      async ({ app, token }) => {
        const res = await speech(app, token, { model: "audiochat/tts", input: "hi" })
        return { status: res.status, body: (await res.json()) as { error: { message: string } } }
      },
    )
    expect(result.status).toBe(502)
    expect(result.body.error.message).toContain("Param Incorrect")
    expect(result.body.error.message).toContain("mime type must be audio/wav")
  })
})

describe("transcription over chat completions", () => {
  test("uploads multipart and returns the transcript as json", async () => {
    const result = await harness({ transcript: "the quick brown fox" }, async ({ app, token, seen }) => {
      const res = await upload(app, token, {
        file: new File([wav("audio")], "speech.wav", { type: "audio/wav" }),
        model: "audiochat/asr",
        language: "auto",
      })
      return { status: res.status, body: (await res.json()) as { text: string }, seen }
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ text: "the quick brown fox" })

    const sent = result.seen[0]!.body
    expect(sent["asr_options"]).toEqual({ language: "auto" })
    const messages = sent["messages"] as { role: string; content: { type: string; input_audio: { data: string } }[] }[]
    expect(messages[0]!.role).toBe("user")
    expect(messages[0]!.content[0]!.type).toBe("input_audio")
    expect(messages[0]!.content[0]!.input_audio.data.startsWith("data:audio/wav;base64,")).toBe(true)
  })

  test("response_format text returns the bare transcript", async () => {
    const result = await harness({ transcript: "bare text" }, async ({ app, token }) => {
      const res = await upload(app, token, {
        file: new File([wav("a")], "a.wav", { type: "audio/wav" }),
        model: "audiochat/asr",
        response_format: "text",
      })
      return { type: res.headers.get("content-type") ?? "", text: await res.text() }
    })
    // The bare transcript, not a JSON envelope: that is what the format asks for.
    expect(result.text).toBe("bare text")
    expect(result.type).not.toContain("application/json")
  })

  test("omits asr_options when no language was asked for", async () => {
    // Worth asserting: on the real endpoint `language: "en"` leaks `think>\n<chinese>`
    // into the transcript, so a caller who says nothing must have nothing sent.
    const result = await harness({ transcript: "clean" }, async ({ app, token, seen }) => {
      await upload(app, token, {
        file: new File([wav("a")], "a.wav", { type: "audio/wav" }),
        model: "audiochat/asr",
      })
      return seen
    })
    expect(result[0]!.body["asr_options"]).toBeUndefined()
  })

  test("400s a missing file rather than calling the vendor", async () => {
    const result = await harness({ transcript: "unused" }, async ({ app, token, seen }) => {
      const res = await upload(app, token, { model: "audiochat/asr" })
      return { status: res.status, calls: seen.length }
    })
    expect(result.status).toBe(400)
    expect(result.calls).toBe(0)
  })

  test("400s an unrecognisable container instead of mislabelling the bytes", async () => {
    const result = await harness({ transcript: "unused" }, async ({ app, token }) => {
      const res = await upload(app, token, {
        file: new File([Buffer.from("x")], "recording.bin", { type: "application/octet-stream" }),
        model: "audiochat/asr",
      })
      return { status: res.status, body: (await res.json()) as { error: { message: string } } }
    })
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain("media type")
  })

  test("refuses prompt and temperature rather than dropping them", async () => {
    // A dedicated ASR endpoint has nowhere to put a prompt: it refuses text parts.
    const extras: Record<string, string>[] = [{ prompt: "hotwords" }, { temperature: "0.5" }]
    for (const extra of extras) {
      const result = await harness({ transcript: "unused" }, async ({ app, token }) => {
        const res = await upload(app, token, {
          file: new File([wav("a")], "a.wav", { type: "audio/wav" }),
          model: "audiochat/asr",
          ...extra,
        })
        return { status: res.status, body: (await res.json()) as { error: { message: string } } }
      })
      expect(result.status).toBe(400)
    }
  })

  test("refuses the subtitle formats it cannot produce", async () => {
    const result = await harness({ transcript: "unused" }, async ({ app, token }) => {
      const res = await upload(app, token, {
        file: new File([wav("a")], "a.wav", { type: "audio/wav" }),
        model: "audiochat/asr",
        response_format: "srt",
      })
      return { status: res.status, body: (await res.json()) as { error: { message: string } } }
    })
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain("json or text")
  })
})

describe("kind derivation routes each model to one endpoint", () => {
  test("a speech model on the chat route is told to use the speech route", async () => {
    const result = await harness({ audio: wav("x") }, async ({ app, token }) => {
      const res = await app.fetch(
        new Request("http://x/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: "audiochat/tts", messages: [{ role: "user", content: "hi" }] }),
        }),
      )
      return { status: res.status, body: (await res.json()) as { error: { message: string } } }
    })
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain("/v1/audio/speech")
  })

  test("a transcription model on the chat route is told to use the transcription route", async () => {
    const result = await harness({ transcript: "x" }, async ({ app, token }) => {
      const res = await app.fetch(
        new Request("http://x/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: "audiochat/asr", messages: [{ role: "user", content: "hi" }] }),
        }),
      )
      return { status: res.status, body: (await res.json()) as { error: { message: string } } }
    })
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain("/v1/audio/transcriptions")
  })

  test.skip("superseded: a multimodal chat model is now served as a transcription fallback", async () => {
    // The guard that matters: `mimo-v2.5` and every Gemini declare audio INPUT
    // alongside text. Classifying those as transcription models would route the whole
    // multimodal fleet away from chat.
    const result = await harness({ transcript: "x" }, async ({ app, token }) => {
      const res = await upload(app, token, {
        file: new File([wav("a")], "a.wav", { type: "audio/wav" }),
        model: "audiochat/multimodal",
      })
      return { status: res.status, body: (await res.json()) as { error: { message: string } } }
    })
    // Refused BY the transcription route, pointed back at chat.
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain("language model")
  })

  test("a chat model on the transcription route is refused", async () => {
    const result = await harness({ transcript: "x" }, async ({ app, token }) => {
      const res = await upload(app, token, {
        file: new File([wav("a")], "a.wav", { type: "audio/wav" }),
        model: "audiochat/chat",
      })
      return res.status
    })
    expect(result).toBe(400)
  })

  test("the allowlist covers the transcription route too", async () => {
    const seen: Seen[] = []
    const upstream = vendor({ seen, transcript: "x" })
    try {
      await using tmp = await tmpdir({ config: config(upstream.port!) })
      const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: {}, models: ["audiochat/chat"] })
      const app = capabilityApp(tmp.path)
      const res = await upload(app, issued.token, {
        file: new File([wav("a")], "a.wav", { type: "audio/wav" }),
        model: "audiochat/asr",
      })
      expect(res.status).toBe(404)
    } finally {
      await upstream.stop(true)
    }
  })
})

describe("multimodal fallback for transcription", () => {
  /**
   * A model that can hear will transcribe when told to, so a dedicated ASR model is
   * preferred but not required. Measured on `mimo-v2.5`: its verbatim output was
   * actually cleaner than `mimo-v2.5-asr` under `language: "en"`.
   *
   * The two need different requests, which is why kind still decides the shape: an ASR
   * endpoint REFUSES text parts while a chat model REQUIRES the instruction.
   */
  test("suppresses thinking so the transcript lands in content, not reasoning", async () => {
    // The fix that makes this a contract instead of a coin flip. A reasoning model asked
    // to transcribe otherwise emits the transcript as `reasoning_content` with
    // `content: null` some of the time. `thinking: {type: "disabled"}` is MiMo's control,
    // and measured three consecutive runs it moved the transcript into `content` with
    // `reasoning_tokens: 0`.
    //
    // It can only be sent on the RAW path: `@ai-sdk/openai-compatible` validates provider
    // options against a closed schema with no `thinking` and offers no extra-body escape,
    // so the SDK path structurally cannot ask for it.
    const result = await harness({ transcript: "spoken words" }, async ({ app, token, seen }) => {
      const res = await upload(app, token, {
        file: new File([wav("a")], "a.wav", { type: "audio/wav" }),
        model: "audiochat/multimodal",
      })
      return { status: res.status, seen }
    })
    expect(result.status).toBe(200)
    const sent = result.seen[0]!.body
    expect(sent["thinking"]).toEqual({ type: "disabled" })
    // The instruction rides along, and asr_options does NOT: that belongs to the
    // dedicated endpoint, which refuses text parts entirely.
    const messages = sent["messages"] as { content: { type: string; text?: string }[] }[]
    expect(messages[0]!.content.some((p) => p.type === "input_audio")).toBe(true)
    expect(messages[0]!.content.find((p) => p.type === "text")?.text).toContain("verbatim")
    expect(sent["asr_options"]).toBeUndefined()
  })

  test("a dedicated ASR model gets no instruction and no thinking control", async () => {
    // The opposite shape, on the same route. MiMo answers 400 "ASR request must not
    // include text parts", so sending one would break it.
    const result = await harness({ transcript: "clean" }, async ({ app, token, seen }) => {
      const res = await upload(app, token, {
        file: new File([wav("a")], "a.wav", { type: "audio/wav" }),
        model: "audiochat/asr",
        language: "auto",
      })
      return { status: res.status, seen }
    })
    expect(result.status).toBe(200)
    const sent = result.seen[0]!.body
    const messages = sent["messages"] as { content: { type: string }[] }[]
    expect(messages[0]!.content.every((p) => p.type === "input_audio")).toBe(true)
    expect(sent["thinking"]).toBeUndefined()
    expect(sent["asr_options"]).toEqual({ language: "auto" })
  })

  test.skip("superseded by the raw path: served through the SDK instead", async () => {
    const result = await harness({ transcript: "spoken words here" }, async ({ app, token, seen }) => {
      const res = await upload(app, token, {
        file: new File([wav("a")], "a.wav", { type: "audio/wav" }),
        model: "audiochat/multimodal",
        language: "en",
      })
      return { status: res.status, body: (await res.json()) as { text: string }, seen }
    })
    expect(result.status).toBe(200)
    expect(result.body.text).toBe("spoken words here")

    // The SDK path, not the raw one: an audio file part becomes `input_audio`, and the
    // instruction rides alongside it. `asr_options` must NOT appear — that belongs to
    // the dedicated endpoint only.
    const sent = result.seen[0]!.body
    expect(sent["asr_options"]).toBeUndefined()
    const messages = sent["messages"] as { role: string; content: { type: string; text?: string }[] }[]
    const parts = messages[0]!.content
    expect(parts.some((p) => p.type === "input_audio")).toBe(true)
    const instruction = parts.find((p) => p.type === "text")?.text ?? ""
    expect(instruction).toContain("verbatim")
    // The language hint reaches the model as words, since there is no field for it here.
    expect(instruction).toContain("en")
  })

  test("reports a legible failure when the model answers as reasoning instead of content", async () => {
    // Measured on `mimo-v2.5`: the transcript sometimes arrives as `reasoning_content`
    // with `content: null`. Reading reasoning as the transcript is unsafe — on other
    // calls that field held "The user wants a verbatim transcription..." — so this
    // fails legibly rather than guessing, and names what to configure instead.
    const seen: Seen[] = []
    const upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            choices: [
              { index: 0, message: { role: "assistant", content: null, reasoning_content: "words" }, finish_reason: "stop" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    })
    try {
      await using tmp = await tmpdir({ config: config(upstream.port!) })
      const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: {} })
      const app = capabilityApp(tmp.path)
      const res = await upload(app, issued.token, {
        file: new File([wav("a")], "a.wav", { type: "audio/wav" }),
        model: "audiochat/multimodal",
      })
      expect(res.status).toBe(502)
      const body = (await res.json()) as { error: { message: string } }
      expect(body.error.message).toContain("reasoning rather than content")
      expect(body.error.message).toContain("dedicated speech-to-text")
    } finally {
      await upstream.stop(true)
      void seen
    }
  })

  test("a chat model that cannot hear is still refused", async () => {
    // The fallback is for models that accept audio, not for every language model.
    const result = await harness({ transcript: "x" }, async ({ app, token }) => {
      const res = await upload(app, token, {
        file: new File([wav("a")], "a.wav", { type: "audio/wav" }),
        model: "audiochat/chat",
      })
      return { status: res.status, body: (await res.json()) as { error: { message: string } } }
    })
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain("language model")
  })
})

describe("providers whose endpoint is not OpenAI-shaped", () => {
  /**
   * The fallback must be gated on the provider PACKAGE, not on the absence of a
   * speech factory. `@ai-sdk/google` and `@ai-sdk/anthropic` have no speech factory
   * either, but their endpoints speak `:generateContent` and `/v1/messages`.
   *
   * This is not hypothetical: `google/gemini-2.5-pro-preview-tts` is declared
   * `output: ["audio"]` in the registry, so any operator with a Google provider would
   * reach this path.
   */
  function foreign(npm: string) {
    return {
      provider: {
        other: {
          name: "Not OpenAI shaped",
          npm,
          options: { apiKey: "k", baseURL: "http://127.0.0.1:1/v1" },
          models: {
            tts: { name: "TTS", modalities: { input: ["text" as const], output: ["audio" as const] } },
            asr: { name: "ASR", modalities: { input: ["audio" as const], output: ["text" as const] } },
          },
        },
      },
    }
  }

  for (const npm of ["@ai-sdk/google", "@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock"]) {
    test(`refuses synthesis for ${npm} instead of posting a chat completion at it`, async () => {
      await using tmp = await tmpdir({ config: foreign(npm) })
      const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: {} })
      const app = capabilityApp(tmp.path)
      const res = await speech(app, issued.token, { model: "other/tts", input: "hi" })
      expect(res.status).toBe(501)
      const body = (await res.json()) as { error: { message: string; code: string } }
      expect(body.error.code).toBe("unsupported_capability")
      // The message must name the package, so the operator knows what to change.
      expect(body.error.message).toContain(npm)
      expect(body.error.message).toContain("chat completions")
    })
  }

  test("refuses transcription for a non-OpenAI-shaped package too", async () => {
    await using tmp = await tmpdir({ config: foreign("@ai-sdk/google") })
    const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: {} })
    const app = capabilityApp(tmp.path)
    const res = await upload(app, issued.token, {
      file: new File([wav("a")], "a.wav", { type: "audio/wav" }),
      model: "other/asr",
    })
    expect(res.status).toBe(501)
    expect((await res.json()).error.code).toBe("unsupported_capability")
  })

  test("an OpenAI-shaped provider that answers with text is told it is a convention mismatch", async () => {
    // The other failure shape: the call SUCCEEDS and returns an ordinary completion.
    // Reporting only "no audio" would read as the provider misbehaving.
    const result = await harness({ transcript: "just text, no audio" }, async ({ app, token }) => {
      const res = await speech(app, token, { model: "audiochat/tts", input: "hi" })
      return { status: res.status, body: (await res.json()) as { error: { message: string } } }
    })
    expect(result.status).toBe(502)
    expect(result.body.error.message).toContain("message.audio")
    expect(result.body.error.message).toContain("may not carry synthesized audio")
  })
})

describe("plugin hooks on the model path", () => {
  /**
   * THE REASON THIS SURFACE LIVES ON THE INSTANCE SERVER.
   *
   * Some providers are authenticated by a plugin: `src/plugin/mimo.ts` supplies its headers
   * from `chat.headers`, applied on the agent's LLM path at `session/llm.ts:508`. A request
   * path that never triggers the hook cannot reach such a provider — being in the same process
   * is necessary but NOT sufficient. Without these two tests that behaviour is invisible until
   * someone configures such a provider and gets an unexplained 401.
   */
  async function withPlugin<T>(
    body: string[],
    fn: (input: { dir: string; token: string; seen: Seen[] }) => Promise<T>,
  ): Promise<T> {
    const seen: Seen[] = []
    const upstream = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.push({ body: (await req.json()) as Record<string, unknown>, headers: req.headers })
        return new Response(
          JSON.stringify({
            id: "up",
            object: "chat.completion",
            created: 1,
            model: "m",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        )
      },
    })
    try {
      await using tmp = await tmpdir({ git: true })
      const file = path.join(tmp.path, "plugin.ts")
      await Bun.write(file, ["export default async () => ({", ...body, "})", ""].join("\n"))
      await Bun.write(
        path.join(tmp.path, "mimocode.json"),
        JSON.stringify({
          plugin: [pathToFileURL(file).href],
          provider: {
            hooked: {
              name: "Hooked",
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "k", baseURL: `http://127.0.0.1:${upstream.port!}/v1` },
              models: { chat: { name: "Chat", modalities: { input: ["text"], output: ["text"] } } },
            },
          },
        }),
      )
      const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: {} })
      return await fn({ dir: tmp.path, token: issued.token, seen })
    } finally {
      await upstream.stop(true)
    }
  }

  async function complete(dir: string, token: string) {
    return capabilityApp(dir).fetch(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: "hooked/chat", messages: [{ role: "user", content: "hi" }] }),
      }),
    )
  }

  test("chat.headers reaches the upstream request", async () => {
    await withPlugin(
      [
        '  "chat.headers": async (input, output) => {',
        '    output.headers["x-plugin-added"] = input.model.providerID',
        "  },",
      ],
      async ({ dir, token, seen }) => {
        const res = await complete(dir, token)
        expect(res.status).toBe(200)
        // On the wire, not merely returned by the hook.
        expect(seen[0]!.headers?.get("x-plugin-added")).toBe("hooked")
      },
    )
  })

  test("chat.params can adjust what the caller asked for", async () => {
    await withPlugin(
      [
        '  "chat.params": async (_input, output) => {',
        "    output.temperature = 0.125",
        "  },",
      ],
      async ({ dir, token, seen }) => {
        const res = await complete(dir, token)
        expect(res.status).toBe(200)
        // The hook's value wins over the request's, because the request seeds the hook and the
        // hook's output is what gets sent — the same order `session/llm.ts` uses.
        expect(seen[0]!.body["temperature"]).toBe(0.125)
      },
    )
  })
})

describe("voice sources", () => {
  /**
   * `voice` carries exactly one source, so "both supplied" is unrepresentable rather than a
   * precedence rule. These lock the three arms and the two refusals.
   */
  function speechConfig(port: number, caps: Record<string, boolean> = {}) {
    return {
      provider: {
        audiochat: {
          name: "Audio over chat",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "k", baseURL: `http://127.0.0.1:${port}/v1` },
          models: {
            tts: {
              name: "TTS",
              modalities: { input: ["text" as const], output: ["audio" as const] },
              ...caps,
            },
          },
        },
      },
    }
  }

  async function speak(port: number, dir: string, body: unknown) {
    const issued = await LLMServerTokens.issue({ directory: dir, expiry: {} })
    const app = capabilityApp(dir)
    return app.fetch(
      new Request("http://x/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
        body: JSON.stringify(body),
      }),
    )
  }

  test("a preset name rides in the vendor's voice field", async () => {
    const result = await harness({ audio: Buffer.from("RIFFxxxx") }, async ({ app, token, seen }) => {
      const res = await speech(app, token, { model: "audiochat/tts", input: "hi", voice: "Chloe" })
      return { status: res.status, seen }
    })
    expect(result.status).toBe(200)
    expect(result.seen[0]!.body["audio"]).toMatchObject({ voice: "Chloe" })
  })

  test("a design description is refused unless the model declares voice_design", async () => {
    const upstream = Bun.serve({ port: 0, fetch: () => new Response("{}") })
    try {
      await using tmp = await tmpdir({ config: speechConfig(upstream.port!) })
      const res = await speak(upstream.port!, tmp.path, {
        model: "audiochat/tts",
        input: "hi",
        voice: { design: "a calm elderly man" },
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { message: string; code: string } }
      expect(body.error.code).toBe("unsupported_capability")
      // Names the config field, so the message is something an operator can act on.
      expect(body.error.message).toContain("voice_design")
    } finally {
      await upstream.stop(true)
    }
  })

  test("a declared design model gets the description folded into the instruction", async () => {
    // That is where the vendor convention puts a voice description: it IS the style
    // instruction, not a separate field.
    const seen: Seen[] = []
    const upstream = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.push({ body: (await req.json()) as Record<string, unknown> })
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "", audio: { data: Buffer.from("RIFF").toString("base64") } },
                finish_reason: "stop",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        )
      },
    })
    try {
      await using tmp = await tmpdir({ config: speechConfig(upstream.port!, { voice_design: true }) })
      const res = await speak(upstream.port!, tmp.path, {
        model: "audiochat/tts",
        input: "hi",
        voice: { design: "a calm elderly man" },
        instructions: "slowly",
      })
      expect(res.status).toBe(200)
      const messages = seen[0]!.body["messages"] as { role: string; content: string }[]
      const user = messages.find((m) => m.role === "user")?.content ?? ""
      expect(user).toContain("a calm elderly man")
      // The caller's own instruction refines the description rather than being buried by it.
      expect(user.indexOf("a calm elderly man")).toBeLessThan(user.indexOf("slowly"))
      // A design model takes no preset, so nothing must be smuggled into `voice`.
      expect((seen[0]!.body["audio"] as Record<string, unknown>)["voice"]).toBeUndefined()
    } finally {
      await upstream.stop(true)
    }
  })

  test("a bare base64 sample is given a data: URL so the container is legible", async () => {
    const seen: Seen[] = []
    const upstream = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.push({ body: (await req.json()) as Record<string, unknown> })
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "", audio: { data: Buffer.from("RIFF").toString("base64") } },
                finish_reason: "stop",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        )
      },
    })
    try {
      await using tmp = await tmpdir({ config: speechConfig(upstream.port!, { voice_clone: true }) })
      const res = await speak(upstream.port!, tmp.path, {
        model: "audiochat/tts",
        input: "hi",
        voice: { clone: { audio: "QUJD", format: "wav" } },
      })
      expect(res.status).toBe(200)
      expect((seen[0]!.body["audio"] as Record<string, string>)["voice"]).toBe("data:audio/wav;base64,QUJD")
    } finally {
      await upstream.stop(true)
    }
  })

  test("two sources in one object match no arm and are rejected by the schema", async () => {
    const upstream = Bun.serve({ port: 0, fetch: () => new Response("{}") })
    try {
      await using tmp = await tmpdir({ config: speechConfig(upstream.port!) })
      const res = await speak(upstream.port!, tmp.path, {
        model: "audiochat/tts",
        input: "hi",
        voice: { design: "x", clone: { audio: "QUJD" } },
      })
      // 400 from the union itself — no hand-written precedence rule to get wrong.
      expect(res.status).toBe(400)
    } finally {
      await upstream.stop(true)
    }
  })
})

describe("upload media types", () => {
  test("normalises the aliases platforms actually report", () => {
    // `File` reports a wav as `audio/x-wav` on some platforms, and MiMo rejects that
    // spelling outright — a failure caused purely by the alias.
    expect(transcriptionMediaType({ reported: "audio/x-wav" })).toBe("audio/wav")
    expect(transcriptionMediaType({ reported: "audio/wave" })).toBe("audio/wav")
    expect(transcriptionMediaType({ reported: "audio/mp3" })).toBe("audio/mpeg")
    expect(transcriptionMediaType({ reported: "AUDIO/WAV; charset=binary" })).toBe("audio/wav")
  })

  test("falls back to the extension when the upload claims to be bytes", () => {
    expect(transcriptionMediaType({ reported: "application/octet-stream", filename: "a.mp3" })).toBe("audio/mpeg")
    expect(transcriptionMediaType({ filename: "a.flac" })).toBe("audio/flac")
  })

  test("reports nothing rather than guessing wav", () => {
    expect(transcriptionMediaType({ reported: "application/octet-stream", filename: "a.bin" })).toBeUndefined()
    expect(transcriptionMediaType({})).toBeUndefined()
  })
})
