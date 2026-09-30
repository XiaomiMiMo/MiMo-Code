import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js"
const server = new McpServer({ name: "recording-fixture", version: "1" })
server.registerTool("event_stream_start", { inputSchema: {} }, async () => {
  if (!server.server.getClientCapabilities()?.elicitation?.form) throw new Error("missing form elicitation")
  const result = await server.server.request(
    {
      method: "elicitation/create",
      params: {
        message: "Allow recording?",
        requestedSchema: { type: "object", properties: {} },
      },
    },
    ElicitResultSchema,
  )
  return { content: [{ type: "text", text: result.action }] }
})
await server.connect(new StdioServerTransport())
