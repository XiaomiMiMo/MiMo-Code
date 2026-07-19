import type { InboxRow } from "./inbox.sql"

export function renderInboxRow(row: InboxRow): string {
  if (row.type === "actor_notification") {
    // Pre-rendered notification text — sender produced the full
    // <actor-notification>...</actor-notification> wrapper.
    const content = row.content as { text?: string }
    return content.text ?? "(no notification body)"
  }
  // Default: type === "text" or unknown — wrap as <inbox> element so
  // the LLM can route by sender; the wrapper format mirrors the
  // <actor-notification> convention from the legacy completion.ts.
  const content = row.content as { text?: string }
  const sender = row.sender_session_id
    ? `${row.sender_session_id}:${row.sender_actor_id ?? "?"}`
    : "system"
  const sentAt = new Date(row.created_at).toISOString()
  return `<inbox from="${sender}" sent_at="${sentAt}">\n${content.text ?? "(empty)"}\n</inbox>`
}

export function renderActorNotification(event: {
  actorID: string
  description: string
  status: "completed" | "failed" | "cancelled" | "stalled"
  result?: string
  error?: string
  reportedStatus?: string
  reportedSummary?: string
  // For a stalled notification: how long (ms) since the child's last turn advanced.
  stalledForMs?: number
}): string {
  const header = `Background sub-session "${event.description}" (actor_id: ${event.actorID})`
  if (event.status === "completed") {
    // event.status is the sub-session *process lifecycle* — it ended cleanly.
    // event.reportedStatus is the *task* outcome the sub-session self-reported
    // via a `**Status**: ...` header. These are independent: a process can exit
    // cleanly while the task failed/blocked. Word the top line by the task
    // outcome so we never imply a success the sub-session didn't claim.
    const reported = event.reportedStatus?.toLowerCase()
    const summaryLine = event.reportedSummary ? `\nSummary: ${event.reportedSummary}` : ""
    const resultLine = `\nResult: ${event.result ?? "(no output)"}`
    // success/partial (or absent → treat as a plain completion) keep the
    // affirmative "completed" verb.
    if (!reported || reported === "success" || reported === "partial") {
      const statusLine = reported ? `\nStatus: ${reported}` : ""
      return `<actor-notification>\n${header} completed.${statusLine}${summaryLine}${resultLine}\n</actor-notification>`
    }
    // failed/blocked → the sub-session ran to the end but the task did not
    // succeed. State the outcome; never say "completed".
    if (reported === "failed" || reported === "blocked") {
      return `<actor-notification>\n${header} finished (status: ${reported}).${summaryLine}${resultLine}\n</actor-notification>`
    }
    // Any other reported value = unknown/unrecognized → neutral verb, and omit
    // the misleading "Status: unknown" line entirely.
    return `<actor-notification>\n${header} ended (status not reported).${summaryLine}${resultLine}\n</actor-notification>`
  }
  if (event.status === "failed") {
    return `<actor-notification>\n${header} failed.\nError: ${event.error ?? "unknown"}\n</actor-notification>`
  }
  if (event.status === "stalled") {
    const forLine =
      event.stalledForMs !== undefined ? ` (no turn advance for ${Math.floor(event.stalledForMs / 1000)}s)` : ""
    return `<actor-notification>\n${header} appears stalled${forLine}. It is still running but has made no progress. Consider checking on it, sending it a nudge, or cancelling it.\n</actor-notification>`
  }
  return `<actor-notification>\n${header} was cancelled.\n</actor-notification>`
}

export type ParsedActorNotification = {
  // "stalled" is reserved for a future watchdog-emitted notification;
  // renderActorNotification never produces it today (only completed/failed/
  // cancelled lifecycle). The parse + card styling exist ahead of that producer.
  // "ended" is the completed-lifecycle case where the sub-session's task
  // outcome was not reported — neutral, neither success nor failure.
  status: "completed" | "failed" | "cancelled" | "stalled" | "ended"
  description: string
  summary?: string
}

// Inverse of renderActorNotification: recover the structured fields from the
// pre-rendered <actor-notification> text so the TUI can show a card instead of
// the raw wrapper. Pure + exported so it's unit-testable without the renderer.
// Returns null for any text that isn't an actor notification.
export function parseActorNotification(text: string): ParsedActorNotification | null {
  if (!text.trimStart().startsWith("<actor-notification>")) return null
  // The verb reflects the *task* outcome, not just the process lifecycle:
  //   completed                         → task succeeded / plain completion
  //   finished (status: failed|blocked) → process ended cleanly, task not ok
  //   ended (status not reported)       → process ended cleanly, outcome unknown
  //   failed                            → the process itself failed
  //   was cancelled / stalled           → cancelled / watchdog
  const header = text.match(
    /Background (?:sub-session|actor) "(.*?)" \(actor_id: [^)]*\)\s+(completed|finished|ended|failed|was cancelled|stalled)\b/,
  )
  if (!header) return null
  const description = header[1]
  const verb = header[2]
  const status: ParsedActorNotification["status"] =
    verb === "completed"
      ? "completed"
      : verb === "finished" || verb === "failed"
        ? "failed"
        : verb === "ended"
          ? "ended"
          : verb === "stalled"
            ? "stalled"
            : "cancelled"
  // Prefer the most human-relevant one-liner: Summary > Result > Error.
  // renderActorNotification always emits the Summary line before the Result
  // line, so restrict the Summary match to the region before the first
  // "Result:" line — otherwise a `Summary:`-prefixed line inside the Result
  // body would be mistaken for the notification's own summary.
  const resultIdx = text.search(/^Result:/m)
  const beforeResult = resultIdx === -1 ? text : text.slice(0, resultIdx)
  const line = (label: string, scope: string) => scope.match(new RegExp(`^${label}:\\s*(.+)$`, "m"))?.[1]?.trim()
  const summary = line("Summary", beforeResult) ?? line("Result", text) ?? line("Error", text)
  return summary ? { status, description, summary } : { status, description }
}
