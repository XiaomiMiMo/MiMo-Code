import type { ModelMessage } from "ai"

import type { Part } from "./types"

/**
 * Bridge a single JSON step (assistant `parts` + `toolCalls`/`toolResults`)
 * into the Renderer's next step: one `ModelMessage` with `content: Array<Part>`.
 *
 * This is the ONE seam the Renderer uses for everything that crosses the
 * provider boundary. It is a direct, lossless copy of the persisted JSON
 * parts — no markers, no re-wrapping, no synthetic content. The output text
 * is computed by the Renderer from the parts' own display order.
 */
export function jsonPartsToModelMessage(
  role: "user" | "assistant" | "system",
  parts: Array<Part>,
  toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>,
  toolResults?: Array<{ toolCallId: string; toolName: string; output?: unknown; result?: unknown }>,
): ModelMessage {
  // Copy the parts; the Renderer may sort them for display but the array
  // itself is not mutated. Cast to a mutable array type for push().
  const content = [...parts] as Array<Part>

  // Bridge tool results so a follow-up provider call can see them.
  if (toolResults?.length) {
    for (const tr of toolResults) {
      const output = tr.output ?? tr.result
      content.push({
        type: "tool-result",
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        output,
      } as unknown as Part)
    }
  }

  // Bridge tool calls so the next provider call can see them.
  if (toolCalls?.length) {
    for (const tc of toolCalls) {
      content.push({
        type: "tool-call",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input ?? {},
      } as unknown as Part)
    }
  }

  return { role, content } as ModelMessage
}
