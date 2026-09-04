import { createHash } from "node:crypto"
import type { MessageV2 } from "../message-v2"

export const LOOP_STREAK_TRIGGER_COUNT = 3
export const LOOP_STREAK_MAX_SPAN = 64

export function normalizeReasoningForStreak(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(let me |i'll |i will |let's )/i, "")
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]"
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") +
    "}"
  )
}

export function reasonHash(parts: MessageV2.Part[]): string {
  const joined = parts
    .filter((part): part is MessageV2.ReasoningPart => part.type === "reasoning")
    .map((part) => part.text)
    .join("")
  const text = normalizeReasoningForStreak(joined)
  if (!text) return ""
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

export function toolSignature(parts: MessageV2.Part[]): string {
  const segments = parts
    .filter((part): part is MessageV2.ToolPart => part.type === "tool")
    .map((part) => `tool:${part.tool}:${stableStringify(part.state.input ?? {})}`)
  if (segments.length === 0) return ""
  return segments.join("\n")
}

export function streakKey(parts: MessageV2.Part[]): string {
  // Thinking is the loop source. When present, key on thinking alone so
  // slightly drifted tools still count as the same streak (MR-3931 shape).
  // Fall back to exact tool signature only for thinking-less steps.
  const reason = reasonHash(parts)
  if (reason) return `reason:${reason}`
  const tools = toolSignature(parts)
  if (!tools) return ""
  return `tool:${tools}`
}

export type StreakEntry = {
  id: string
  key: string
}

export type StreakSpan = {
  fromId: string
  toId: string
  anchorId: string | undefined
  key: string
  length: number
  truncated: boolean
}

export function detectStreak(
  entries: readonly StreakEntry[],
  triggerCount: number = LOOP_STREAK_TRIGGER_COUNT,
  maxSpan: number = LOOP_STREAK_MAX_SPAN,
): StreakSpan | undefined {
  if (triggerCount < 2 || entries.length < triggerCount) return undefined
  const tail = entries.slice(-triggerCount)
  const key = tail[tail.length - 1].key
  if (!key) return undefined
  if (!tail.every((entry) => entry.key === key)) return undefined

  let start = entries.length - 1
  while (start > 0 && entries[start - 1].key === key) start--

  const fullLength = entries.length - start
  const truncated = fullLength > maxSpan
  const fromIndex = truncated ? entries.length - maxSpan : start
  const anchorIndex = fromIndex - 1
  return {
    fromId: entries[fromIndex].id,
    toId: entries[entries.length - 1].id,
    anchorId: anchorIndex >= 0 ? entries[anchorIndex].id : undefined,
    key,
    length: entries.length - fromIndex,
    truncated,
  }
}

export type StreakMessage = {
  info: { id: string; role: MessageV2.Info["role"] }
  parts: MessageV2.Part[]
}

export type StreakCrop = {
  kept: StreakMessage[]
  omitted: string[]
  remainingSimilar: number
  omittedMessages: number
  omittedParts: number
  omittedBlocks: number
  keptBlocks: number
  cacheRisk: boolean
}

export function estimateBlocks(messages: readonly StreakMessage[]): number {
  return messages.reduce((sum, message) => {
    const tools = message.parts.filter((part) => part.type === "tool").length
    const others = message.parts.filter(
      (part) => part.type === "reasoning" || part.type === "text",
    ).length
    return sum + tools * 2 + others
  }, 0)
}

export function cropMessagesForStreak(
  messages: readonly StreakMessage[],
  span: StreakSpan,
): StreakCrop {
  // Only omit assistants that are actually in the streak (matching key) inside
  // the id range. A text-only assistant with an empty key that happens to sit
  // between two streak steps is not part of the loop and must stay.
  const omittedIds = new Set(
    messages
      .filter(
        (message) =>
          message.info.role === "assistant" &&
          message.info.id >= span.fromId &&
          message.info.id <= span.toId &&
          streakKey(message.parts) === span.key,
      )
      .map((message) => message.info.id),
  )
  const kept = messages.filter((message) => !omittedIds.has(message.info.id))
  const omittedMessages = messages.filter((message) => omittedIds.has(message.info.id))
  const omitted = omittedMessages.map((m) => m.info.id)
  const remainingSimilar = messages.filter(
    (message) =>
      message.info.role === "assistant" &&
      message.info.id < span.fromId &&
      omittedIds.size > 0 &&
      streakKey(message.parts) === span.key,
  ).length
  const omittedParts = omittedMessages.reduce((sum, message) => sum + message.parts.length, 0)
  return {
    kept,
    omitted,
    remainingSimilar,
    omittedMessages: omittedMessages.length,
    omittedParts,
    omittedBlocks: estimateBlocks(omittedMessages),
    keptBlocks: estimateBlocks(kept),
    cacheRisk: estimateBlocks(omittedMessages) > 20,
  }
}

export const LOOP_STREAK_CROP_KIND = "loop_streak_crop"

export type PersistedStreakCrop = {
  fromId: string
  toId: string
  key: string
  truncated: boolean
}

export function cropMetadata(span: StreakSpan): {
  origin: { kind: typeof LOOP_STREAK_CROP_KIND } & PersistedStreakCrop
} {
  return {
    origin: {
      kind: LOOP_STREAK_CROP_KIND,
      fromId: span.fromId,
      toId: span.toId,
      key: span.key,
      truncated: span.truncated,
    },
  }
}

function cropOrigin(part: MessageV2.Part): (PersistedStreakCrop & { kind: string }) | undefined {
  if (part.type !== "text") return undefined
  const origin = part.metadata?.origin as { kind?: string } | undefined
  if (origin?.kind !== LOOP_STREAK_CROP_KIND) return undefined
  return origin as PersistedStreakCrop & { kind: string }
}

/**
 * All persisted spans, oldest first. A crop stays active for the life of the
 * session (or until the feature is turned off) — including after the user
 * sends a new message — so poison thinking cannot re-enter the request view.
 */
export function extractAllCrops(messages: readonly StreakMessage[]): PersistedStreakCrop[] {
  const crops: PersistedStreakCrop[] = []
  for (const message of messages) {
    if (message.info.role !== "user") continue
    for (const part of message.parts) {
      const origin = cropOrigin(part)
      if (!origin?.fromId || !origin?.toId || !origin?.key) continue
      crops.push({
        fromId: origin.fromId,
        toId: origin.toId,
        key: origin.key,
        truncated: origin.truncated === true,
      })
    }
  }
  return crops
}

/** Re-apply persisted spans. Same filter every request → stable prefix. */
export function applyPersistedCrops(
  messages: readonly StreakMessage[],
  crops: readonly PersistedStreakCrop[],
): { kept: StreakMessage[]; omitted: string[] } {
  if (crops.length === 0) return { kept: [...messages], omitted: [] }
  const omitted = messages
    .filter(
      (message) =>
        message.info.role === "assistant" &&
        crops.some(
          (crop) =>
            message.info.id >= crop.fromId &&
            message.info.id <= crop.toId &&
            streakKey(message.parts) === crop.key,
        ),
    )
    .map((message) => message.info.id)
  if (omitted.length === 0) return { kept: [...messages], omitted }
  const omittedSet = new Set(omitted)
  return { kept: messages.filter((message) => !omittedSet.has(message.info.id)), omitted }
}
