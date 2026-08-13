import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Instance } from "../../src/project/instance"
import { LLMServer } from "../../src/llm-server/server"
import { LLMServerTokens } from "../../src/llm-server/tokens"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

/**
 * End-to-end coverage of the speech route, which until now had none.
 *
 * The chat e2e can use `@ai-sdk/openai-compatible`, but that package exposes no
 * speech factory at all, so a speech test needs a provider whose SDK actually has
 * one. `@ai-sdk/openai` does (it sets both `speech` and `speechModel`) and it
 * accepts a `baseURL`, so it can be aimed at a local fake that answers
 * `POST /v1/audio/speech` with bytes. That exercises the real chain:
 * `Provider.getSpeech` → the real SDK → HTTP → our route → the caller.
 */

const SKILL_DIR = path.join(import.meta.dir, "..", "fixture", "skills", "llm-endpoint-demo")
const SPEAK = path.join(SKILL_DIR, "speak.mjs")
const TTS = "openai/tts-1"

/** WAV bytes: the SDK sniffs media type from the signature, and `RIFF` means wav. */
function wav(payload: string) {
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from("....WAVEfmt "), Buffer.from(payload)])
}

type Seen = { path: string; body: Record<string, unknown> }

function vendor(input: { bytes: Buffer; status?: number; seen: Seen[] }) {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      input.seen.push({ path: url.pathname, body: await req.json().catch(() => ({})) })
      if (input.status && input.status >= 400) {
        return new Response(JSON.stringify({ error: { message: "vendor refused" } }), { status: input.status })
      }
      // A binary body with no JSON content type, exactly as a speech API replies.
      return new Response(new Uint8Array(input.bytes), { headers: { "content-type": "application/octet-stream" } })
    },
  })
}

/**
 * A provider whose package HAS a speech factory, plus one model of each kind so
 * cross-endpoint behaviour is testable. `tts-1` is absent from the public registry,
 * so its audio output modality is declared here — which is exactly the workflow the
 * skill documents.
 */
function config(port: number) {
  return {
    provider: {
      openai: {
        name: "Fake OpenAI",
        npm: "@ai-sdk/openai",
        options: { apiKey: "vendor-key-must-not-leak", baseURL: `http://127.0.0.1:${port}/v1` },
        models: {
          "tts-1": { name: "TTS", modalities: { input: ["text" as const], output: ["audio" as const] } },
          "gpt-chat": { name: "Chat", modalities: { input: ["text" as const], output: ["text" as const] } },
        },
      },
    },
  }
}

async function runSpeak(input: {
  baseUrl: string
  apiKey: string
  model?: string
  out: string
  format?: string
  voice?: string
}) {
  const proc = Bun.spawn([process.execPath, SPEAK, "hello there"], {
    env: {
      PATH: process.env["PATH"] ?? "",
      OPENAI_BASE_URL: input.baseUrl,
      OPENAI_API_KEY: input.apiKey,
      OPENAI_TTS_MODEL: input.model ?? TTS,
      OPENAI_TTS_OUT: input.out,
      ...(input.format ? { OPENAI_TTS_FORMAT: input.format } : {}),
      ...(input.voice ? { OPENAI_TTS_VOICE: input.voice } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trim(), stderr, code }
}

async function harness<T>(
  input: { bytes?: Buffer; status?: number },
  fn: (ctx: { dir: string; url: string; seen: Seen[]; out: string }) => Promise<T>,
) {
  const seen: Seen[] = []
  const upstream = vendor({ bytes: input.bytes ?? wav("audio-payload"), status: input.status, seen })
  try {
    if (!upstream.port) throw new Error("fake vendor did not bind a port")
    await using tmp = await tmpdir({ config: config(upstream.port) })
    const server = await LLMServer.listen({ directory: tmp.path, port: 0 })
    const out = path.join(os.tmpdir(), `llm-server-tts-${crypto.randomUUID()}.bin`)
    try {
      return await fn({ dir: tmp.path, url: server.url, seen, out })
    } finally {
      await server.stop()
      await fs.rm(out, { force: true })
    }
  } finally {
    await upstream.stop(true)
  }
}

describe("speech through the local endpoint", () => {
  test("returns the vendor's bytes and writes them to a file", async () => {
    const expected = wav("audio-payload")
    const result = await harness({ bytes: expected }, async ({ dir, url, out }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: {}, models: [TTS] })
      const run = await runSpeak({ baseUrl: url, apiKey: issued.token, out })
      const written = await fs.readFile(out).catch(() => Buffer.alloc(0))
      return { run, written }
    })
    expect(result.run.code).toBe(0)
    // Byte-exact: nothing in the chain may transcode or truncate the audio.
    expect(result.written.equals(expected)).toBe(true)
    expect(result.run.stdout.startsWith(`${expected.byteLength} `)).toBe(true)
  })

  test("reports the media type the provider actually produced, not the one requested", async () => {
    // The bytes say wav; the request asked for mp3. The provider's answer wins,
    // because mislabelling audio is worse than ignoring a preference.
    const result = await harness({ bytes: wav("x") }, async ({ dir, url, out }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: {}, models: [TTS] })
      return runSpeak({ baseUrl: url, apiKey: issued.token, out, format: "mp3" })
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("audio/wav")
  })

  test("falls back to the requested format when the bytes are unrecognizable", async () => {
    const result = await harness({ bytes: Buffer.from("not-a-known-audio-signature") }, async ({ dir, url, out }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: {}, models: [TTS] })
      return runSpeak({ baseUrl: url, apiKey: issued.token, out, format: "flac" })
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("audio/flac")
  })

  test("passes the caller's voice and format through to the provider", async () => {
    const result = await harness({}, async ({ dir, url, out, seen }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: {}, models: [TTS] })
      const run = await runSpeak({ baseUrl: url, apiKey: issued.token, out, format: "opus", voice: "nova" })
      return { run, seen }
    })
    expect(result.run.code).toBe(0)
    const call = result.seen.find((s) => s.path === "/v1/audio/speech")
    expect(call).toBeDefined()
    expect(call!.body).toMatchObject({ model: "tts-1", input: "hello there", voice: "nova" })
    expect(call!.body["response_format"]).toBe("opus")
  })

  test("the vendor key never reaches the skill", async () => {
    const result = await harness({}, async ({ dir, url, out }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: {}, models: [TTS] })
      expect(issued.token).not.toContain("vendor-key")
      return runSpeak({ baseUrl: url, apiKey: issued.token, out })
    })
    expect(result.code).toBe(0)
    expect(result.stdout + result.stderr).not.toContain("vendor-key")
  })
})

