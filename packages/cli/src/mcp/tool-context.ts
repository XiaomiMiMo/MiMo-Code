/**
 * Per-call hooks a session passes to MCP tool execution through the AI SDK's
 * `experimental_context`. They let the MCP client write history records for the
 * call without depending on session services.
 */

/** One MCP elicitation and its outcome, stored as an `elicitation` message part. */
export interface McpElicitationRecord {
  id: string
  server: string
  callID?: string
  requestID: string | number
  mode: "form"
  message: string
  requestedSchema: Record<string, unknown>
  meta?: Record<string, unknown>
  action?: "accept" | "decline" | "cancel"
  content?: Record<string, string | number | boolean | string[]>
  source?: string
  reason?: string
  error?: string
  time: { created: number; completed?: number }
}

export type McpElicitationRecorder = (record: McpElicitationRecord) => Promise<unknown>

export interface McpToolCallContext {
  /** Assistant message that holds the call. */
  messageID?: string
  /** Persist (insert or update by id) an elicitation record for this call. */
  onMcpElicitation?: McpElicitationRecorder
}

export function toolMessageID(context: unknown): string | undefined {
  if (!context || typeof context !== "object" || !("messageID" in context)) return undefined
  const value = (context as McpToolCallContext).messageID
  return typeof value === "string" && value ? value : undefined
}

export function elicitationRecorder(context: unknown): McpElicitationRecorder | undefined {
  if (!context || typeof context !== "object" || !("onMcpElicitation" in context)) return undefined
  const value = (context as McpToolCallContext).onMcpElicitation
  return typeof value === "function" ? value : undefined
}
