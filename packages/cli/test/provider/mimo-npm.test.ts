import { expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Provider.defaultLayer.pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer))),
)

for (const config of [
  { name: "provider npm", npm: "@ai-sdk/anthropic", modelNpm: undefined },
  { name: "model npm over provider npm", npm: "@ai-sdk/openai-compatible", modelNpm: "@ai-sdk/anthropic" },
  { name: "model npm without provider npm", npm: undefined, modelNpm: "@ai-sdk/anthropic" },
]) {
  it.live(`mimo models use /messages with explicit ${config.name}`, () =>
    Effect.gen(function* () {
      const requests: { path: string; method: string; body: unknown }[] = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
              const pathname = new URL(request.url).pathname
              const body: unknown = await request.json()
              requests.push({ path: pathname, method: request.method, body })
              if (pathname !== "/anthropic/v1/messages") return new Response("Not found", { status: 404 })
              return Response.json({
                id: "msg_test",
                type: "message",
                role: "assistant",
                model: "test/model",
                content: [{ type: "text", text: "ok" }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              })
            },
          }),
        ),
        (server) =>
          Effect.promise(async () => {
            await server.stop(true)
          }),
      )

      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            for (const [id, apiID] of [
              ["mimo-test", "test/model"],
              ["alias", "test/mimo-test"],
            ]) {
              const model = yield* provider.getModel(ProviderID.make("test-gateway"), ModelID.make(id))
              expect(model.api.npm).toBe("@ai-sdk/anthropic")
              expect(model.api.id).toBe(apiID)
              const language = yield* provider.getLanguage(model)
              const result = yield* Effect.promise(() =>
                language.doGenerate({
                  maxOutputTokens: 16,
                  prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
                }),
              )
              expect(result.content).toEqual([{ type: "text", text: "ok" }])
            }
          }),
        {
          config: {
            enabled_providers: ["test-gateway"],
            provider: {
              "test-gateway": {
                npm: config.npm,
                options: { apiKey: "test-key", baseURL: `${server.url.origin}/anthropic/v1` },
                models: {
                  "mimo-test": {
                    id: "test/model",
                    provider: config.modelNpm ? { npm: config.modelNpm } : undefined,
                    limit: { context: 8192, output: 2048 },
                  },
                  alias: {
                    id: "test/mimo-test",
                    provider: config.modelNpm ? { npm: config.modelNpm } : undefined,
                    limit: { context: 8192, output: 2048 },
                  },
                },
              },
            },
          },
        },
      )
      expect(requests).toHaveLength(2)
      for (const [index, model] of ["test/model", "test/mimo-test"].entries()) {
        expect(requests[index]).toMatchObject({
          path: "/anthropic/v1/messages",
          method: "POST",
          body: { model, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        })
      }
    }),
  )
}
