import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { isParsableJson } from "@ai-sdk/provider-utils"
import { Flag } from "@/flag/flag"

export const TOOLCALL_FLOODING_LIMIT = 16
export const TOOLCALL_FLOODING_ERROR = "Tool call cancelled because tool-call flooding was detected."
export const TOOLCALL_FLOODING_REMINDER = `<system-reminder>
Tool-call flooding was detected. The first tool call may have run; check its result for success, failure, an invalid call, or cancellation. All later client tool calls were cancelled because of flooding. Continue with a smaller batch.
Prefer 1–3 tool calls per step. Avoid more than 8 calls in a single step.
</system-reminder>`

type Call = { id: string; name: string; input: string; providerExecuted?: boolean }

export class ToolCallFloodingError extends Error {
  constructor(
    readonly calls: Call[],
    readonly releasedCallID?: string,
  ) {
    super(TOOLCALL_FLOODING_ERROR)
    this.name = "ToolCallFloodingError"
  }
}

/** Hold executable calls until provider finish, which precedes SDK tool results. */
export function guardToolCallStream(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const reader = stream.getReader()
  const calls: Call[] = []
  const pending = new Map<string, Call>()
  const buffered: LanguageModelV3StreamPart[] = []
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
        if (event.type === "tool-input-start") {
          const call = { id: event.id, name: event.toolName, input: "", providerExecuted: event.providerExecuted }
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
            calls.push({
              id: event.toolCallId,
              name: event.toolName,
              input: event.input,
              providerExecuted: event.providerExecuted,
            })
            controller.enqueue({
              type: "tool-input-start",
              id: event.toolCallId,
              toolName: event.toolName,
              providerExecuted: event.providerExecuted,
            })
          }
          if (call) {
            call.name = event.toolName
            call.input = event.input
            call.providerExecuted ||= event.providerExecuted
          }
          pending.delete(event.toolCallId)
        }
        if (calls.length > TOOLCALL_FLOODING_LIMIT) {
          if (event.type === "tool-input-start") controller.enqueue(event)
          const first = calls[0]
          const release =
            !first.providerExecuted &&
            isParsableJson(first.input) &&
            !calls.slice(1).some((call) => call.id === first.id)
          const error = new ToolCallFloodingError(calls, release ? first.id : undefined)
          // Cancel generation only; the SDK's request signal must stay live for
          // the admitted tool's validation, permission checks, and execution.
          void reader.cancel(error).catch(() => {})
          if (release) {
            controller.enqueue(
              buffered.find((event) => event.type === "tool-call" && event.toolCallId === first.id) ?? {
                type: "tool-call",
                toolCallId: first.id,
                toolName: first.name,
                input: first.input,
              },
            )
          }
          buffered.length = 0
          controller.enqueue({ type: "error", error })
          controller.close()
          return
        }
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

export const toolCallFloodingMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",
  async wrapStream({ doStream }) {
    const disabled = Flag.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
    const result = await doStream()
    return disabled ? result : { ...result, stream: guardToolCallStream(result.stream) }
  },
}
