export function isActorToolRunning(input: {
  partStatus: string
  action?: string
  actorStatus?: string
}) {
  if (input.partStatus === "running") return true
  if (input.partStatus !== "completed") return false
  if (input.action !== "spawn") return false
  return input.actorStatus === "running" || input.actorStatus === "pending"
}

/**
 * InlineTool's generic `~ {pending}` fallback. `send` / `wait` / `status` /
 * `cancel` / `models` are not delegations — label them by action so a finished
 * call never sits on "Delegating...".
 */
export function actorToolPendingLabel(action?: string): string {
  switch (action) {
    case "send":
      return "Sending message..."
    case "wait":
      return "Waiting..."
    case "status":
      return "Checking status..."
    case "cancel":
      return "Cancelling..."
    case "models":
      return "Listing models..."
    default:
      return "Delegating..."
  }
}

/**
 * Truthy once InlineTool should leave the pending fallback. `spawn`/`run`
 * identify themselves by `description`; the other actions have no description
 * field and must key off their target (or a resolved tool title) instead —
 * otherwise a completed `actor send` sticks on the pending label forever.
 */
export function actorToolCompleteKey(input: {
  action?: string
  description?: string
  actorDescription?: string
  toActorId?: string
  actorId?: string
  title?: string
}): string | true | undefined {
  if (input.description) return input.description
  if (input.actorDescription) return input.actorDescription
  switch (input.action) {
    case "send":
      return input.toActorId ?? input.title ?? true
    case "wait":
    case "status":
    case "cancel":
      return input.actorId ?? input.title ?? true
    case "models":
      return input.title ?? true
    case "spawn":
    case "run":
      return input.title
    default:
      return input.title
  }
}

/**
 * A finished actor call is not automatically a success. `send` can complete with
 * title "Send failed: receiver not found", wait/run land on
 * "… timeout|interrupted|unknown", and any action can hit `partStatus ===
 * "error"`. Past-tense success labels must not cover those.
 */
export function actorToolOutcomeFailed(input: { partStatus: string; title?: string }): boolean {
  if (input.partStatus === "error") return true
  const title = input.title ?? ""
  if (!title) return false
  // Success titles are explicit — never let a target name like "failed-agent"
  // flip a completed send into a failure.
  if (/^Sent to\b/i.test(title) || /^Sent message to\b/i.test(title)) return false
  if (/^Send failed\b/i.test(title) || /^Send message failed\b/i.test(title)) return true
  if (/^Actor \w+: unknown\b/i.test(title)) return true
  if (/^Actor (?:wait|run): (?:timeout|interrupted)\b/i.test(title)) return true
  // lastOutcome=/failed and any remaining explicit failure wording
  return /(?:^|[:/\s])fail(?:ed|ure)?\b/i.test(title)
}

/**
 * One-line body for the actor tool once it leaves the pending fallback.
 * Multi-line live-progress (toolcounts) is layered on by the TUI caller.
 *
 * Keep every action on the same `Label — actor desc` shape as wait:
 * `Waiting for — …` / `Waited for — …` → send is
 * `Sending message to — …` / `Sent message to — …`.
 */
/**
 * The agent label for the task part header.
 *
 * `subagent_type` is model-emitted tool input, persisted verbatim in
 * `ToolState.input`, so a malformed non-string — for example the array
 * `["general","general"]` against a `z.enum` of `"explore" | "general"` —
 * reaches the renderer on every replay of the session. `??` only falls through
 * on nullish, so such a value has to be rejected by type before
 * `Locale.titlecase` calls `.replace` on it, which is a crash rather than a
 * mislabel.
 */
export function actorToolLabel(subagentType: unknown, actorAgent: unknown): string {
  if (typeof subagentType === "string") return subagentType
  if (typeof actorAgent === "string") return actorAgent
  return "General"
}

export function actorToolBody(input: {
  action?: string
  partStatus: string
  title?: string
  description?: string
  actorDescription?: string
  subagentType?: unknown
  agent?: unknown
  toActorId?: string
  actorId?: string
}): string {
  const desc = input.description ?? input.actorDescription
  const agent = actorToolLabel(input.subagentType, input.agent)
  const failed = actorToolOutcomeFailed(input)
  const target = desc ?? input.toActorId ?? input.actorId ?? ""
  const line = (label: string) => (target ? `${label} — ${target}` : label)

  if (input.action === "send") {
    return line(failed ? "Send message failed" : input.partStatus === "running" ? "Sending message to" : "Sent message to")
  }

  if (input.action === "cancel") {
    return line(failed ? "Cancel failed" : input.partStatus === "running" ? "Cancelling" : "Cancelled")
  }

  if (input.action === "wait") {
    return line(failed ? "Wait failed" : input.partStatus === "completed" ? "Waited for" : "Waiting for")
  }

  if (input.action === "status") {
    return line("Status")
  }

  if (input.action === "models") {
    return failed ? "List models failed" : "List models"
  }

  if (input.action === "spawn") {
    return desc ? `Background ${agent} Task — ${desc}` : `Background ${agent} Task`
  }

  // run (and any future action with a description)
  return desc ? `${agent} Task — ${desc}` : `${agent} Task`
}
