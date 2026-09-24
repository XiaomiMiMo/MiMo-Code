import type { LanguageModelV3Content, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { z } from "zod/v4"
import { isRecord } from "../../../../util/record"

// OpenAI ResponseReasoningItem / ResponseReasoningItemParam. Some compatible
// streams omit summary in sparse start/end frames; absence is not an empty array.
export const reasoningItemSchema = z.object({
  type: z.literal("reasoning"),
  id: z.string(),
  summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() })).optional(),
  content: z.array(z.object({ type: z.literal("reasoning_text"), text: z.string() })).nullish(),
  encrypted_content: z.string().nullish(),
  status: z.enum(["in_progress", "completed", "incomplete"]).nullish(),
})
type Item = z.infer<typeof reasoningItemSchema>
type Channel = "summary" | "content" | "item"
type Part = { channel: Channel; index: number; text: string; id: string }
type State = { item: Item; parts: Map<string, Part>; initialContent?: [] | null }
type Sink = Pick<TransformStreamDefaultController<LanguageModelV3StreamPart>, "enqueue">

function metadata(item: Item, part: Part, complete = false, canonical = false) {
  return {
    openai: {
      itemId: item.id,
      reasoningChannel: part.channel,
      reasoningIndex: part.index,
      ...(item.encrypted_content !== undefined ? { reasoningEncryptedContent: item.encrypted_content } : {}),
      ...(complete ? { reasoningText: part.text } : {}),
      ...(canonical ? { reasoningItem: item } : {}),
    },
  }
}

export function reasoningContent(value: unknown): Array<Extract<LanguageModelV3Content, { type: "reasoning" }>> {
  const parsed = reasoningItemSchema.parse(value)
  const item = { ...parsed, summary: parsed.summary ?? [] }
  const parts: Array<{ channel: Channel; text: string; index: number }> = [
    ...item.summary.map((part, index) => ({ channel: "summary" as const, text: part.text, index })),
    ...(item.content ?? []).map((part, index) => ({ channel: "content" as const, text: part.text, index })),
  ]
  if (!parts.length) parts.push({ channel: "item", text: "", index: 0 })
  return parts.map((part, index) => ({
    type: "reasoning",
    text: part.text,
    providerMetadata: metadata(item, { ...part, id: item.id }, true, index === 0),
  }))
}

