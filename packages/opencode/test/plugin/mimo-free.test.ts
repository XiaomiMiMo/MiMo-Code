import { expect, test } from "bun:test"
import type { Config, PluginInput } from "@mimo-ai/plugin"
import { MimoFreeAuthPlugin } from "../../src/plugin/mimo-free"

test("preserves MiMo Auto model when a custom mimo provider exists", async () => {
  const plugin = await MimoFreeAuthPlugin({} as PluginInput)
  const input: Config = {
    provider: {
      mimo: {
        name: "mimo",
        npm: "@ai-sdk/openai-compatible",
        api: "https://example.com/openai",
        models: {
          "free-mimo": {
            name: "free mimo",
            limit: { context: 4096, output: 1024 },
          },
        },
      },
    },
  }

  await plugin.config?.(input)

  const models = input.provider?.mimo?.models
  expect(models?.["free-mimo"]).toBeDefined()
  expect(models?.["mimo-auto"]).toBeDefined()
  expect(models?.["mimo-auto"]?.limit?.context).toBe(1_000_000)
  expect(models?.["mimo-auto"]?.limit?.output).toBe(128_000)
})
