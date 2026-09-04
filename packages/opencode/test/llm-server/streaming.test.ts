import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { capabilityApp, type CapabilityApp } from "./harness"
import { LLMServerTokens } from "../../src/llm-server/tokens"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})


/**
 * Drive the real streaming path against a real HTTP upstream.
 *
 * The upstream is a throwaway `Bun.serve` speaking OpenAI-compatible SSE rather
 * than a mock of our own code, so the SDK's own parsing sits between the two —
 * which is the part a hand-rolled fake would quietly skip.
 */
async function withUpstream<T>(
  handler: (req: Request) => Response | Promise<Response>,
  run: (input: { app: CapabilityApp; token: string }) => Promise<T>,
) {
  const upstream = Bun.serve({ port: 0, fetch: handler })
  try {
    await using tmp = await tmpdir({
      config: {
        provider: {
          test: {
            name: "Test",
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "unused", baseURL: `http://127.0.0.1:${upstream.port}/v1` },
            models: {
              "chat-model": {
                name: "Chat Model",
                modalities: { input: ["text" as const], output: ["text" as const] },
                reasoning: true,
                // Declared explicitly rather than relying on the per-provider
                // heuristics, so this asserts OUR merge, not transform's guesswork.
                variants: { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } },
              },
            },
          },
        },
      },
    })
    // Minted from the real store rather than a constant: the static `--token` escape hatch
    // belonged to the standalone listener and is gone, so a test that fabricates a token is
    // testing nothing but its own string.
    const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: {} })
    return await run({ app: capabilityApp(tmp.path), token: issued.token })
  } finally {
    await upstream.stop(true)
  }
}