/** Stateful parsing of reasoning only; tools, usage, errors and text use the adapter's existing parser. */
export function reasoningStream(rotatingIds: boolean) {
  const active = new Map<string, State>()
  const indices = new Map<number, string>()
  const closed = new Set<string>()
  let current: string | undefined

  function state(id: string, index?: number) {
    const key = rotatingIds ? ((index != null ? indices.get(index) : active.has(id) ? id : current) ?? id) : id
    const existing = active.get(key)
    if (index != null) indices.set(index, key)
    current = key
    if (existing) return existing
    const result: State = { item: { type: "reasoning", id: key }, parts: new Map() }
    active.set(key, result)
    return result
  }

  function part(item: State, channel: Channel, index: number, sink: Sink) {
    const key = `${channel}:${index}`
    const existing = item.parts.get(key)
    if (existing) return existing
    const result = {
      channel,
      index,
      text: "",
      id: channel === "summary" ? `${item.item.id}:${index}` : `${item.item.id}:${key}`,
    }
    item.parts.set(key, result)
    sink.enqueue({ type: "reasoning-start", id: result.id, providerMetadata: metadata(item.item, result) })
    return result
  }

  function write(item: State, target: Part, text: string, delta: boolean, sink: Sink) {
    const suffix = delta ? text : text.startsWith(target.text) ? text.slice(target.text.length) : ""
    target.text = delta ? target.text + text : text
    if (suffix)
      sink.enqueue({
        type: "reasoning-delta",
        id: target.id,
        delta: suffix,
        providerMetadata: metadata(item.item, target),
      })
  }

  function complete(value: Item, index: number | undefined, sink: Sink) {
    if (closed.has(value.id)) return
    const item = state(value.id, index)
    item.item = { ...item.item, ...value, id: item.item.id }
    // Final arrays are authoritative. Omitted arrays are assembled from deltas.
    for (const channel of ["summary", "content"] as const) {
      const values = item.item[channel]
      if (values !== undefined) {
        values?.forEach((value, index) => write(item, part(item, channel, index, sink), value.text, false, sink))
        for (const entry of item.parts.values())
          if (entry.channel === channel && entry.index >= (values?.length ?? 0)) entry.text = ""
      }
    }
    const parts = (channel: Channel) =>
      [...item.parts.values()].filter((p) => p.channel === channel).sort((a, b) => a.index - b.index)
    const canonical: Item = {
      ...item.item,
      summary: item.item.summary ?? parts("summary").map((p) => ({ type: "summary_text", text: p.text })),
      ...(item.item.content === undefined
        ? parts("content").length
          ? { content: parts("content").map((p) => ({ type: "reasoning_text" as const, text: p.text })) }
          : item.initialContent !== undefined
            ? { content: item.initialContent }
            : {}
        : {}),
    }
    if (!item.parts.size) part(item, "item", 0, sink)
    let first = true
    for (const entry of item.parts.values()) {
      sink.enqueue({ type: "reasoning-end", id: entry.id, providerMetadata: metadata(canonical, entry, true, first) })
      first = false
    }
    active.delete(item.item.id)
    closed.add(value.id)
    closed.add(item.item.id)
    if (current === item.item.id) current = undefined
    for (const [index, id] of indices) if (id === item.item.id) indices.delete(index)
  }

  return {
    handle(value: unknown, sink: Sink): boolean {
      if (!isRecord(value)) return false
      const type = value.type
      if ((type === "response.completed" || type === "response.incomplete") && isRecord(value.response)) {
        if (Array.isArray(value.response.output))
          value.response.output.forEach((entry, index) => {
            if (isRecord(entry) && entry.type === "reasoning") complete(reasoningItemSchema.parse(entry), index, sink)
          })
        return false
      }
      if (
        (type === "response.output_item.added" || type === "response.output_item.done") &&
        isRecord(value.item) &&
        value.item.type === "reasoning"
      ) {
        const parsed = reasoningItemSchema.parse(value.item)
        const index = typeof value.output_index === "number" ? value.output_index : undefined
        if (type === "response.output_item.done") complete(parsed, index, sink)
        else if (!closed.has(parsed.id)) {
          const item = state(parsed.id, index)
          // Empty start arrays are placeholders, not terminal snapshots.
          item.item = { ...item.item, ...parsed, id: item.item.id }
          if (parsed.content !== undefined) item.initialContent = parsed.content === null ? null : []
          delete item.item.summary
          delete item.item.content
          for (const channel of ["summary", "content"] as const)
            (parsed[channel] ?? []).forEach((entry, index) =>
              write(item, part(item, channel, index, sink), entry.text, false, sink),
            )
        }
        return true
      }
      const summary =
        typeof type === "string" && /^response\.reasoning_summary_(text|part)\.(added|delta|done)$/.test(type)
      const content =
        type === "response.reasoning_text.delta" ||
        type === "response.reasoning_text.done" ||
        type === "response.reasoning_content.delta" ||
        ((type === "response.content_part.added" || type === "response.content_part.done") &&
          isRecord(value.part) &&
          value.part.type === "reasoning_text")
      if (!summary && !content) return false
      const id = z.string().parse(value.item_id)
      if (closed.has(id)) return true
      const channel = summary ? "summary" : "content"
      const index = z
        .number()
        .int()
        .nonnegative()
        .parse((summary ? value.summary_index : value.content_index) ?? 0)
      const item = state(id, typeof value.output_index === "number" ? value.output_index : undefined)
      const target = part(item, channel, index, sink)
      const text =
        typeof type === "string" && type.endsWith(".delta")
          ? value.delta
          : (value.text ?? (isRecord(value.part) ? value.part.text : undefined))
      if (text !== undefined)
        write(item, target, z.string().parse(text), typeof type === "string" && type.endsWith(".delta"), sink)
      return true
    },
    flush(sink: Sink) {
      for (const item of [...active.values()]) complete(item.item, undefined, sink)
    },
  }
}
