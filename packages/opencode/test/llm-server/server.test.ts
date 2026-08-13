import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { LLMServer } from "../../src/llm-server/server"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

const TOKEN = "test-token-value"

/**
 * A provider whose two models differ only in declared output modality.
 *
 * That is the whole point: model KIND is derived from `modalities.output`, so a
 * config-declared TTS model needs no schema field and no registry entry — which
 * matters because OpenAI's own `tts-1` and `gpt-4o-mini-tts` are absent from
 * models.dev.
 */
const config = {
  provider: {
    test: {
      name: "Test",
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "unused", baseURL: "http://127.0.0.1:1/v1" },
      models: {
        "chat-model": {
          name: "Chat Model",
          modalities: { input: ["text" as const], output: ["text" as const] },
        },
        "tts-model": {
          name: "TTS Model",
          modalities: { input: ["text" as const], output: ["audio" as const] },
        },
      },
    },
  },
}

function post(app: ReturnType<typeof LLMServer.create>, path: string, body: unknown, token = TOKEN) {
  return app.fetch(
    new Request(`http://llm-server.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  )
}

describe("authentication", () => {
  // These assertions deliberately need no instance: the auth middleware is
  // registered ahead of the instance middleware, so a rejected request never
  // reaches provider config at all.
  const app = () => LLMServer.create({ token: TOKEN, directory: process.cwd() })

  test("rejects a request with no credential", async () => {
    const res = await app().fetch(new Request("http://llm-server.test/v1/models"))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "invalid_api_key" } })
  })

  test("rejects a wrong bearer token", async () => {
    const res = await app().fetch(
      new Request("http://llm-server.test/v1/models", { headers: { authorization: "Bearer nope" } }),
    )
    expect(res.status).toBe(401)
  })

  test("rejects a token of a different length", async () => {
    // Exercises the length pre-check: `timingSafeEqual` throws on mismatched
    // lengths rather than returning false, so without it this would be a 500.
    const res = await app().fetch(
      new Request("http://llm-server.test/v1/models", { headers: { authorization: "Bearer x" } }),
    )
    expect(res.status).toBe(401)
  })

  test("rejects an Authorization header that omits the Bearer scheme", async () => {
    const res = await app().fetch(
      new Request("http://llm-server.test/v1/models", { headers: { authorization: TOKEN } }),
    )
    expect(res.status).toBe(401)
  })

  test("rejects a wrong x-api-key", async () => {
    const res = await app().fetch(
      new Request("http://llm-server.test/v1/models", { headers: { "x-api-key": "nope-nope-nope" } }),
    )
    expect(res.status).toBe(401)
  })

  test("requires a credential for OPTIONS too, so no unauthenticated request boots an instance", async () => {
    // CORS headers are not served, so exempting OPTIONS would buy nothing while
    // letting an anonymous request reach the instance middleware.
    const res = await app().fetch(new Request("http://llm-server.test/v1/models", { method: "OPTIONS" }))
    expect(res.status).toBe(401)
  })
})

describe("accepted credential forms", () => {
  test("accepts a bearer token, a raw x-api-key, and a prefixed x-api-key alike", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    const url = "http://llm-server.test/v1/models"

    const headerForms: Record<string, string>[] = [
      { authorization: `Bearer ${TOKEN}` },
      // The convention of x-api-key is a RAW value; clients that send this header
      // do not add a scheme, and requiring one produced a confusing 401.
      { "x-api-key": TOKEN },
      { "x-api-key": `Bearer ${TOKEN}` },
    ]
    for (const headers of headerForms) {
      const res = await app.fetch(new Request(url, { headers }))
      expect(res.status).toBe(200)
    }
  })
})

describe("model listing", () => {
  test("lists every configured model as provider/model", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    const res = await app.fetch(
      new Request("http://llm-server.test/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } }),
    )
    const body = (await res.json()) as { object: string; data: { id: string; owned_by: string }[] }
    expect(body.object).toBe("list")
    const ids = body.data.map((m) => m.id)
    expect(ids).toContain("test/chat-model")
    // Listed regardless of kind, matching OpenAI, whose /v1/models also returns
    // tts and embedding models.
    expect(ids).toContain("test/tts-model")
    expect(body.data.find((m) => m.id === "test/chat-model")!.owned_by).toBe("test")
  })

  test("an allowlist hides what the token cannot call", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path, models: ["test/chat-model"] })
    const res = await app.fetch(
      new Request("http://llm-server.test/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } }),
    )
    const body = (await res.json()) as { data: { id: string }[] }
    expect(body.data.map((m) => m.id)).toEqual(["test/chat-model"])
  })
})

describe("model reference errors", () => {
  test("404s a model outside the allowlist without revealing whether it exists", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path, models: ["test/chat-model"] })
    const res = await post(app, "/v1/chat/completions", {
      model: "test/tts-model",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: "model_not_found" } })
  })

  test("404s an unknown model", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    const res = await post(app, "/v1/chat/completions", {
      model: "test/nope",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: "model_not_found" } })
  })

  test("400s a reference that omits the provider prefix", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    const res = await post(app, "/v1/chat/completions", {
      model: "chat-model",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain("provider/model")
  })
})

describe("cross-endpoint misuse", () => {
  // The value here is the MESSAGE, not the status: without this gate the caller
  // gets whatever opaque failure the provider produces for a nonsensical request.
  test("a speech model posted to chat completions is told to use the speech route", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    const res = await post(app, "/v1/chat/completions", {
      model: "test/tts-model",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain("/v1/audio/speech")
  })

  test("a chat model posted to the speech route is told to use chat completions", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    const res = await post(app, "/v1/audio/speech", { model: "test/chat-model", input: "hello" })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain("/v1/chat/completions")
  })
})

describe("request validation at the route", () => {
  test("a stock OpenAI client payload is not rejected over fields we merely ignore", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    const res = await post(app, "/v1/chat/completions", {
      model: "test/nope-so-we-stop-before-the-network",
      messages: [{ role: "user", content: "hi" }],
      parallel_tool_calls: true,
      store: false,
      metadata: {},
      service_tier: "auto",
    })
    // 404 for the unknown model proves validation let the request through; a 400
    // would mean the extra fields were rejected.
    expect(res.status).toBe(404)
  })

  test("400s response_format instead of silently answering in the wrong shape", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    const res = await post(app, "/v1/chat/completions", {
      model: "test/chat-model",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain("response_format")
  })

  test("400s an unparseable image_url rather than letting it become a 502", async () => {
    // `new URL` throwing inside the handler used to land in the generic error
    // branch, which made a permanent client mistake look like a retryable outage.
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    const res = await post(app, "/v1/chat/completions", {
      model: "test/chat-model",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "not-a-url" } }] }],
    })
    expect(res.status).toBe(400)
  })

  test("accepts both accepted image_url forms", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    for (const url of ["data:image/png;base64,AAAB", "https://example.com/a.png"]) {
      const res = await post(app, "/v1/chat/completions", {
        model: "test/nope-so-we-stop-before-the-network",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
      })
      // 404 on the model proves validation accepted the URL.
      expect(res.status).toBe(404)
    }
  })

  test("400s a malformed body", async () => {    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    const res = await app.fetch(
      new Request("http://llm-server.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: "{not json",
      }),
    )
    expect(res.status).toBe(400)
  })

  test("400s SSE speech streaming rather than stalling a client that awaits frames", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    const res = await post(app, "/v1/audio/speech", {
      model: "test/tts-model",
      input: "hello",
      stream_format: "sse",
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain("stream_format")
  })
})

describe("speech capability", () => {
  test("501s, naming the package, when the provider has no speech factory", async () => {
    // Reaches Provider.getSpeech for real. `@ai-sdk/openai-compatible` — the
    // package behind every custom endpoint — exposes no speech factory, and the
    // distinction matters: the model exists and the request is well formed, so
    // this is neither a 404 telling the caller to hunt for a typo nor a 502
    // implying an outage.
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    const res = await post(app, "/v1/audio/speech", { model: "test/tts-model", input: "hello" })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: { message: string; code: string } }
    expect(body.error.code).toBe("unsupported_capability")
    expect(body.error.message).toContain("@ai-sdk/openai-compatible")
  })

  test("enforces the allowlist on the speech route as well", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path, models: ["test/chat-model"] })
    const res = await post(app, "/v1/audio/speech", { model: "test/tts-model", input: "hello" })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: "model_not_found" } })
  })

  test("404s an unknown model on the speech route", async () => {
    await using tmp = await tmpdir({ config })
    const app = LLMServer.create({ token: TOKEN, directory: tmp.path })
    const res = await post(app, "/v1/audio/speech", { model: "test/nope", input: "hello" })
    expect(res.status).toBe(404)
  })
})

describe("listener", () => {
  test("refuses to bind anywhere but loopback", async () => {
    // A reachable port would proxy paid model access to whoever found it, so this
    // is a hard failure with no override flag.
    await expect(
      LLMServer.listen({ token: TOKEN, directory: process.cwd(), port: 0, hostname: "0.0.0.0" }),
    ).rejects.toThrow(/loopback/)
  })

  test("binds a free port and reports a reachable base url", async () => {
    await using tmp = await tmpdir({ config })
    const server = await LLMServer.listen({ token: TOKEN, directory: tmp.path, port: 0 })
    try {
      expect(server.port).toBeGreaterThan(0)
      // Never the control server's default port, which `port: 0` would otherwise
      // reach through the shared adapter's "try 4096 first" behaviour.
      expect(server.port).not.toBe(4096)
      expect(server.url).toBe(`http://127.0.0.1:${server.port}/v1`)
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/models`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  test("generates distinct tokens so two task servers cannot replay each other", () => {
    const a = LLMServer.generateToken()
    const b = LLMServer.generateToken()
    expect(a).not.toBe(b)
    // 256 bits, base64url: no padding, no characters needing escaping.
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
