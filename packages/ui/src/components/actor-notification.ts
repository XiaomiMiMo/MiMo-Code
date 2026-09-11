/**
 * Parse <actor-notification> and <inbox> tags from synthetic text parts.
 * Mirrors the TUI's parseActorNotification but adds <inbox> support for
 * mid-progress updates from subagents.
 */

export type ActorNotificationStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "stalled"
  | "ended"

export type ActorNotification = {
  type: "actor-notification"
  status: ActorNotificationStatus
  description: string
  summary?: string
}

export type InboxMessage = {
  type: "inbox"
  from: string
  sentAt: string
  content: string
}

export type ParsedNotification = ActorNotification | InboxMessage

/**
 * Parse a synthetic text part and return structured notification data.
 * Returns null if the text doesn't contain a recognized notification format.
 */
export function parseNotification(text: string): ParsedNotification | null {
  const trimmed = text.trimStart()

  // Try <actor-notification> first (terminal states)
  if (trimmed.startsWith("<actor-notification>")) {
    return parseActorNotification(trimmed)
  }

  // Try <inbox> (mid-progress updates)
  if (trimmed.startsWith("<inbox ")) {
    return parseInboxMessage(trimmed)
  }

  return null
}

function parseActorNotification(text: string): ActorNotification | null {
  const header = text.match(
    /Background (?:sub-session|actor) "(.*?)" \(actor_id: [^)]*\)\s+(completed|finished|ended|failed|was cancelled|stalled)\b/,
  )
  if (!header) return null

  const description = header[1]
  const verb = header[2]
  const status: ActorNotificationStatus =
    verb === "completed"
      ? "completed"
      : verb === "finished" || verb === "failed"
        ? "failed"
        : verb === "ended"
          ? "ended"
          : verb === "stalled"
            ? "stalled"
            : "cancelled"

  // Prefer Summary > Result > Error for the one-liner
  const resultIdx = text.search(/^Result:/m)
  const beforeResult = resultIdx === -1 ? text : text.slice(0, resultIdx)
  const line = (label: string, scope: string) =>
    scope.match(new RegExp(`^${label}:\\s*(.+)$`, "m"))?.[1]?.trim()
  const summary = line("Summary", beforeResult) ?? line("Result", text) ?? line("Error", text)

  return summary ? { type: "actor-notification", status, description, summary } : { type: "actor-notification", status, description }
}

function parseInboxMessage(text: string): InboxMessage | null {
  // Match <inbox from="..." sent_at="...">content</inbox>
  // Use greedy matching for content to handle nested </inbox> in code blocks
  const match = text.match(
    /<inbox\s+from="([^"]*)"\s+sent_at="([^"]*)"\s*>([\s\S]*)<\/inbox>\s*$/,
  )
  if (!match) return null

  const from = match[1]
  const sentAt = match[2]
  // Preserve leading/trailing whitespace for code blocks, but trim excess
  const content = match[3].replace(/^\n/, "").replace(/\n$/, "")

  return { type: "inbox", from, sentAt, content }
}

/**
 * Get an icon name for a notification status.
 */
export function notificationStatusIcon(status: ActorNotificationStatus): "circle-check" | "circle-ban-sign" | "circle-x" | "warning" | "help" {
  switch (status) {
    case "completed":
      return "circle-check"
    case "failed":
      return "circle-ban-sign"
    case "cancelled":
      return "circle-x"
    case "stalled":
      return "warning"
    case "ended":
      return "help"
  }
}
