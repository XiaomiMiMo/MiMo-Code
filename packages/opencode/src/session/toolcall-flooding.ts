import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Flag } from "@/flag/flag"

export const TOOLCALL_FLOODING_LIMIT = 16
export const TOOLCALL_FLOODING_MAX_RECOVERY = 2
export const TOOLCALL_FLOODING_ERROR = "Tool call cancelled because tool-call flooding was detected."
export const TOOLCALL_FLOODING_REMINDER = `<system-reminder>
Tool-call flooding was detected in your previous response. All client tool calls from that response were cancelled before execution. Continue with a smaller batch of tool calls.
Prefer 1–3 tool calls per step. Avoid more than 8 calls in a single step.
</system-reminder>`

type Call = { id: string; name: string; input: string }

export class ToolCallFloodingError extends Error {
  constructor(readonly calls: Call[]) {
    super(TOOLCALL_FLOODING_ERROR)
    this.name = "ToolCallFloodingError"
  }
}

function complete(input: string) {
  try {
    const value = JSON.parse(input)
    return value !== null && typeof value === "object" && !Array.isArray(value)
  } catch {
    return false
  }
}

/** Hold executable calls until provider finish, or an explicitly bounded MiMo batch. */
export function guardToolCallStream(stream: ReadableStream<LanguageModelV3StreamPart>, yieldCompleteBatch = false) {
  const reader = stream.getReader()
  const calls: Call[] = []
  const pending = new Map<string, Call>()
  const buffered: LanguageModelV3StreamPart[] = []
  const ended = new Set<string>()
  const text = new Set<string>()
  const reasoning = new Set<string>()
  let local = true
  let finished = false
  return new ReadableStream<LanguageModelV3StreamPart>({
    async pull(controller) {
      while (true) {
        const next = await reader.read()
        if (next.done) {
          if (!finished && calls.length) {
            controller.enqueue({ type: "error", error: new Error("Model stream ended before tool calls finished") })
          }
          controller.close()
          return
        }
        const event = next.value
        if (event.type === "text-start") text.add(event.id)
        if (event.type === "text-end") text.delete(event.id)
        if (event.type === "reasoning-start") reasoning.add(event.id)
        if (event.type === "reasoning-end") reasoning.delete(event.id)
        if (event.type === "tool-input-end") ended.add(event.id)
        if (event.type.startsWith("tool-")) {
          if ("providerExecuted" in event && event.providerExecuted) local = false
          if ("providerMetadata" in event && event.providerMetadata) local = false
          if (event.type === "tool-result" || event.type === "tool-approval-request") local = false
        }
        let start: Extract<LanguageModelV3StreamPart, { type: "tool-input-start" }> | undefined
        if (event.type === "tool-input-start") {
          const call = { id: event.id, name: event.toolName, input: "" }
          calls.push(call)
          pending.set(event.id, call)
        }
        if (event.type === "tool-input-delta") {
          const call = pending.get(event.id)
          if (call) call.input += event.delta
        }
        if (event.type === "tool-call") {
          const call = pending.get(event.toolCallId)
          if (!call) {
            calls.push({ id: event.toolCallId, name: event.toolName, input: event.input })
            start = {
              type: "tool-input-start",
              id: event.toolCallId,
              toolName: event.toolName,
              providerExecuted: event.providerExecuted,
            }
          }
          if (call) {
            call.name = event.toolName
            call.input = event.input
          }
          pending.delete(event.toolCallId)
        }
        if (calls.length > TOOLCALL_FLOODING_LIMIT) {
          const batch = calls.slice(0, TOOLCALL_FLOODING_LIMIT)
          // MiMo can keep generating new calls instead of yielding observations.
          // The compatible adapter buffers tool-call events until finish, so use
          // only complete JSON inputs at this explicit batch boundary. The SDK
          // still validates schemas and runs the normal permission/execution gate.
          if (
            yieldCompleteBatch &&
            local &&
            new Set(calls.map((call) => call.id)).size === calls.length &&
            batch.every((call) => complete(call.input))
          ) {
            for (const id of text) controller.enqueue({ type: "text-end", id })
            for (const id of reasoning) controller.enqueue({ type: "reasoning-end", id })
            for (const call of batch) {
              if (!ended.has(call.id)) controller.enqueue({ type: "tool-input-end", id: call.id })
              controller.enqueue({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.input })
            }
            // This is a local yield, not a provider finish. No usage chunk has
            // arrived: leave usage unknown instead of inventing token counts.
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "mimocode_tool_call_limit" },
              usage: {
                inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: undefined, text: undefined, reasoning: undefined },
              },
              providerMetadata: { mimocode: { toolCallLimit: TOOLCALL_FLOODING_LIMIT } },
            })
            buffered.length = 0
            controller.close()
            void reader.cancel("MiMo tool batch complete").catch(() => {})
            return
          }
          if (start) controller.enqueue(start)
          if (event.type === "tool-input-start") controller.enqueue(event)
          const error = new ToolCallFloodingError(calls)
          buffered.length = 0
          controller.enqueue({ type: "error", error })
          controller.close()
          void reader.cancel(error).catch(() => {})
          return
        }
        if (start) controller.enqueue(start)
        if (event.type === "error") {
          buffered.length = 0
          controller.enqueue(event)
          controller.close()
          void reader.cancel(event.error).catch(() => {})
          return
        }
        // Keep provider tool results/approvals behind their calls as well.
        if (event.type === "tool-call" || event.type === "tool-result" || event.type === "tool-approval-request") {
          buffered.push(event)
          continue
        }
        if (event.type === "finish") {
          finished = true
          for (const call of buffered) controller.enqueue(call)
          buffered.length = 0
        }
        controller.enqueue(event)
        return
      }
    },
    cancel(reason) {
      buffered.length = 0
      return reader.cancel(reason)
    },
  })
}

export function toolCallFloodingMiddleware(yieldCompleteBatch = false): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",
    async wrapStream({ doStream }) {
      const disabled = Flag.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
      const result = await doStream()
      return disabled ? result : { ...result, stream: guardToolCallStream(result.stream, yieldCompleteBatch) }
    },
  }
}
