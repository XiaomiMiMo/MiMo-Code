import { Effect } from "effect"
import { SYSTEM_SPAWNED_AGENT_TYPES } from "@/agent/config"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import type { Interface as Inbox } from "@/inbox/inbox"
import { renderActorNotification } from "@/inbox/render"
import type { SessionID } from "@/session/schema"
import type { Service as SessionService } from "@/session/session"
import type { Interface as Registry } from "./registry"

export interface TerminalNotification {
  sessionID: SessionID
  actorID: string
  source: "spawn" | "continuation" | "pending"
  parentSessionID?: SessionID
  parentActorID?: string
  status: "completed" | "failed" | "cancelled"
  result?: string
  error?: string
  reportedStatus?: string
  reportedSummary?: string
  warnings?: string[]
}

export function makeTerminalNotifier(deps: {
  inbox: Inbox
  registry: Registry
  sessions: Pick<SessionService["Service"], "get">
}) {
  return (input: TerminalNotification) =>
    Effect.gen(function* () {
      const actor = yield* deps.registry.get(input.sessionID, input.actorID)
      if (!actor?.background) return
      if (input.source === "spawn" ? actor.agent === "checkpoint-writer" : SYSTEM_SPAWNED_AGENT_TYPES.has(actor.agent))
        return
      const parentSessionID =
        input.parentSessionID ??
        (actor.mode === "peer" ? (yield* deps.sessions.get(input.sessionID)).parentID : input.sessionID)
      if (!parentSessionID) return yield* Effect.fail(new Error("actor parent session missing"))
      yield* deps.inbox.send({
        receiverSessionID: parentSessionID,
        receiverActorID: input.parentActorID ?? actor.parentActorID ?? "main",
        senderSessionID: input.sessionID,
        senderActorID: input.actorID,
        type: "actor_notification",
        content: renderActorNotification({
          actorID: input.actorID,
          description: actor.description,
          status: input.status,
          ...(input.result !== undefined ? { result: input.result } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          ...(input.reportedStatus ? { reportedStatus: input.reportedStatus } : {}),
          ...(input.reportedSummary ? { reportedSummary: input.reportedSummary } : {}),
          ...(input.warnings?.length ? { warnings: input.warnings } : {}),
        }),
      })
      if (input.source === "continuation") return
      yield* Effect.promise(() =>
        Bus.publish(TuiEvent.ToastShow, {
          message: `Child "${actor.description}" ${input.status}`,
          variant: input.status === "completed" ? "success" : input.status === "cancelled" ? "info" : "error",
        }),
      ).pipe(Effect.ignore)
    }).pipe(
      Effect.ignoreCause({
        log: "Error",
        message: `actor terminal notification failed: ${input.sessionID}/${input.actorID}`,
      }),
    )
}
