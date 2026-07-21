import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider } from "../../src/provider"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "../../src/tool"
import { WebSearchTool } from "../../src/tool/websearch"

const projectRoot = path.join(import.meta.dir, "../..")

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function mimoModel(url: string) {
  return {
    id: ModelID.make("mimo-auto"),
    providerID: ProviderID.make("mimo"),
    api: { id: "mimo", url, npm: "@ai-sdk/openai-compatible" },
    name: "MiMo Auto",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1_000_000, output: 128_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
  } satisfies Provider.Model
}

async function withXiaomiAuth(fn: () => Promise<void>) {
  const previous = process.env.MIMOCODE_AUTH_CONTENT
  process.env.MIMOCODE_AUTH_CONTENT = JSON.stringify({ xiaomi: { type: "api", key: "web-key" } })
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env.MIMOCODE_AUTH_CONTENT
    else process.env.MIMOCODE_AUTH_CONTENT = previous
  }
}

function exec(args: { query: string; baseUrl: string }) {
  return WebSearchTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.flatMap((tool) =>
      tool.execute(
        { query: args.query },
        {
          ...ctx,
          extra: { model: mimoModel(args.baseUrl) },
        },
      ),
    ),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer, Auth.defaultLayer)),
    Effect.runPromise,
  )
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool.websearch", () => {
  test("uses stored Xiaomi auth for MiMo provider websearch", async () => {
    let apiKey = ""
    let requestPath = ""
    using server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url)
        apiKey = req.headers.get("api-key") ?? ""
        requestPath = url.pathname
        return new Response(
          [
            'data: {"choices":[{"delta":{"annotations":[{"url":"https://example.com","title":"Example","site_name":"Example Site","summary":"Example summary"}]}}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })

    await withXiaomiAuth(async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const result = await exec({ query: "mimo web search", baseUrl: server.url.toString() })
          expect(result.output).toContain("Sources:")
          expect(result.output).toContain("https://example.com")
        },
      })
    })

    expect(requestPath).toBe("/v1/chat/completions")
    expect(apiKey).toBe("web-key")
  })
})
