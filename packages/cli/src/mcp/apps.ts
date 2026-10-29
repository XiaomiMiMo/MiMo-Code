import type { Tool } from "ai"
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js"
import { normalizeToolResult } from "./tool-result"
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js"

export const mcpRequestTimeout = (server?: number, fallback?: number) => server ?? fallback ?? DEFAULT_REQUEST_TIMEOUT_MSEC

export interface AppTool {
  server: string
  tool: string
  resourceUri?: string
  timeoutMs?: number
}
const bindings = new WeakMap<Tool, AppTool>()
export function appMetadata(tool: McpTool) {
  const ui = tool._meta?.ui
  return ui && typeof ui === "object" ? (ui as { resourceUri?: unknown; visibility?: unknown }) : undefined
}
export function visibleTo(tool: McpTool, target: "model" | "app") {
  const visibility = appMetadata(tool)?.visibility
  return visibility === undefined || (Array.isArray(visibility) && visibility.includes(target))
}
export function bindAppTool(value: Tool, server: string, tool: McpTool, timeout?: number) {
  // Routing follows the server; visibility only controls who may invoke the tool.
  const uri = appMetadata(tool)?.resourceUri
  const resourceUri = typeof uri === "string" && uri.startsWith("ui://") ? uri : undefined
  bindings.set(value, { server, tool: tool.name, timeoutMs: mcpRequestTimeout(timeout), ...(resourceUri ? { resourceUri } : {}) })
  return value
}
export function appTool(value: Tool) {
  return bindings.get(value)
}

/** Public App identity kept on tool parts; arguments and results stay out of messages. */
export function appIdentity(
  call: AppTool & { sessionID: string; messageID: string; callID: string; callOrder: number },
) {
  const { sessionID, messageID, callID, server, tool, resourceUri, callOrder } = call
  return { sessionID, messageID, callID, server, tool, ...(resourceUri ? { resourceUri } : {}), callOrder }
}

/** App-facing copy of a result, bounded like the model output: inline media never rides in metadata. */
export function appResult(result: CallToolResult, output: string): CallToolResult {
  return {
    content: output ? [{ type: "text", text: output }] : [],
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result._meta === undefined ? {} : { _meta: result._meta }),
  }
}

/** Same bound as persisted facts, for results that only travel over the event feed. */
export function appEventResult(result: CallToolResult): CallToolResult {
  return appResult(result, normalizeToolResult(result).output)
}

/** The exec guest is model-controlled; client-only App data stays in persisted tool facts. */
export function modelMcpMetadata(metadata: Record<string, unknown>) {
  const { mcpApp: _app, mcp: raw, ...rest } = metadata
  if (!raw || typeof raw !== "object") return rest
  const mcp = raw as Record<string, unknown>
  return {
    ...rest,
    mcp: {
      ...(typeof mcp.isError === "boolean" ? { isError: mcp.isError } : {}),
      ...(mcp.structuredContent !== undefined ? { structuredContent: mcp.structuredContent } : {}),
    },
  }
}
