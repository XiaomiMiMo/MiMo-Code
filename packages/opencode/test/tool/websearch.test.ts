import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Truncate } from "../../src/tool"
import { Instance } from "../../src/project/instance"
import { WebSearchTool } from "../../src/tool/websearch"
import { SessionID, MessageID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"

const projectRoot = path.join(import.meta.dir, "../..")

const firecrawlKey = process.env.FIRECRAWL_API_KEY
const firecrawlUrl = process.env.FIRECRAWL_API_URL

afterEach(() => {
  if (firecrawlKey === undefined) delete process.env.FIRECRAWL_API_KEY
  else process.env.FIRECRAWL_API_KEY = firecrawlKey
  if (firecrawlUrl === undefined) delete process.env.FIRECRAWL_API_URL
  else process.env.FIRECRAWL_API_URL = firecrawlUrl
})

const sse = (model: string) => {
  const frame = {
    model,
    choices: [
      {
        delta: {
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com/result",
              title: "Example",
              summary: "A search hit",
              site_name: "Example",
              publish_time: "2026-01-01",
            },
          ],
        },
      },
    ],
  }
  return `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`
}

describe("tool.websearch", () => {
  test("xiaomi sidecar uses the session model's API id, not a hardcoded model", async () => {
    let requested: string | undefined
    using server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        requested = ((await req.json()) as { model?: string }).model
        return new Response(sse(requested ?? ""), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      },
    })

    const model = ProviderTest.model({
      id: ModelID.make("catalog-mimo-pro"),
      providerID: ProviderID.make("xiaomi"),
      api: {
        id: "mimo-v2.5-pro",
        url: server.url.origin,
        npm: "@ai-sdk/openai-compatible",
      },
    })

    const fakeAuth = Layer.mock(Auth.Service)({
      get: (providerID: string) =>
        Effect.succeed(providerID === "xiaomi" ? new Auth.Api({ type: "api", key: "test-key" }) : undefined),
    })

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const result = await WebSearchTool.pipe(
          Effect.flatMap((info) => info.init()),
          Effect.flatMap((tool) =>
            tool.execute(
              { query: "latest mimo release" },
              {
                sessionID: SessionID.make("ses_test"),
                messageID: MessageID.make("message"),
                callID: "",
                agent: "build",
                abort: AbortSignal.any([]),
                messages: [],
                extra: { model },
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            ),
          ),
          Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer, fakeAuth)),
          Effect.runPromise,
        )

        expect(requested).toBe("mimo-v2.5-pro")
        expect(result.output).toContain("https://example.com/result")
      },
    })
  })

  test("searches through firecrawl when it is configured", async () => {
    let body: { query?: string; limit?: number } | undefined
    let authorization: string | null = null
    using server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname !== "/v2/search") return new Response("not found", { status: 404 })
        authorization = req.headers.get("authorization")
        body = (await req.json()) as typeof body
        return Response.json({
          success: true,
          data: {
            web: [
              { url: "https://example.com/one", title: "First", description: "The first hit" },
              { url: "https://example.com/two" },
            ],
          },
        })
      },
    })
    process.env.FIRECRAWL_API_KEY = "fc-test"
    process.env.FIRECRAWL_API_URL = server.url.origin

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const result = await WebSearchTool.pipe(
          Effect.flatMap((info) => info.init()),
          Effect.flatMap((tool) =>
            tool.execute(
              { query: "firecrawl search", numResults: 2 },
              {
                sessionID: SessionID.make("ses_test"),
                messageID: MessageID.make("message"),
                callID: "",
                agent: "build",
                abort: AbortSignal.any([]),
                messages: [],
                extra: {},
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            ),
          ),
          Effect.provide(
            Layer.mergeAll(
              FetchHttpClient.layer,
              Truncate.defaultLayer,
              Agent.defaultLayer,
              Layer.mock(Auth.Service)({ get: () => Effect.succeed(undefined) }),
            ),
          ),
          Effect.runPromise,
        )

        expect(authorization).toBe("Bearer fc-test")
        expect(body?.query).toBe("firecrawl search")
        expect(body?.limit).toBe(2)
        expect(result.output).toBe(
          [
            "- First",
            "  https://example.com/one",
            "  The first hit",
            "- https://example.com/two",
            "  https://example.com/two",
          ].join("\n"),
        )
      },
    })
  })
})
