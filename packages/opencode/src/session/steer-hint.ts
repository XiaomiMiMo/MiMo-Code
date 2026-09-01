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
 * Real user messages after the newest same-session assistant — the pending
 * set the loop is about to pick up.
 */
export function pendingUserMessages(messages: MessageV2.WithParts[]): MessageV2.WithParts[] {
  const lastAssistantIdx = messages.findLastIndex(
    (m) => m.info.role === "assistant" && m.info.sessionID === messages.at(-1)?.info.sessionID,
  )
  return messages.slice(lastAssistantIdx + 1).filter((m) => m.info.role === "user" && hasRealUserText(m))
}

function isSameSessionAssistant(
  m: MessageV2.WithParts,
  sessionID: string,
): m is MessageV2.WithParts & { info: MessageV2.Assistant } {
  return m.info.role === "assistant" && m.info.sessionID === sessionID
}

/**
 * Steer pickup = the agent loop's "new user" branch: lastUser.id >
 * lastAssistant.id. At that moment lastUser cannot already be answered —
 * if it were, the loop would be in the continue-assistant branch.
 *
 * Fire only when that new user is real prose and was written while the
 * previous same-session assistant was still open (true mid-turn steer),
 * or when several real users are stacked after the last assistant.
 *
 * Ordinary sequential turns after a finished reply do NOT fire.
 * Synthetic-only users never count. Parent assistants from contextFrom
 * (different sessionID) do not count.
 */
export function shouldInjectSteerHint(input: {
  messages: MessageV2.WithParts[]
  lastUser: MessageV2.WithParts
  lastAssistant: MessageV2.Assistant | undefined
}): boolean {
  const { messages, lastUser, lastAssistant } = input
  if (lastUser.info.role !== "user") return false
  if (!hasRealUserText(lastUser)) return false

  // State machine: only the new-user branch is a steer pickup.
  if (lastAssistant && lastAssistant.sessionID === lastUser.info.sessionID && lastUser.info.id < lastAssistant.id) {
    return false
  }

  const lastUserIdx = messages.findLastIndex((m) => m.info.id === lastUser.info.id)
  if (lastUserIdx < 0) return false

  if (pendingUserMessages(messages).length > 1) return true

  const lastAsst = messages
    .slice(0, lastUserIdx)
    .filter((m) => isSameSessionAssistant(m, lastUser.info.sessionID))
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