function chatRequest(token: string, body: unknown) {
  return new Request("http://llm-server.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

function sse(chunks: unknown[]) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

const frame = (delta: unknown, finish: string | null = null) => ({
  id: "upstream-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "chat-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
})

/** Split an SSE body into its `data:` payloads, in order. */
function payloads(text: string) {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.replace(/^data:\s*/, ""))
}

describe("streaming responses", () => {
  test("emits the OpenAI frame sequence and terminates with exactly one [DONE]", async () => {
    const body = await withUpstream(
      () => sse([frame({ role: "assistant", content: "" }), frame({ content: "Hi" }), frame({}, "stop")]),
      async ({ app, token }) => {
        const res = await app.fetch(chatRequest(token, {
          model: "test/chat-model",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }))
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toContain("text/event-stream")
        return await res.text()
      },
    )

    const frames = payloads(body)
    expect(frames.filter((f) => f === "[DONE]")).toHaveLength(1)
    expect(frames[frames.length - 1]).toBe("[DONE]")

    const parsed = frames.slice(0, -1).map((f) => JSON.parse(f))
    expect(parsed[0].choices[0].delta).toEqual({ role: "assistant", content: "" })
    expect(parsed.map((f) => f.choices[0]?.delta?.content).filter(Boolean).join("")).toBe("Hi")

    const terminal = parsed.at(-1)
    expect(terminal.choices[0].finish_reason).toBe("stop")
    expect(terminal.object).toBe("chat.completion.chunk")
    // Every frame echoes the reference the caller asked for, not an internal name.
    expect(parsed.every((f) => f.model === "test/chat-model")).toBe(true)
  })

  test("appends a usage-only frame when the caller asks for it", async () => {
    const body = await withUpstream(
      () => sse([frame({ content: "ok" }), frame({}, "stop")]),
      async ({ app, token }) => {
        const res = await app.fetch(chatRequest(token, {
          model: "test/chat-model",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          stream_options: { include_usage: true },
        }))
        return await res.text()
      },
    )

    const parsed = payloads(body)
      .filter((f) => f !== "[DONE]")
      .map((f) => JSON.parse(f))
    const last = parsed.at(-1)
    expect(last.choices).toEqual([])
    expect(last.usage).toMatchObject({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
    })
  })

  test("a failure BEFORE the first frame gets a real status code, not 200 plus an error frame", async () => {
    // `streamText` is lazy, so without draining one frame inside the handler an
    // expired credential would look identical to dying at token 500.
    const res = await withUpstream(
      () => new Response(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 500 }),
      async ({ app, token }) => {
        const response = await app.fetch(chatRequest(token, {
          model: "test/chat-model",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }))
        return { status: response.status, body: await response.text() }
      },
    )
    expect(res.status).toBe(502)
    expect(res.body).not.toContain("data:")
    expect(JSON.parse(res.body).error.type).toBe("api_error")
  })

  test("reports a mid-stream failure as ONE in-band frame with nothing after [DONE]", async () => {
    // Regression guard. hono's streamSSE runner appends its own `event: error`
    // frame after invoking an onError callback, so delegating the failure to it
    // produced two error frames AND content after the sentinel.
    //
    // The upstream here succeeds far enough to commit the status line and then
    // reports an error frame, which is the only situation where an in-band report
    // is the honest option. (A truncated body would NOT do: the SDK treats a
    // severed connection as a clean end-of-stream, so it produces no error at all.)
    const body = await withUpstream(
      () =>
        new Response(
          `data: ${JSON.stringify(frame({ content: "partial" }))}\n\n` +
            `data: ${JSON.stringify({ error: { message: "upstream died mid-stream", type: "server_error" } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      async ({ app, token }) => {
        const res = await app.fetch(chatRequest(token, {
          model: "test/chat-model",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }))
        // The status line is already committed, so the failure has to travel in band.
        expect(res.status).toBe(200)
        return await res.text()
      },
    )

    expect(body).not.toContain("event: error")

    const frames = payloads(body)
    expect(frames.at(-1)).toBe("[DONE]")
    expect(frames.filter((f) => f === "[DONE]")).toHaveLength(1)

    const errors = frames.filter((f) => f !== "[DONE]").map((f) => JSON.parse(f)).filter((f) => f.error)
    expect(errors).toHaveLength(1)
    expect(errors[0].error.type).toBe("api_error")
  })

  test("a non-streaming upstream failure surfaces as 502, not 500", async () => {
    // So a caller can tell "MiMoCode broke" from "the provider broke".
    const status = await withUpstream(
      () => new Response(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 500 }),
      async ({ app, token }) => {
        const res = await app.fetch(chatRequest(token, {
          model: "test/chat-model",
          messages: [{ role: "user", content: "hi" }],
        }))
        return res.status
      },
    )
    expect(status).toBe(502)
  })

  test("collects a non-streaming answer from the same code path", async () => {
    const body = await withUpstream(
      () => sse([frame({ content: "Hello" }), frame({}, "stop")]),
      async ({ app, token }) => {
        const res = await app.fetch(chatRequest(token, {
          model: "test/chat-model",
          messages: [{ role: "user", content: "hi" }],
        }))
        expect(res.status).toBe(200)
        return (await res.json()) as {
          object: string
          model: string
          choices: { message: { content: string }; finish_reason: string }[]
        }
      },
    )
    expect(body.object).toBe("chat.completion")
    expect(body.model).toBe("test/chat-model")
    expect(body.choices[0]!.message.content).toBe("Hello")
    expect(body.choices[0]!.finish_reason).toBe("stop")
  })

  test("streams tool calls as an opener plus argument fragments", async () => {
    const body = await withUpstream(
      () =>
        sse([
          frame({
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }],
          }),
          frame({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
          frame({ tool_calls: [{ index: 0, function: { arguments: '"BJ"}' } }] }),
          frame({}, "tool_calls"),
        ]),
      async ({ app, token }) => {
        const res = await app.fetch(chatRequest(token, {
          model: "test/chat-model",
          messages: [{ role: "user", content: "weather?" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                parameters: { type: "object", properties: { city: { type: "string" } } },
              },
            },
          ],
          stream: true,
        }))
        return await res.text()
      },
    )

    const parsed = payloads(body)
      .filter((f) => f !== "[DONE]")
      .map((f) => JSON.parse(f))
    const calls = parsed.flatMap((f) => f.choices[0]?.delta?.tool_calls ?? [])
    // The opener carries index/id/name; the fragments carry arguments only.
    expect(calls[0]).toMatchObject({ index: 0, id: "call_1", function: { name: "get_weather" } })
    expect(calls.map((c: { function?: { arguments?: string } }) => c.function?.arguments ?? "").join("")).toBe(
      '{"city":"BJ"}',
    )
    expect(parsed.at(-1).choices[0].finish_reason).toBe("tool_calls")
  })

  test("returns completed tool arguments in a non-streaming answer, never a truncated fragment", async () => {    const body = await withUpstream(
      () =>
        sse([
          frame({
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }],
          }),
          frame({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
          frame({ tool_calls: [{ index: 0, function: { arguments: '"BJ"}' } }] }),
          frame({}, "tool_calls"),
        ]),
      async ({ app, token }) => {
        const res = await app.fetch(chatRequest(token, {
          model: "test/chat-model",
          messages: [{ role: "user", content: "weather?" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                parameters: { type: "object", properties: { city: { type: "string" } } },
              },
            },
          ],
        }))
        return (await res.json()) as {
          choices: {
            message: { content: string | null; tool_calls?: { function: { name: string; arguments: string } }[] }
            finish_reason: string
          }[]
        }
      },
    )
    expect(body.choices[0]!.finish_reason).toBe("tool_calls")
    expect(body.choices[0]!.message.tool_calls).toHaveLength(1)
    expect(JSON.parse(body.choices[0]!.message.tool_calls![0]!.function.arguments)).toEqual({ city: "BJ" })
  })
})

describe("what actually reaches the provider", () => {
  /** Capture the upstream request body so assertions read the wire, not our code. */
  async function sentBody(request: unknown) {
    const seen: Record<string, unknown>[] = []
    await withUpstream(
      async (req) => {
        seen.push((await req.json()) as Record<string, unknown>)
        return sse([frame({ content: "ok" }), frame({}, "stop")])
      },
      async ({ app, token }) => {
        const res = await app.fetch(chatRequest(token, request))
        expect(res.status).toBe(200)
        await res.text()
      },
    )
    return seen[0]!
  }

  test("omits temperature for a model that declares the capability false", async () => {
    // The fixture model declares no `temperature`, so the capability defaults to
    // false; forwarding the caller's value would contradict session/llm.ts and can
    // make the provider reject the request outright.
    const body = await sentBody({
      model: "test/chat-model",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    })
    expect(body.temperature).toBeUndefined()
  })

  test("reasoning_effort reaches the wire under the provider's own option name", async () => {
    // Honored, not ignored: `ProviderTransform.variants` already knows each provider's
    // spelling, so the proxy applies effort exactly as a session would.
    const body = await sentBody({
      model: "test/chat-model",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    })
    expect(body.reasoning_effort).toBe("high")
  })

  test("an unavailable reasoning_effort is a 400 listing what the model does offer", async () => {
    // A silent downgrade is the failure worth preventing: a caller who asked for
    // `high` and got the default cannot tell.
    const res = await withUpstream(
      () => sse([frame({ content: "unused" })]),
      async ({ app, token }) =>
        app.fetch(chatRequest(token, {
          model: "test/chat-model",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "ludicrous",
        })),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain("ludicrous")
    expect(body.error.message).toContain("high")
  })

  test("provider_options reaches the wire, merged flat and never provider-keyed", async () => {
    // `ProviderTransform.options()` yields a FLAT map and `providerOptions()` nests it
    // under the SDK namespace — the same order `session/llm.ts` uses. Merging a
    // per-provider-keyed object in instead nested twice, and the inner object leaked
    // onto the wire as a top-level field named after the provider.
    //
    // Keys are the SDK's provider-option names, which are camelCase. A snake_case key
    // is silently unknown to the SDK and dropped, so both directions are asserted here
    // — the escape hatch is only an escape hatch if the caller can tell which it is.
    const honored = await sentBody({
      model: "test/chat-model",
      messages: [{ role: "user", content: "hi" }],
      provider_options: { reasoningEffort: "low" },
    })
    expect(honored.reasoning_effort).toBe("low")
    expect(honored.test).toBeUndefined()
    expect(honored.provider_options).toBeUndefined()

    const wrongCase = await sentBody({
      model: "test/chat-model",
      messages: [{ role: "user", content: "hi" }],
      provider_options: { reasoning_effort: "low" },
    })
    expect(wrongCase.reasoning_effort).toBeUndefined()
  })
})
