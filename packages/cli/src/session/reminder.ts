import type { MessageV2 } from "./message-v2"
import type { SessionID } from "./schema"

// Identity of a synthetic reminder part, stored at `metadata.reminder`. Equal
// `key` and `rev` mean the same reminder; text is never inspected, so wording
// can change freely. Producers outside the engine (e.g. MiMo Desktop through
// TextPartInput.metadata) use namespaced keys such as `desktop.runtime`.
export interface Tag {
  readonly key: string
  readonly rev?: string
}

export const METADATA_KEY = "reminder"

export function tag(part: MessageV2.Part): Tag | undefined {
  if (part.type !== "text" || !part.synthetic || part.ignored) return undefined
  const value: unknown = part.metadata?.[METADATA_KEY]
  if (!value || typeof value !== "object" || !("key" in value)) return undefined
  if (typeof value.key !== "string" || !value.key) return undefined
  if (!("rev" in value) || value.rev == null) return { key: value.key }
  if (typeof value.rev !== "string") return undefined
  return { key: value.key, rev: value.rev }
}

export function has(parts: readonly MessageV2.Part[], reminder: Tag): boolean {
  return parts.some((part) => {
    const found = tag(part)
    return !!found && found.key === reminder.key && (found.rev ?? null) === (reminder.rev ?? null)
  })
}

// The user message that should carry a once-per-context-window reminder, or
// undefined when the window already has it. `msgs` starts at the latest
// checkpoint/compaction boundary, so the first own user message is the
// session's first message or the boundary. A user message followed by any
// model reply (compaction summaries excluded) was already sent without the
// reminder — batched or mid-turn inputs never become a reply's parentID, so
// position is the test. Rewriting sent history would invalidate the cached
// prefix, so copied fork history and sessions predating the reminder get it on
// the newest own user message instead.
export function windowTarget(input: {
  msgs: readonly MessageV2.WithParts[]
  sessionID: SessionID
  reminder: Tag
}): MessageV2.WithParts | undefined {
  const users = input.msgs.filter((m) => m.info.role === "user" && m.info.sessionID === input.sessionID)
  if (users.some((m) => has(m.parts, input.reminder))) return undefined
  const unsent = (target: MessageV2.WithParts | undefined) =>
    target &&
    !input.msgs
      .slice(input.msgs.indexOf(target) + 1)
      .some((m) => m.info.role === "assistant" && !m.info.summary)
      ? target
      : undefined
  return unsent(users.at(0)) ?? unsent(users.at(-1))
}

export * as SessionReminder from "./reminder"
