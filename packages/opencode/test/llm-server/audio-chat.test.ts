import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { LLMServer } from "../../src/llm-server/server"
import { LLMServerTokens } from "../../src/llm-server/tokens"
import { transcriptionMediaType } from "../../src/llm-server/protocol"
import { tmpdir } from "../fixture/fixture"

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

const TOKEN = "audio-chat-token-0"

function wav(payload: string) {
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from("....WAVE"), Buffer.from(payload)])
}

type Seen = { body: Record<string, unknown>; auth?: string }

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
  fn: (ctx: { app: ReturnType<typeof LLMServer.create>; dir: string; seen: Seen[]; token: string }) => Promise<T>,
) {
  const seen: Seen[] = []
  const upstream = vendor({ ...input, seen })
  try {
    if (!upstream.port) throw new Error("fake vendor did not bind a port")
    await using tmp = await tmpdir({ config: config(upstream.port) })
    const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: {} })
    return await fn({
      app: LLMServer.create({ directory: tmp.path }),
      dir: tmp.path,
      seen,
      token: issued.token,
    })
  } finally {
    await upstream.stop(true)
  }
}

function speech(app: ReturnType<typeof LLMServer.create>, token: string, body: unknown) {
  return app.fetch(
    new Request("http://x/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  )
}

function upload(app: ReturnType<typeof LLMServer.create>, token: string, fields: Record<string, string | File>) {
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

  test("a MULTIMODAL chat model stays on the chat route", async () => {
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
      const app = LLMServer.create({ directory: tmp.path })
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