describe("speech failure modes", () => {
  test("an expired token exits 2 on the speech route too", async () => {
    const result = await harness({}, async ({ dir, url, out }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: { idleMs: 200 }, models: [TTS] })
      await Bun.sleep(600)
      return runSpeak({ baseUrl: url, apiKey: issued.token, out })
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("expired_api_key")
  })

  test("reissuing recovers speech without a new base_url", async () => {
    const result = await harness({}, async ({ dir, url, out }) => {
      const first = await LLMServerTokens.issue({ directory: dir, expiry: { idleMs: 200 }, models: [TTS] })
      await Bun.sleep(600)
      const expired = await runSpeak({ baseUrl: url, apiKey: first.token, out })
      const second = await LLMServerTokens.issue({ directory: dir, expiry: {}, models: [TTS] })
      const recovered = await runSpeak({ baseUrl: url, apiKey: second.token, out })
      return { expired, recovered }
    })
    expect(result.expired.code).toBe(2)
    expect(result.recovered.code).toBe(0)
  })

  test("a chat model on the speech route exits 3 and names the right endpoint", async () => {
    const result = await harness({}, async ({ dir, url, out }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: {} })
      return runSpeak({ baseUrl: url, apiKey: issued.token, out, model: "openai/gpt-chat" })
    })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("/v1/chat/completions")
  })

  test("a token scoped to the chat model cannot reach the speech model", async () => {
    const result = await harness({}, async ({ dir, url, out }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: {}, models: ["openai/gpt-chat"] })
      return runSpeak({ baseUrl: url, apiKey: issued.token, out })
    })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("model_not_found")
  })

  test("a vendor failure exits 3, and the audio file is not created", async () => {
    const result = await harness({ status: 500 }, async ({ dir, url, out }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: {}, models: [TTS] })
      const run = await runSpeak({ baseUrl: url, apiKey: issued.token, out })
      const exists = await fs.stat(out).then(() => true, () => false)
      return { run, exists }
    })
    expect(result.run.code).toBe(3)
    expect(result.exists).toBe(false)
  })

  test("refuses SSE streaming instead of stalling a client that awaits frames", async () => {
    const result = await harness({}, async ({ dir, url }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: {}, models: [TTS] })
      const res = await fetch(`${url}/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
        body: JSON.stringify({ model: TTS, input: "hi", stream_format: "sse" }),
      })
      return { status: res.status, body: (await res.json()) as { error: { message: string } } }
    })
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain("stream_format")
  })

  test("reports a missing speech environment as 4", async () => {
    const result = await harness({}, async ({ url, out }) =>
      runSpeak({ baseUrl: url, apiKey: "", out, model: "" }),
    )
    expect(result.code).toBe(4)
    expect(result.stderr).toContain("OPENAI_TTS_MODEL")
  })
})
