import { expect, test } from "bun:test"
import { createOpencodeClient, genTitle, type GenTitleInput } from "@mimo-ai/sdk/v2/client"

for (const model of [undefined, { providerID: "title-test", modelID: "source" }]) {
  test(`SDK genTitle forwards text, parts and locale${model ? " with source model" : " without model"}`, async () => {
    const requests: Request[] = []
    const client = createOpencodeClient({
      baseUrl: "http://example.test",
      fetch: Object.assign(async (request: Request | URL | string) => {
        requests.push(request instanceof Request ? request : new Request(request))
        return Response.json({ title: "Inspect parser behavior", status: "generated" })
      }, { preconnect: () => {} }),
    })
    const input: GenTitleInput = {
      text: "Inspect the parser",
      parts: [{ type: "text", text: "Explain the token handling" }],
      locale: "fr-FR",
      ...(model ? { model } : {}),
    }
    const result = await genTitle(client, input)
    expect(result.data).toEqual({ title: "Inspect parser behavior", status: "generated" })
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url).pathname).toBe("/experimental/title")
    expect(requests[0].method).toBe("POST")
    expect(await requests[0].json()).toEqual(input)
  })
}

test("SDK genTitle still rejects empty content even with a complete model", () => {
  const client = createOpencodeClient({ baseUrl: "http://example.test" })
  expect(() => genTitle(client, { text: " ", model: { providerID: "title-test", modelID: "source" } })).toThrow("genTitle requires non-empty text or parts")
})
