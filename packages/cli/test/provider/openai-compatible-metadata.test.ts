import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Provider.defaultLayer.pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer))),
)

it.live("extracts only the first assistant message's reasoning_opaque from JSON chat responses", () =>
  Effect.gen(function* () {
    let opaque: unknown
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                reasoning_opaque: opaque,
                unrelated: "not metadata",
                tool_calls: [{ id: "call_1", function: { name: "lookup", arguments: "{}" } }],
              },
              delta: { reasoning_opaque: "not a JSON message" },
              finish_reason: "tool_calls",
            },
            { message: { reasoning_opaque: "another choice" } },
          ],
        }),
    })
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderID.make("test"), ModelID.make("model"))
          const language = yield* provider.getLanguage(model)
          for (opaque of [" signed state ", "", 17, null, undefined]) {
            const result = yield* Effect.promise(() =>
              language.doGenerate({
                prompt: [{ role: "user", content: [{ type: "text", text: "lookup" }] }],
              }),
            )
            expect(result.content).toEqual([
              { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: "{}" },
            ])
            expect(result.providerMetadata?.openaiCompatible).toEqual(
              opaque === " signed state " ? { reasoning_opaque: " signed state " } : undefined,
            )
          }
        }),
      {
        config: {
          provider: {
            test: {
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` },
              models: { model: { limit: { context: 8192, output: 2048 } } },
            },
          },
        },
      },
    )
  }),
)
