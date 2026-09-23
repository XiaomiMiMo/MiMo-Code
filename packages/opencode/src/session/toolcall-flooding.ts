import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Flag } from "@/flag/flag"

export const TOOLCALL_FLOODING_LIMIT = 8
export const TOOLCALL_DUPLICATE_ERROR =
  "Tool call cancelled because it exactly matches an earlier tool call in this step and was not executed."

/** Generation was cut at the ninth call. Earlier calls already streamed out. */
export class ToolCallFloodingError extends Error {
  constructor() {
    super("Tool-call flooding was detected.")
    this.name = "ToolCallFloodingError"
  }
}

/**
 * Pass tool calls through immediately so they can execute while the model
 * streams. The ninth observed call is never forwarded. Keep pumping until the
 * first eight complete (OpenAI-compatible delivers completes at EOF) so those
 * calls can run; then cancel generation.
 */
export function guardToolCallStream(stream: ReadableStream<LanguageModelV3StreamPart>) {
  if (Flag.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT) return stream
  const reader = stream.getReader()
  const admitted = new Map<string, boolean>()
  let overflow = false
  const settled = () => admitted.size > 0 && [...admitted.values()].every(Boolean)
  const flood = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => {
    void reader.cancel().catch(() => {})
    controller.enqueue({ type: "error", error: new ToolCallFloodingError() })
    controller.close()
  }
  return new ReadableStream<LanguageModelV3StreamPart>({
    async pull(controller) {
      while (true) {
        const next = await reader.read()
        if (next.done) {
          if (overflow) {
            flood(controller)
            return
          }
          controller.close()
          return
        }
        const event = next.value
        if (event.type === "tool-input-start") {
          if (admitted.has(event.id)) {
            controller.enqueue(event)
            return
          }
          if (admitted.size < TOOLCALL_FLOODING_LIMIT) {
            admitted.set(event.id, false)
            controller.enqueue(event)
            return
          }
          overflow = true
          if (settled()) {
            flood(controller)
            return
          }
          continue
        }
        if (event.type === "tool-input-delta") {
          if (admitted.has(event.id)) {
            controller.enqueue(event)
            return
          }
          continue
        }
        if (event.type === "tool-call") {
          if (admitted.has(event.toolCallId)) {
            admitted.set(event.toolCallId, true)
            controller.enqueue(event)
            if (overflow && settled()) {
              flood(controller)
              return
            }
            return
          }
          if (admitted.size < TOOLCALL_FLOODING_LIMIT && !overflow) {
            admitted.set(event.toolCallId, true)
            controller.enqueue({
              type: "tool-input-start",
              id: event.toolCallId,
              toolName: event.toolName,
              providerExecuted: event.providerExecuted,
            })
            controller.enqueue(event)
            return
          }
          overflow = true
          if (settled()) {
            flood(controller)
            return
          }
          continue
        }
        if (event.type === "error") {
          controller.enqueue(event)
          controller.close()
          void reader.cancel(event.error).catch(() => {})
          return
        }
        controller.enqueue(event)
        return
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

export const toolCallFloodingMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",
  async wrapStream({ doStream }) {
    const result = await doStream()
    return { ...result, stream: guardToolCallStream(result.stream) }
  },
}
