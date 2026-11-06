import { Database, eq, inArray, and } from "@/storage"
import { SessionTable, MessageTable } from "@/session/session.sql"
import { ActorRegistryTable } from "@/actor/actor.sql"
import { TaskTable } from "@/task/task.sql"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import { ActionTable } from "./superagent.sql"
import * as Dispatcher from "./dispatcher"
import * as Runtime from "./runtime"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { Effect } from "effect"

export async function snapshot(directory: string) {
  const tickets = Dispatcher.list(directory)
  const routerSessionId = await Runtime.router(directory)
  const roots = [routerSessionId, ...tickets.flatMap((t) => (t.workerSessionId ? [t.workerSessionId] : []))]
  const sessions = Database.use((db) => db.select().from(SessionTable).all())
  const owners = new Map<string, string | undefined>(
    roots.map((id) => [id, tickets.find((t) => t.workerSessionId === id)?.id]),
  )
  for (let changed = true; changed; ) {
    changed = false
    for (const s of sessions)
      if (s.parent_id && owners.has(s.parent_id) && !owners.has(s.id)) {
        owners.set(s.id, owners.get(s.parent_id))
        changed = true
      }
  }
  const ids = [...owners.keys()].map((id) => SessionID.make(id))
  const actors = Database.use((db) =>
    db.select().from(ActorRegistryTable).where(inArray(ActorRegistryTable.session_id, ids)).all(),
  )
  const messages = Database.use((db) =>
    db.select().from(MessageTable).where(inArray(MessageTable.session_id, ids)).all(),
  )
  const agents = actors
    .filter(
      (a) =>
        a.mode !== "main" ||
        a.session_id === routerSessionId ||
        tickets.some((t) => t.workerSessionId === a.session_id && (t.workerActorId ?? "main") === a.actor_id),
    )
    .map((a) => {
      const own = messages.filter(
        (m) => m.session_id === a.session_id && m.agent_id === a.actor_id && m.data.role === "assistant",
      )
      let input = 0,
        output = 0,
        cache = 0,
        cost = 0
      for (const m of own) {
        const info = MessageV2.Info.parse({ ...m.data, id: m.id, sessionID: m.session_id })
        if (info.role === "assistant") {
          input += info.tokens.input
          output += info.tokens.output
          cache += info.tokens.cache.read
          cost += info.cost
        }
      }
      return {
        sessionId: a.session_id,
        actorId: a.actor_id,
        ticketId: owners.get(a.session_id),
        name: a.description,
        role:
          a.session_id === routerSessionId
            ? "router"
            : tickets.some((t) => t.workerSessionId === a.session_id && (t.workerActorId ?? "main") === a.actor_id)
              ? "worker"
              : "helper",
        status: a.status,
        error: a.last_error,
        inputTokens: input,
        outputTokens: output,
        cacheTokens: cache,
        cost,
        messages: own.length,
      }
    })
  const todos = ids.length
    ? Database.use((db) => db.select().from(TaskTable).where(inArray(TaskTable.session_id, ids)).all())
    : []
  const live = new Set(tickets.filter((t) => t.version === 2 && t.phase === "working").map((t) => t.id))
  const requestDirs = [
    ...new Set(
      sessions
        .filter(
          (s) =>
            (s.id === routerSessionId || live.has(owners.get(s.id) ?? "")) &&
            actors.some((a) => a.session_id === s.id && a.status !== "idle"),
        )
        .map((s) => s.directory),
    ),
  ]
  const requests = (
    await Promise.all(
      requestDirs.map((dir) =>
        Runtime.at(
          dir,
          Effect.gen(function* () {
            const permissions = yield* Permission.Service.use((s) => s.list())
            const questions = yield* Question.Service.use((s) => s.list())
            return [
              ...permissions.map((p) => ({
                id: p.id,
                sessionId: p.sessionID,
                messageId: p.tool?.messageID,
                text: `Permission: ${p.permission} · ${p.patterns.join(", ")}`,
              })),
              ...questions.map((q) => ({
                id: q.id,
                sessionId: q.sessionID,
                messageId: q.tool?.messageID,
                text: q.questions.map((q) => q.question).join("\n"),
              })),
            ]
          }),
        ),
      ),
    )
  )
    .flat()
    .filter((r) => owners.has(r.sessionId))
    .map((r) => ({
      ...r,
      ticketId: owners.get(r.sessionId),
      actorId: messages.find((m) => m.id === r.messageId)?.agent_id ?? "main",
    }))
  const deliveries = Database.use((db) =>
    db
      .select()
      .from(ActionTable)
      .where(and(eq(ActionTable.directory, directory), eq(ActionTable.state, "failed")))
      .all(),
  )
    .filter((a) => a.payload.version === 2)
    .map((a) => ({ id: a.id, ticketId: a.ticket_id, kind: a.kind, error: a.error }))
  return { tickets, routerSessionId, agents, todos, requests, deliveries, service: { pid: process.pid, directory } }
}
