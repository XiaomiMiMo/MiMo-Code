import { expect, test } from "bun:test"
import { jsonSchema, tool, type ModelMessage } from "ai"
import { SessionPrefixSnapshot } from "../../src/session/prefix-snapshot"
import { defaultToolName, toolSurface } from "../../src/tool/names"

const read = {
  ...tool({
    description: "Read an example file",
    inputSchema: jsonSchema<{ path: string }>({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    }),
    execute: async (input) => input.path,
  }),
  modelName: "Read",
}
const external = tool({ inputSchema: jsonSchema({ type: "object", properties: {} }) })

test("built-in names are explicit and exact rather than case folded", async () => {
  expect(defaultToolName("read")).toBe("Read")
  expect(defaultToolName("lsp")).toBe("LSP")
  expect(defaultToolName("mcp_tool_search")).toBeUndefined()
  expect(defaultToolName("READ")).toBeUndefined()
  expect(defaultToolName("invalid")).toBeUndefined()
  expect(defaultToolName("example_tool")).toBeUndefined()

  const surface = toolSurface({ read })
  const tools = surface.tools({ read })
  expect(Object.keys(tools)).toEqual(["Read"])
  expect(tools.Read).toBe(read)
  expect(await tools.Read.execute?.({ path: "/tmp/example" }, { toolCallId: "call-example", messages: [] })).toBe(
    "/tmp/example",
  )
  expect(surface.id("Read")).toBe("read")
  expect(surface.id("READ")).toBe("READ")
  expect(surface.name("Read")).toBe("Read")
})

test("external tool names remain unchanged", () => {
  const tools = { mcp_read: external, example_tool: external }
  const surface = toolSurface(tools)
  expect(surface.tools(tools)).toEqual(tools)
  expect(surface.name("mcp_read")).toBe("mcp_read")
})

test("history projects paired calls and results without rewriting text or inputs", () => {
  const messages = [
    { role: "user", content: "read Read and mcp_read are ordinary text" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "read this file" },
        { type: "tool-call", toolCallId: "call-example", toolName: "read", input: { path: "read" } },
        { type: "tool-call", toolCallId: "call-external", toolName: "mcp_read", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call-example", toolName: "read", output: { type: "text", value: "read" } },
        {
          type: "tool-result",
          toolCallId: "call-external",
          toolName: "mcp_read",
          output: { type: "text", value: "read" },
        },
      ],
    },
  ] satisfies ModelMessage[]
  const projected = toolSurface({ read, mcp_read: external }).messages(messages)
  expect(projected).toEqual([
    messages[0],
    {
      role: "assistant",
      content: [
        { type: "text", text: "read this file" },
        { type: "tool-call", toolCallId: "call-example", toolName: "Read", input: { path: "read" } },
        { type: "tool-call", toolCallId: "call-external", toolName: "mcp_read", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call-example", toolName: "Read", output: { type: "text", value: "read" } },
        {
          type: "tool-result",
          toolCallId: "call-external",
          toolName: "mcp_read",
          output: { type: "text", value: "read" },
        },
      ],
    },
  ])
  expect(messages[1].content[1]).toMatchObject({ toolName: "read" })
  expect(messages[2].content[0]).toMatchObject({ toolName: "read" })
})

test("execution and nested approval events restore only exact registered names", () => {
  const surface = toolSurface({ read, mcp_read: external })
  expect(surface.restore({ type: "tool-result", toolName: "Read", output: "Read" })).toEqual({
    type: "tool-result",
    toolName: "read",
    output: "Read",
  })
  expect(
    surface.restore({
      type: "tool-approval-request",
      approvalId: "approval-example",
      toolCall: {
        type: "tool-call",
        toolCallId: "call-example",
        toolName: "Read",
        input: { path: "Read" },
      },
    }),
  ).toEqual({
    type: "tool-approval-request",
    approvalId: "approval-example",
    toolCall: {
      type: "tool-call",
      toolCallId: "call-example",
      toolName: "read",
      input: { path: "Read" },
    },
  })
  expect(surface.restore({ toolName: "READ" })).toEqual({ toolName: "READ" })
  expect(surface.restore({ toolName: "mcp_read" })).toEqual({ toolName: "mcp_read" })
})

test("prefix snapshots preserve optional model names and include them in the tool hash", async () => {
  const snapshot = await SessionPrefixSnapshot.snapshotTools({ read, mcp_read: external }, ["read", "mcp_read"])
  expect(snapshot[0]).toMatchObject({ name: "read", model_name: "Read" })
  expect(snapshot[1]).not.toHaveProperty("model_name")
  const restored = SessionPrefixSnapshot.restoreTools(snapshot)
  expect(restored.read.modelName).toBe("Read")
  expect(restored.mcp_read.modelName).toBeUndefined()
  expect(Object.keys(toolSurface(restored).tools(restored))).toEqual(["Read", "mcp_read"])
  expect(await SessionPrefixSnapshot.snapshotTools(restored, ["read", "mcp_read"])).toEqual(snapshot)
  expect(SessionPrefixSnapshot.toolsHash({ read }, ["read"])).not.toBe(
    SessionPrefixSnapshot.toolsHash({ read: { ...read, modelName: undefined } }, ["read"]),
  )

  const legacy = SessionPrefixSnapshot.restoreTools([
    { name: "read", description: "Legacy example", input_schema: { type: "object", properties: {} } },
  ])
  expect(legacy.read.modelName).toBeUndefined()
  expect(Object.keys(toolSurface(legacy).tools(legacy))).toEqual(["read"])
})
