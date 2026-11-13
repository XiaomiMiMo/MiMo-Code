import { Database, and, eq, lte, desc } from "@/storage"
import { MessageV2 } from "@/session/message-v2"
import { MessageTable } from "@/session/session.sql"
import { InboxTable } from "@/inbox/inbox.sql"
import type { Context } from "@/tool/tool"
import * as Dispatcher from "./dispatcher"
import { SuperagentError } from "./schema"

export function binding(ctx: Pick<Context, "sessionID" | "actorID" | "messageID">) {
  const message = Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.id, ctx.messageID)).get())
  if (
    !message ||
    message.session_id !== ctx.sessionID ||
    message.agent_id !== (ctx.actorID ?? "main") ||
    message.data.role !== "assistant"
  )
    throw new SuperagentError("This request does not own the task Session", 403)
  const info = MessageV2.Info.parse({ ...message.data, id: message.id, sessionID: message.session_id })
  if (info.role !== "assistant") throw new SuperagentError("Expected a Worker response", 403)
  const parentID = info.parentID
  const rows = Database.use((db) =>
    db
      .select()
      .from(InboxTable)
      .where(
        and(
          eq(InboxTable.receiver_session_id, ctx.sessionID),
          eq(InboxTable.receiver_actor_id, ctx.actorID ?? "main"),
          eq(InboxTable.consumed, true),
          lte(InboxTable.input_message_id, parentID),
          lte(InboxTable.delivery_message_id, ctx.messageID),
        ),
      )
      .orderBy(desc(InboxTable.input_message_id))
      .all(),
  )
  const match = rows.map((row) => row.idempotency_key.match(/^superagent:(ticket_[^:]+):(\d+):/)).find(Boolean)
  const t =
    match &&
    Dispatcher.list().find(
      (t) =>
        t.id === match[1] &&
        t.workerSessionId === ctx.sessionID &&
        (t.workerActorId ?? "main") === (ctx.actorID ?? "main"),
    )
  if (!t || !match) throw new SuperagentError("No task input is bound to this request", 403)
  return { t, revision: Number(match[2]) }
}
