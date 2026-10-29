import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import type { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const model = { providerID: "test", modelID: "test-model" }

function fixture(run: (http: ReturnType<typeof client>, llm: TestLLMServer["Service"]) => Promise<void>) {
  // Only the LLM fixture has its own runtime; HTTP uses the production AppRuntime graph.
  return Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* Effect.promise(async () => {
        await using tmp = await tmpdir({
          git: true,
          config: {
            model: "test/test-model",
            small_model: "test/test-model",
            provider: {
              test: {
                name: "Test",
                npm: "@ai-sdk/openai-compatible",
                models: {
                  "test-model": {
                    id: "test-model",
                    name: "Test Model",
                    attachment: false,
                    reasoning: false,
                    temperature: false,
                    tool_call: true,
                    release_date: "2025-01-01",
                    limit: { context: 100000, output: 10000 },
                    cost: { input: 0, output: 0 },
                    options: {},
                  },
                },
                options: { apiKey: "test-key", baseURL: llm.url },
              },
            },
          },
        })
        try {
          await run(client(tmp.path), llm)
        } finally {
          await Instance.disposeAll()
        }
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}

function client(directory: string) {
  const app = Server.Default().app
  const request = (route: string, init?: RequestInit) =>
    app.request(`${route}?directory=${encodeURIComponent(directory)}`, init)
  const post = (route: string, body: unknown) =>
    request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  return {
    post,
    async session() {
      const response = await post("/session", { title: "Summarize outcome" })
      expect(response.status).toBe(200)
      return (await response.json()) as Session.Info
    },
    async seed(sessionID: string) {
      const response = await post(`/session/${sessionID}/prompt_async`, {
        agent: "build",
        model,
        noReply: true,
        parts: [{ type: "text", text: "context that must survive" }],
      })
      expect(response.status).toBe(204)
    },
    async compactionParts(sessionID: string) {
      const response = await request(`/session/${sessionID}/message`)
      expect(response.status).toBe(200)
      const messages = (await response.json()) as MessageV2.WithParts[]
      return messages.flatMap((message) => message.parts).filter((part) => part.type === "compaction")
    },
  }
}

describe("POST /session/:id/summarize reports the real outcome", () => {
  test("an unknown model is rejected before a boundary is written", () =>
    fixture(async (http, llm) => {
      const session = await http.session()
      await http.seed(session.id)

      const response = await http.post(`/session/${session.id}/summarize`, {
        providerID: "test",
        modelID: "removed-model",
      })

      expect(response.status).toBe(400)
      expect(((await response.json()) as { name: string }).name).toBe("ProviderModelNotFoundError")
      expect(await http.compactionParts(session.id)).toEqual([])
      expect(await Effect.runPromise(llm.calls)).toBe(0)
    }), 30_000)

  test("a rolled-back compaction fails instead of answering true", () =>
    fixture(async (http, llm) => {
      const session = await http.session()
      await http.seed(session.id)
      await Effect.runPromise(llm.text("   "))

      const response = await http.post(`/session/${session.id}/summarize`, model)

      expect(response.status).toBe(500)
      expect(((await response.json()) as { name: string }).name).toBe("SessionCompactionFailedError")
      expect(await http.compactionParts(session.id)).toEqual([])
    }), 30_000)

  test("a completed compaction answers true", () =>
    fixture(async (http, llm) => {
      const session = await http.session()
      await http.seed(session.id)
      await Effect.runPromise(llm.text("SUMMARY OF THE SESSION"))

      const response = await http.post(`/session/${session.id}/summarize`, model)

      expect(response.status).toBe(200)
      expect(await response.json()).toBe(true)
      const [part] = await http.compactionParts(session.id)
      expect(part?.type === "compaction" && part.projection?.summary).toContain("SUMMARY OF THE SESSION")
    }), 30_000)
})
