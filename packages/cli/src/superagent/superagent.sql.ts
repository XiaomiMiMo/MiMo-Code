import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Ticket, ActionKind, ActionPayload, StoredInput } from "./schema"

export const TicketTable = sqliteTable(
  "superagent_ticket",
  {
    id: text().primaryKey(),
    directory: text().notNull(),
    phase: text().notNull(),
    data: text({ mode: "json" }).$type<Ticket>().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (t) => [index("superagent_ticket_scope_idx").on(t.directory, t.phase)],
)
export const InputTable = sqliteTable(
  "superagent_input",
  {
    id: text().primaryKey(),
    directory: text().notNull(),
    ticket_id: text().references(() => TicketTable.id),
    channel: text().notNull(),
    event_id: text().notNull(),
    thread_id: text().notNull(),
    source: text({ mode: "json" }).$type<StoredInput["source"]>().notNull(),
    text: text().notNull(),
    kind: text().$type<StoredInput["kind"]>().notNull(),
    fingerprint: text().notNull(),
    time_created: integer().notNull(),
  },
  (t) => [
    uniqueIndex("superagent_input_dedup_idx").on(t.directory, t.channel, t.event_id),
    index("superagent_input_thread_idx").on(t.directory, t.channel, t.thread_id),
  ],
)
export const RunTable = sqliteTable(
  "superagent_run",
  {
    id: text().primaryKey(),
    ticket_id: text()
      .notNull()
      .references(() => TicketTable.id),
    state: text().notNull(),
    data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index("superagent_run_ticket_idx").on(t.ticket_id)],
)
export const ActionTable = sqliteTable(
  "superagent_action",
  {
    id: text().primaryKey(),
    key: text().notNull().unique(),
    directory: text().notNull(),
    ticket_id: text().references(() => TicketTable.id),
    kind: text().$type<ActionKind>().notNull(),
    payload: text({ mode: "json" }).$type<ActionPayload>().notNull(),
    state: text().$type<"pending" | "running" | "done" | "failed">().notNull(),
    error: text(),
    time_created: integer().notNull(),
  },
  (t) => [index("superagent_action_pending_idx").on(t.state, t.time_created)],
)
export const EventTable = sqliteTable(
  "superagent_event",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ticket_id: text()
      .notNull()
      .references(() => TicketTable.id),
    kind: text().notNull(),
    summary: text().notNull(),
    revision: integer().notNull(),
    candidate_id: text(),
    time_created: integer().notNull(),
  },
  (t) => [index("superagent_event_ticket_idx").on(t.ticket_id, t.id)],
)
export const StateTable = sqliteTable("superagent_state", {
  id: text().primaryKey(),
  router_session_id: text(),
  cursor: text(),
  enabled: integer({ mode: "boolean" }).notNull().default(false),
})
