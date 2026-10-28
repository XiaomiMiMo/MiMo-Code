import { expect, test } from "bun:test"
import { safeValidateTypes } from "@ai-sdk/provider-utils"
import { generateText } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { convertMcpTool } from "../../src/mcp"
import { ManagedClient } from "../../src/mcp/managed-client"

test("MCP object schemas reject non-object model arguments before tool execution", async () => {
  const client = new ManagedClient({ name: "test", version: "1" })
  const converted = convertMcpTool({ name: "read", inputSchema: { type: "object", properties: {} } }, client)
  for (const value of ["not an object", [], null, 1, false]) {
    expect((await safeValidateTypes({ value, schema: converted.inputSchema })).success).toBe(false)
  }
  expect(await safeValidateTypes({ value: { path: "/tmp/example" }, schema: converted.inputSchema }))
    .toMatchObject({ success: true, value: { path: "/tmp/example" } })
})

test("MCP validation enforces the declared schema without coercing or removing legal input", async () => {
  const client = new ManagedClient({ name: "test", version: "1" })
  const schema = {
    type: "object" as const,
    properties: {
      target: { $ref: "#/definitions/target" },
      count: { type: "integer", minimum: 1 },
      mode: { enum: ["read", "write"] },
      tags: { type: "array", items: { type: "string" } },
      note: { type: ["string", "null"] },
    },
    definitions: {
      target: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 } }, additionalProperties: false },
    },
    required: ["target", "count"],
    additionalProperties: false,
  }
  const converted = convertMcpTool({ name: "read", inputSchema: schema }, client)
  const valid = { target: { name: "example" }, count: 2, mode: "read", tags: ["one"], note: null }
  expect(await safeValidateTypes({ value: valid, schema: converted.inputSchema })).toMatchObject({ success: true, value: valid })
  expect(valid).toEqual({ target: { name: "example" }, count: 2, mode: "read", tags: ["one"], note: null })
  expect((await safeValidateTypes({ value: { target: { name: "example" }, count: 1 }, schema: converted.inputSchema })).success).toBe(true)
  for (const value of [
    {}, { ...valid, count: "2" }, { ...valid, count: 0 }, { ...valid, count: 1.5 },
    { ...valid, mode: "other" }, { ...valid, tags: [1] }, { ...valid, extra: true },
    { ...valid, target: { name: "example", extra: true } }, { ...valid, target: { name: "" } },
  ]) {
    expect((await safeValidateTypes({ value, schema: converted.inputSchema })).success).toBe(false)
  }
})

test("MCP validation preserves additionalProperties and patternProperties declared by each tool", async () => {
  const client = new ManagedClient({ name: "test", version: "1" })
  for (const additionalProperties of [undefined, true, { type: "integer" }]) {
    const inputSchema = { type: "object" as const, properties: {}, ...(additionalProperties === undefined ? {} : { additionalProperties }) }
    const converted = convertMcpTool({ name: "read", inputSchema }, client)
    const value = { extra: 42 }
    expect(await safeValidateTypes({ value, schema: converted.inputSchema })).toMatchObject({ success: true, value })
    expect((await safeValidateTypes({ value: { extra: "text" }, schema: converted.inputSchema })).success)
      .toBe(typeof additionalProperties !== "object")
  }
  const converted = convertMcpTool({ name: "read", inputSchema: {
    type: "object", patternProperties: { "^x-": { type: "string" } }, additionalProperties: false,
  } }, client)
  expect((await safeValidateTypes({ value: { "x-example": "value" }, schema: converted.inputSchema })).success).toBe(true)
  expect((await safeValidateTypes({ value: { "x-example": 1 }, schema: converted.inputSchema })).success).toBe(false)
  expect((await safeValidateTypes({ value: { other: "value" }, schema: converted.inputSchema })).success).toBe(false)
})

test("AI SDK returns invalid MCP arguments as a recoverable tool error and still executes valid objects", async () => {
  const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } })
  const received: unknown[] = []
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    received.push(request.params.arguments)
    return { content: [{ type: "text", text: "done" }] }
  })
  const client = new ManagedClient({ name: "test", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  await client.connect(b)
  const converted = convertMcpTool({ name: "read", inputSchema: {
    type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false,
  } }, client)
  try {
    for (const input of ["not an object", { count: "1" }, { count: 1, extra: true }, { count: 1 }]) {
      const result = await generateText({
        model: new MockLanguageModelV3({ doGenerate: {
          content: [{ type: "tool-call", toolCallId: "call-test", toolName: "fixture_read", input: JSON.stringify(input) }],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 } },
          warnings: [],
        } }),
        prompt: "Use the test tool",
        tools: { fixture_read: converted },
        maxRetries: 0,
      })
      if (typeof input === "string" || typeof input.count !== "number" || "extra" in input) {
        expect(result.toolCalls[0]).toMatchObject({ invalid: true })
        expect(received).toEqual([])
      } else {
        expect(result.toolResults).toHaveLength(1)
        expect(received).toEqual([input])
      }
    }
  } finally {
    await client.close()
    await server.close()
  }
})

test("MCP validation honors modern evaluated properties and explicit older tuple dialects", async () => {
  const client = new ManagedClient({ name: "test", version: "1" })
  for (const $schema of [undefined, "https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2019-09/schema"]) {
    const converted = convertMcpTool({ name: "read", inputSchema: {
      type: "object", ...($schema ? { $schema } : {}),
      allOf: [{ properties: { name: { type: "string" } }, required: ["name"] }],
      unevaluatedProperties: false,
    } }, client)
    expect((await safeValidateTypes({ value: { name: "example" }, schema: converted.inputSchema })).success).toBe(true)
    expect((await safeValidateTypes({ value: { name: "example", extra: true }, schema: converted.inputSchema })).success).toBe(false)
  }
  for (const [$schema, tuple] of [
    ["https://json-schema.org/draft/2020-12/schema", { prefixItems: [{ type: "string" }, { type: "integer" }], items: false }],
    ["http://json-schema.org/draft-07/schema#", { items: [{ type: "string" }, { type: "integer" }], additionalItems: false }],
  ] as const) {
    const converted = convertMcpTool({ name: "read", inputSchema: {
      type: "object", $schema, properties: { pair: { type: "array", ...tuple } },
    } }, client)
    expect((await safeValidateTypes({ value: { pair: ["example", 1] }, schema: converted.inputSchema })).success).toBe(true)
    expect((await safeValidateTypes({ value: { pair: ["example", "1"] }, schema: converted.inputSchema })).success).toBe(false)
    expect((await safeValidateTypes({ value: { pair: ["example", 1, 2] }, schema: converted.inputSchema })).success).toBe(false)
  }
})
