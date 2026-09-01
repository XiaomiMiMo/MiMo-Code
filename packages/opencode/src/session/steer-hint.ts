import type { MessageV2 } from "./message-v2"

export const STEER_HINT_MARKER = "Follow-up intent"

export function hasRealUserText(message: MessageV2.WithParts): boolean {
  return message.parts.some(
    (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim().length > 0,
  )
}

/** Last user message that still has real (non-synthetic) prose. */
export function lastRealUserMessage(messages: MessageV2.WithParts[]): MessageV2.WithParts | undefined {
  return messages.findLast((m) => m.info.role === "user" && hasRealUserText(m))
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

function sameSessionAssistantsAfter(
  messages: MessageV2.WithParts[],
  fromIdx: number,
  sessionID: string,
): boolean {
  return messages
    .slice(fromIdx + 1)
    .some((m) => m.info.role === "assistant" && m.info.sessionID === sessionID)
}

/**
 * Steer = a real user message written while the previous same-session assistant
 * was still open, and still unanswered (no later same-session assistant).
 *
 * - Ordinary sequential turns after a finished reply do NOT fire.
 * - Once an assistant exists after this user, it is the current turn (like the
 *   first user of that turn) — not a pending steer.
 * - Several stacked real users after the last assistant all count as pending.
 * - Synthetic-only users (inbox.drain, goal re-entry, …) never count.
 * - Parent assistants from contextFrom (different sessionID) do not count.
 */
export function shouldInjectSteerHint(messages: MessageV2.WithParts[], lastUser: MessageV2.WithParts): boolean {
  if (lastUser.info.role !== "user") return false
  if (!hasRealUserText(lastUser)) return false
  const lastUserIdx = messages.findLastIndex((m) => m.info.id === lastUser.info.id)
  if (lastUserIdx < 0) return false
  if (sameSessionAssistantsAfter(messages, lastUserIdx, lastUser.info.sessionID)) return false

  const pending = pendingUserMessages(messages)
  if (pending.length > 1) return true

  const lastAsst = messages
    .slice(0, lastUserIdx)
    .filter(
      (m): m is MessageV2.WithParts & { info: MessageV2.Assistant } =>
        m.info.role === "assistant" && m.info.sessionID === lastUser.info.sessionID,
    )
    .at(-1)
  if (!lastAsst) return false

  const userCreated = lastUser.info.time?.created
  const asstCreated = lastAsst.info.time.created
  const asstCompleted = lastAsst.info.time.completed
  if (userCreated == null) return false
  if (userCreated < asstCreated) return false
  if (asstCompleted != null && userCreated > asstCompleted) return false
  return true
}

/**
 * Attached to the last real user message. Does not re-embed message bodies —
 * only names how many unanswered user messages that set has.
 */
export function buildSteerHint(pendingCount: number): string {
  const body =
    pendingCount <= 1
      ? "This user message comes after earlier work in the conversation — keep that work unless the message clearly replaces it."
      : `There are ${pendingCount} unanswered user messages after your last reply (including this one), already in order above. Handle all of them together. Keep earlier work unless one of them clearly replaces it.`
  return ["<system-reminder>", STEER_HINT_MARKER, "", body, "</system-reminder>"].join("\n")
}
