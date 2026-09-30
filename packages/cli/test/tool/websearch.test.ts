import { describe, expect, test } from "bun:test"
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
          Effect.provide(
            Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer, fakeAuth),
          ),
          Effect.runPromise,
        )

        expect(requested).toBe("mimo-v2.5-pro")
        expect(result.output).toContain("https://example.com/result")
      },
    })
  })
})
