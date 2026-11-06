import { randomUUID, createHash } from "node:crypto"
import { GlobalBus } from "@/bus/global"
import { Database, and, eq, desc, isNull } from "@/storage"
import { TicketTable, InputTable, ActionTable, EventTable } from "./superagent.sql"
import { SuperagentError, type Ticket, type Source, type ActionKind, type ActionPayload } from "./schema"
import type { Report } from "./schema"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { SessionTable } from "@/session/session.sql"

export const Updated = BusEvent.define("superagent.updated", z.object({ ticketId: z.string() }))
export const id = (kind: string) => `${kind}_${randomUUID()}`
export const terminal = (t: Ticket) => t.phase === "completed" || t.phase === "cancelled"
function read(raw: Ticket): Ticket {
  // Older records stay readable and inert until explicitly resumed; native history is retained.
  return {
    ...raw,
    version: raw.version ?? 1,
    criteria: raw.criteria ?? [],
    artifacts: raw.artifacts ?? [],
    source: raw.source ?? { channel: "local", eventId: raw.id, threadId: raw.id, senderId: "user" },
    subscriptions: raw.subscriptions ?? [],
    phase: raw.version === 2 ? raw.phase : terminal(raw) ? raw.phase : "waiting",
  }
}
export function list(directory?: string) {
  return Database.use((db) =>
    db
      .select()
      .from(TicketTable)
      .where(directory ? eq(TicketTable.directory, directory) : undefined)
      .orderBy(desc(TicketTable.time_updated))
      .all(),
  ).map((row) => read(row.data))
}
export function get(directory: string, ticketId: string) {
  const row = Database.use((db) =>
    db
      .select()
      .from(TicketTable)
      .where(and(eq(TicketTable.directory, directory), eq(TicketTable.id, ticketId)))
      .get(),
  )
  if (!row) throw new SuperagentError("Task not found in this workspace", 404)
  return read(row.data)
}
export function save(t: Ticket) {
  t.updatedAt = Date.now()
  Database.use((db) =>
    db
      .update(TicketTable)
      .set({ phase: t.phase, data: t, time_updated: t.updatedAt })
      .where(eq(TicketTable.id, t.id))
      .run(),
  )
  GlobalBus.emit("event", {
    directory: t.directory,
    payload: { type: Updated.type, properties: { ticketId: t.id } },
  })
  return t
}
export function event(t: Ticket, kind: string, summary: string) {
  Database.use((db) =>
    db
      .insert(EventTable)
      .values({ ticket_id: t.id, kind, summary, revision: t.revision, time_created: Date.now() })
      .run(),
  )
  save(t)
}
export function queue(directory: string, kind: ActionKind, key: string, payload: ActionPayload, ticketId?: string) {
  Database.use((db) =>
    db
      .insert(ActionTable)
      .values({
        id: id("action"),
        key,
        directory,
        ticket_id: ticketId,
        kind,
        payload: { ...payload, version: 2 },
        state: "pending",
        time_created: Date.now(),
      })
      .onConflictDoNothing()
      .run(),
  )
}
export function input(directory: string, inputId: string) {
  const row = Database.use((db) =>
    db
      .select()
      .from(InputTable)
      .where(and(eq(InputTable.directory, directory), eq(InputTable.id, inputId)))
      .get(),
  )
  if (!row) throw new SuperagentError("Message not found in this workspace", 404)
  return row
}
function accept(directory: string, source: Source, text: string, ticketId?: string) {
  const fingerprint = createHash("sha256").update(JSON.stringify({ text, source })).digest("hex")
  const previous = Database.use((db) =>
    db
      .select()
      .from(InputTable)
      .where(
        and(
          eq(InputTable.directory, directory),
          eq(InputTable.channel, source.channel),
          eq(InputTable.event_id, source.eventId),
        ),
      )
      .get(),
  )
  if (previous) {
    if (
      previous.fingerprint !== fingerprint &&
      (previous.text !== text || JSON.stringify(previous.source) !== JSON.stringify(source))
    )
      throw new SuperagentError("Event key was already used for different content")
    return { row: previous, duplicate: true }
  }
  const row = {
    id: id("input"),
    directory,
    ticket_id: ticketId ?? null,
    channel: source.channel,
    event_id: source.eventId,
    thread_id: source.threadId,
    source,
    text,
    kind: ticketId ? ("feedback" as const) : ("request" as const),
    fingerprint,
    time_created: Date.now(),
  }
  Database.use((db) => db.insert(InputTable).values(row).run())
  return { row, duplicate: false }
}
export function request(directory: string, source: Source, text: string) {
  return Database.transaction(() => {
    const accepted = accept(directory, source, text)
    if (!accepted.duplicate) queue(directory, "route", `route:${accepted.row.id}`, { inputId: accepted.row.id })
    return accepted.row
  })
}
export function create(directory: string, inputId: string, goal: string, criteria: string[] = []) {
  return Database.transaction(() => {
    const source = input(directory, inputId)
    if (source.ticket_id) return get(directory, source.ticket_id)
    const now = Date.now()
    const t: Ticket = {
      id: id("ticket"),
      version: 2,
      directory,
      goal,
      criteria,
      phase: "queued",
      revision: 0,
      summary: "",
      artifacts: [],
      source: source.source,
      subscriptions: [{ channel: source.channel, threadId: source.thread_id, kind: "origin", url: source.source.url }],
      createdAt: now,
      updatedAt: now,
    }
    Database.use((db) => {
      db.insert(TicketTable)
        .values({ id: t.id, directory, phase: t.phase, data: t, time_created: now, time_updated: now })
        .run()
      db.update(InputTable).set({ ticket_id: t.id }).where(eq(InputTable.id, inputId)).run()
    })
    queue(directory, "deliver", `input:${source.id}:${t.id}`, { inputId: source.id, revision: t.revision }, t.id)
    event(t, "created", goal)
    return t
  })
}
function delivered(inputId: string, ticketId: string) {
  return !!Database.use((db) =>
    db
      .select({ id: ActionTable.id })
      .from(ActionTable)
      .where(eq(ActionTable.key, `input:${inputId}:${ticketId}`))
      .get(),
  )
}
export function follow(directory: string, ticketId: string, source: Source, text: string) {
  return Database.transaction(() => {
    const t = get(directory, ticketId)
    if (t.phase === "cancelled") throw new SuperagentError("Task was stopped; explicitly resume it first")
    const accepted = accept(directory, source, text, t.id)
    if (delivered(accepted.row.id, t.id)) return t
    t.version = 2
    t.revision++
    t.phase = "queued"
    t.attention = undefined
    queue(
      directory,
      "deliver",
      `input:${accepted.row.id}:${t.id}`,
      { inputId: accepted.row.id, revision: t.revision },
      t.id,
    )
    event(t, "input", text)
    return t
  })
}
export function attach(directory: string, ticketId: string, inputId: string) {
  return Database.transaction(() => {
    const t = get(directory, ticketId),
      row = input(directory, inputId)
    if (t.handbacks?.includes(inputId)) throw new SuperagentError("This Worker already returned this message")
    if (delivered(row.id, t.id)) return t
    if (t.phase === "cancelled") throw new SuperagentError("Task was stopped; explicitly resume it first")
    if (!t.subscriptions.some((s) => s.channel === row.channel && s.threadId === row.thread_id))
      t.subscriptions.push({ channel: row.channel, threadId: row.thread_id, kind: "origin", url: row.source.url })
    Database.use((db) => db.update(InputTable).set({ ticket_id: t.id }).where(eq(InputTable.id, row.id)).run())
    t.version = 2
    t.revision++
    t.phase = "queued"
    t.attention = undefined
    queue(directory, "deliver", `input:${row.id}:${t.id}`, { inputId: row.id, revision: t.revision }, t.id)
    event(t, "attached", row.text)
    return t
  })
}
export function ingest(
  directory: string,
  source: Source,
  text: string,
  human: boolean,
  addressed: boolean,
  explicitTicket?: string,
) {
  const owners = list(directory).filter(
    (t) =>
      t.phase !== "cancelled" &&
      (explicitTicket === t.id ||
        t.subscriptions.some(
          (s) => s.channel === source.channel && s.threadId === source.threadId && s.kind !== "context",
        )),
  )
  if (owners.length) {
    if (!human) {
      for (const t of owners.filter((t) => !terminal(t) && !t.attention)) follow(directory, t.id, source, text)
    } else for (const t of owners) follow(directory, t.id, source, text)
    return
  }
  const clarifying =
    human &&
    Database.use((db) =>
      db
        .select({ id: InputTable.id })
        .from(InputTable)
        .where(
          and(
            eq(InputTable.directory, directory),
            eq(InputTable.channel, source.channel),
            eq(InputTable.thread_id, source.threadId),
            eq(InputTable.kind, "request"),
            isNull(InputTable.ticket_id),
          ),
        )
        .get(),
    )
  if (human && (addressed || clarifying)) return request(directory, source, text)
}
export function subscribe(directory: string, ticketId: string, thread: Ticket["subscriptions"][number]) {
  const t = get(directory, ticketId)
  const previous = t.subscriptions.find((s) => s.channel === thread.channel && s.threadId === thread.threadId)
  if (previous) Object.assign(previous, thread)
  else t.subscriptions.push(thread)
  event(t, "subscribed", thread.url ?? thread.threadId)
  return t
}
export function threadClosed(directory: string, channel: string, threadId: string, outcome: "merged" | "closed") {
  for (const t of list(directory).filter((t) =>
    t.subscriptions.some((s) => s.channel === channel && s.threadId === threadId),
  )) {
    for (const s of t.subscriptions) if (s.channel === channel && s.threadId === threadId) s.closed = outcome
    if (t.phase === "awaiting_review" && t.subscriptions.filter((s) => s.kind === "deliverable").every((s) => s.closed))
      t.phase = "completed"
    event(t, outcome, `${threadId}: ${outcome}`)
  }
}
export function handback(directory: string, ticketId: string, inputId: string, reason: string) {
  const t = get(directory, ticketId),
    row = input(directory, inputId)
  if (!delivered(inputId, t.id)) throw new SuperagentError("Message does not belong to this task")
  t.handbacks = [...(t.handbacks ?? []), inputId]
  Database.transaction(() => {
    if (row.ticket_id === t.id)
      Database.use((db) => db.update(InputTable).set({ ticket_id: null }).where(eq(InputTable.id, inputId)).run())
    queue(directory, "route", `handback:${inputId}:${t.id}`, {
      inputId,
      text: `Task ${t.id} returned unrelated input: ${reason}`,
    })
    event(t, "handback", reason)
  })
}
export function report(t: Ticket, revision: number, body: z.infer<typeof Report>) {
  if (terminal(t) || revision !== t.revision)
    throw new SuperagentError("This report is stale; consume the latest task input")
  if (body.replyTo && !delivered(body.replyTo, t.id))
    throw new SuperagentError("Reply target is outside this task", 403)
  t.summary = body.summary
  if (body.humanAction !== undefined || body.state === "ready" || body.state === "dropped")
    t.attention = body.humanAction ?? undefined
  if (body.artifacts) t.artifacts = [...new Set([...t.artifacts, ...body.artifacts])]
  t.phase = body.humanAction
    ? "blocked"
    : body.state === "ready"
      ? t.subscriptions.some((s) => s.kind === "deliverable" && !s.closed)
        ? "awaiting_review"
        : "completed"
      : body.state === "blocked" || body.state === "failed"
        ? "blocked"
        : body.state === "dropped"
          ? "completed"
          : body.state === "waiting"
            ? "waiting"
            : "working"
  Database.transaction(() => {
    event(t, `report.${body.state}`, body.summary)
    if (body.humanAction || ["ready", "blocked", "failed"].includes(body.state) || body.replyTo) {
      const source = body.replyTo ? input(t.directory, body.replyTo).source : t.source
      queue(
        t.directory,
        "reply",
        `report:${t.id}:${revision}:${body.state}:${body.replyTo ?? "origin"}:${body.summary}`,
        { text: body.humanAction ?? body.summary, source },
        t.id,
      )
    }
  })
  return t
}
export function action(
  directory: string,
  ticketId: string,
  action: "cancel" | "resume",
  eventId: string,
  text?: string,
) {
  const t = get(directory, ticketId)
  if (action === "cancel") {
    if (
      Database.use((db) =>
        db
          .select()
          .from(ActionTable)
          .where(eq(ActionTable.key, `stop:${t.id}:${eventId}`))
          .get(),
      )
    )
      return t
    Database.transaction(() => {
      t.revision++
      t.phase = "cancelled"
      t.attention = undefined
      queue(directory, "stop", `stop:${t.id}:${eventId}`, { revision: t.revision }, t.id)
      event(t, "cancelled", "Stopped by user")
    })
    return t
  }
  if (t.phase === "cancelled") {
    t.phase = "waiting"
    save(t)
  }
  return follow(
    directory,
    ticketId,
    { channel: "local", eventId, threadId: ticketId, senderId: "user" },
    text ?? "Continue the original task. Inspect existing work before repeating external actions.",
  )
}
export function reply(directory: string, inputId: string, text: string) {
  const row = input(directory, inputId)
  queue(directory, "reply", `reply:${inputId}:${text}`, { source: row.source, text }, row.ticket_id ?? undefined)
}
export function resolved(directory: string, inputId: string) {
  input(directory, inputId)
  Database.use((db) => db.update(InputTable).set({ kind: "status" }).where(eq(InputTable.id, inputId)).run())
}
export function pending(directory: string) {
  return Database.use((db) =>
    db
      .select()
      .from(ActionTable)
      .where(and(eq(ActionTable.state, "pending"), eq(ActionTable.directory, directory)))
      .orderBy(ActionTable.time_created)
      .all(),
  ).filter((a) => a.payload.version === 2)
}
export function claim(actionId: string) {
  return Database.use((db) =>
    db
      .update(ActionTable)
      .set({ state: "running", error: null })
      .where(and(eq(ActionTable.id, actionId), eq(ActionTable.state, "pending")))
      .returning()
      .get(),
  )
}
export function detail(directory: string, ticketId: string) {
  return {
    ticket: get(directory, ticketId),
    events: Database.use((db) =>
      db
        .select()
        .from(EventTable)
        .where(eq(EventTable.ticket_id, ticketId))
        .orderBy(desc(EventTable.id))
        .limit(80)
        .all(),
    ),
  }
}
export function recover(retryable: (directory: string, channel?: string) => boolean, directory: string) {
  const legacy = Database.use((db) =>
    db.select().from(ActionTable).where(eq(ActionTable.directory, directory)).all(),
  ).filter((a) => a.payload.version !== 2 && (a.state === "pending" || a.state === "running"))
  for (const a of legacy)
    Database.use((db) =>
      db
        .update(ActionTable)
        .set({ state: "failed", error: "Historical action retained; open the task and explicitly continue it" })
        .where(eq(ActionTable.id, a.id))
        .run(),
    )
  const interrupted = Database.use((db) =>
    db
      .select()
      .from(ActionTable)
      .where(and(eq(ActionTable.state, "running"), eq(ActionTable.directory, directory)))
      .all(),
  )
  for (const a of interrupted) {
    const safe = a.kind !== "reply" || retryable(a.directory, a.payload.source?.channel)
    Database.use((db) =>
      db
        .update(ActionTable)
        .set({
          state: safe ? "pending" : "failed",
          error: safe ? null : "Delivery outcome unknown; inspect the original thread before retrying",
        })
        .where(eq(ActionTable.id, a.id))
        .run(),
    )
  }
  for (const t of list(directory).filter((t) => t.version === 2 && t.phase === "working")) {
    const eventId = id("recovery")
    follow(
      t.directory,
      t.id,
      { channel: "local", eventId, threadId: t.id, senderId: "system" },
      "The service restarted. Continue this task in the original Session. Inspect existing files, commands, PRs and messages before repeating any external action.",
    )
  }
}

