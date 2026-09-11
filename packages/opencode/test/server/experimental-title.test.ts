import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, toolCallResponse } from "../lib/scripted-llm-server"

function request(directory: string, body: unknown) {
  return Server.Default().app.request(`/experimental/title?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

test("title route requires a complete model when supplied and preserves legacy input validation", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      for (const model of [{}, { providerID: "title-test" }, { modelID: "source" }, null, "title-test/source", { providerID: 1, modelID: "source" }]) {
        expect((await request(tmp.path, { text: "Inspect the parser", model })).status).toBe(400)
      }
      for (const body of [{}, { text: " " }, { parts: [] }, { parts: [{ type: "text", text: " " }] }]) {
        expect((await request(tmp.path, body)).status).toBe(400)
      }
      const legacy = await request(tmp.path, { text: "Inspect the parser", locale: "en-US" })
      expect(legacy.status).toBe(200)
      expect(await legacy.json()).toEqual({ title: "Inspect the parser", status: "fallback" })
      const image = await request(tmp.path, { parts: [{ type: "image", data: "AA==", mime: "image/png", filename: "diagram.png" }], locale: "en-US" })
      expect(image.status).toBe(200)
      expect(await image.json()).toEqual({ title: "diagram.png", status: "fallback" })
    },
  })
})

test("title route forwards source model, text, parts and locale without a configured title model", async () => {
  const stub = startScriptedLLMServer([
    { lines: toolCallResponse({ id: "call-title", name: "StructuredOutput", args: JSON.stringify({ title: "Inspect parser behavior" }) }) },
  ])
  try {
    await using tmp = await tmpdir({
      git: true,
      config: {
        enabled_providers: ["title-test"],
        provider: {
          "title-test": {
            name: "Title Test",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { apiKey: "test-key", baseURL: `${stub.origin}/v1` },
            models: {
              source: {
                name: "Source",
                tool_call: true,
                limit: { context: 8000, output: 2000 },
                modalities: { input: ["text"], output: ["text"] },
              },
            },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await request(tmp.path, {
          text: "Inspect the parser",
          parts: [{ type: "text", text: "Explain the token handling" }],
          locale: "fr-FR",
          model: { providerID: "title-test", modelID: "source" },
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ title: "Inspect parser behavior", status: "generated" })
        expect(stub.captures).toHaveLength(1)
        expect(stub.captures[0].model).toBe("source")
        const content = JSON.stringify(stub.captures[0].messages.filter((message) => message.role === "user"))
        expect(content).toContain("Inspect the parser")
        expect(content).toContain("Explain the token handling")
        expect(content).toContain("fr-FR")
      },
    })
  } finally {
    await stub.stop()
  }
})
