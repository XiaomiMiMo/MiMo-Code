import { afterEach, expect, test } from "bun:test"
import { fetchProviderModels } from "../../src/cli/cmd/tui/util/provider-models"

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

test("loads OpenAI-style models with a Bearer API key", async () => {
  let authorization = ""
  server = Bun.serve({
    port: 0,
    fetch(request) {
      authorization = request.headers.get("authorization") ?? ""
      return Response.json({ data: [{ id: "model-a" }, { id: "model-b", name: "Model B" }] })
    },
  })

  const models = await fetchProviderModels(
    "@ai-sdk/openai-compatible",
    `http://127.0.0.1:${server.port}/v1/`,
    "secret-key",
  )

  expect(authorization).toBe("Bearer secret-key")
  expect(models).toEqual([
    { id: "model-a", name: "model-a" },
    { id: "model-b", name: "Model B" },
  ])
})

test("loads Anthropic-style models with protocol headers", async () => {
  let apiKey = ""
  let version = ""
  server = Bun.serve({
    port: 0,
    fetch(request) {
      apiKey = request.headers.get("x-api-key") ?? ""
      version = request.headers.get("anthropic-version") ?? ""
      return Response.json([{ id: "claude-model", display_name: "Claude Model" }])
    },
  })

  const models = await fetchProviderModels("@ai-sdk/anthropic", `http://127.0.0.1:${server.port}/v1`, "anthropic-key")

  expect(apiKey).toBe("anthropic-key")
  expect(version).toBe("2023-06-01")
  expect(models).toEqual([{ id: "claude-model", name: "Claude Model" }])
})