export function retry(directory: string, actionId: string) {
  const a = Database.use((db) =>
    db
      .select()
      .from(ActionTable)
      .where(and(eq(ActionTable.id, actionId), eq(ActionTable.directory, directory)))
      .get(),
  )
  if (a?.payload.version !== 2)
    throw new SuperagentError("Historical actions cannot be replayed; continue the task instead")
  return (
    Database.use((db) =>
      db
        .update(ActionTable)
        .set({ state: "pending", error: null })
        .where(and(eq(ActionTable.id, actionId), eq(ActionTable.directory, directory), eq(ActionTable.state, "failed")))
        .returning()
        .all(),
    ).length > 0
  )
}

export function ownsWorktree(directory: string, worktree: string) {
  return list(directory).some((t) => t.worktree === worktree)
}
export function sessionIds(t: Ticket) {
  const ids = new Set(t.workerSessionId ? [t.workerSessionId] : [])
  const sessions = Database.use((db) =>
    db.select({ id: SessionTable.id, parent: SessionTable.parent_id }).from(SessionTable).all(),
  )
  for (let changed = true; changed; ) {
    changed = false
    for (const s of sessions)
      if (s.parent && ids.has(s.parent) && !ids.has(s.id)) {
        ids.add(s.id)
        changed = true
      }
  }
  return [...ids]
}
