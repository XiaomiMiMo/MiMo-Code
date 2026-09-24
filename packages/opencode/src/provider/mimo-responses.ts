import { EventSourceParserStream } from "@ai-sdk/provider-utils"
import { isRecord } from "../util/record"

// MiMo emits full reasoning text, whereas the OpenAI adapter consumes summaries.
// Normalize only this wire difference; the SDK still parses tools, usage and errors.
function event(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (value.type === "response.reasoning_text.delta") {
    return { ...value, type: "response.reasoning_summary_text.delta", summary_index: value.content_index }
  }
  if (
    (value.type === "response.content_part.added" || value.type === "response.content_part.done") &&
    isRecord(value.part) &&
    value.part.type === "reasoning_text"
  ) {
    return {
      ...value,
      type:
        value.type === "response.content_part.added"
          ? "response.reasoning_summary_part.added"
          : "response.reasoning_summary_part.done",
      summary_index: value.content_index,
      part: { ...value.part, type: "summary_text" },
    }
  }
  return value
}

/** Used exclusively by MiMo Responses transports, never standard OpenAI or Chat. */
export async function normalizeMimoResponse(response: Response): Promise<Response> {
  if (!response.ok || !response.body) return response
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  if (headers.get("content-type")?.includes("text/event-stream")) {
    const body = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())
      .pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            let data = chunk.data
            let type = chunk.event
            if (data !== "[DONE]") {
              // Preserve malformed data so the SDK reports the original parse failure.
              try {
                const value = event(JSON.parse(data))
                data = JSON.stringify(value)
                if (type && isRecord(value) && typeof value.type === "string") type = value.type
              } catch {}
            }
            controller.enqueue(
              `${chunk.id ? `id: ${chunk.id}\n` : ""}${type ? `event: ${type}\n` : ""}${data
                .split("\n")
                .map((line) => `data: ${line}`)
                .join("\n")}\n\n`,
            )
          },
        }),
      )
      .pipeThrough(new TextEncoderStream())
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  }
  if (!headers.get("content-type")?.includes("application/json")) return response
  const value: unknown = await response.json()
  if (isRecord(value) && Array.isArray(value.output)) {
    value.output = value.output.map((item) => {
      if (
        !isRecord(item) ||
        item.type !== "reasoning" ||
        !Array.isArray(item.summary) ||
        item.summary.length ||
        !Array.isArray(item.content)
      )
        return item
      return {
        ...item,
        summary: item.content
          .filter((part) => isRecord(part) && part.type === "reasoning_text")
          .map((part) => ({ type: "summary_text", text: part.text })),
      }
    })
  }
  return new Response(JSON.stringify(value), { status: response.status, statusText: response.statusText, headers })
}
