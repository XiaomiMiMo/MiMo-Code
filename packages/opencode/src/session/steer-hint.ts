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

/**
 * Steer pickup is a loop-local fact, not a timestamp guess:
 *
 * - step 0: this runLoop just started (first message of a turn).
 * - step ≥ 1 and lastUser.id > lastAssistant.id: the loop was already running
 *   and a newer user appeared — a mid-turn steer (picked up at a tool-call gap).
 * - step ≥ 1 and lastUser.id < lastAssistant.id: continuing the current
 *   assistant; the user is that turn's user, not a new steer.
 *
 * Synthetic-only users never count. Parent assistants from contextFrom
 * (different sessionID) do not count. Caller passes the last REAL user so
 * inbox.drain synthetics cannot hide a steer.
 */
export function shouldInjectSteerHint(input: {
  messages: MessageV2.WithParts[]
  lastUser: MessageV2.WithParts
  lastAssistant: MessageV2.Assistant | undefined
  step: number
}): boolean {
  const { messages, lastUser, lastAssistant, step } = input
  if (step < 1) return false
  if (lastUser.info.role !== "user") return false
  if (!hasRealUserText(lastUser)) return false
  if (lastAssistant && lastAssistant.sessionID === lastUser.info.sessionID && lastUser.info.id < lastAssistant.id) {
    return false
  }
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
