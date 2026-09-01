import type { MessageV2 } from "./message-v2"

export const STEER_HINT_MARKER = "Follow-up intent"

export function hasRealUserText(message: MessageV2.WithParts): boolean {
  return message.parts.some(
    (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim().length > 0,
  )
}

/**
 * Real user messages after the newest same-session assistant — unanswered
 * follow-ups. Already present in the conversation; the hint only names the set.
 */
export function pendingUserMessages(messages: MessageV2.WithParts[]): MessageV2.WithParts[] {
  const lastAssistantIdx = messages.findLastIndex(
    (m) => m.info.role === "assistant" && m.info.sessionID === messages.at(-1)?.info.sessionID,
  )
  return messages.slice(lastAssistantIdx + 1).filter((m) => m.info.role === "user" && hasRealUserText(m))
}

/**
 * True when the current last user message is a mid-turn steer:
 * - several real user messages are stacked after the last same-session assistant, or
 * - this user message was created while that assistant was still open
 *   (created before assistant.time.completed).
 *
 * Ordinary sequential turns after a finished reply do NOT fire — they are a
 * normal new task and must not rewrite the frozen model-request prefix.
 * First turn never fires. Synthetic-only last users never fire. Parent
 * assistants inherited via contextFrom (different sessionID) do not count.
 */
export function shouldInjectSteerHint(messages: MessageV2.WithParts[], lastUser: MessageV2.WithParts): boolean {
  if (lastUser.info.role !== "user") return false
  if (!hasRealUserText(lastUser)) return false
  const lastUserIdx = messages.findLastIndex((m) => m.info.id === lastUser.info.id)
  if (lastUserIdx < 0) return false

  const pending = pendingUserMessages(messages)
  if (pending.length > 1) return true

  const priorAssistants = messages.slice(0, lastUserIdx).filter(
    (m): m is MessageV2.WithParts & { info: MessageV2.Assistant } =>
      m.info.role === "assistant" && m.info.sessionID === lastUser.info.sessionID,
  )
  const lastAsst = priorAssistants.at(-1)
  if (!lastAsst) return false

  const userCreated = lastUser.info.time?.created
  const asstCreated = lastAsst.info.time.created
  const asstCompleted = lastAsst.info.time.completed
  if (userCreated == null) return false
  if (userCreated < asstCreated) return false
  // Sequential new turn after a finished reply.
  if (asstCompleted != null && userCreated > asstCompleted) return false
  return true
}

/**
 * Attached to lastUser. Does not re-embed message bodies (they are already in
 * the transcript after the last assistant reply) — only names how many
 * unanswered user messages that set has.
 */
export function buildSteerHint(pendingCount: number): string {
  const body =
    pendingCount <= 1
      ? "This user message comes after earlier work in the conversation — keep that work unless the message clearly replaces it."
      : `There are ${pendingCount} unanswered user messages after your last reply (including this one), already in order above. Handle all of them together. Keep earlier work unless one of them clearly replaces it.`
  return ["<system-reminder>", STEER_HINT_MARKER, "", body, "</system-reminder>"].join("\n")
}
