import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import type { SessionID, MessageID } from "../session/schema"
import { Timestamps } from "../storage/schema.sql"

export const ActorRegistryTable = sqliteTable(
  "actor_registry",
  {
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    actor_id: text().notNull(),
    mode: text().$type<"peer" | "subagent" | "main">().notNull(),
    parent_actor_id: text(),
    status: text().$type<"pending" | "running" | "idle">().notNull(),
    last_outcome: text().$type<"success" | "failure" | "cancelled">(),
    lifecycle: text().$type<"ephemeral" | "persistent">().notNull(),
    agent: text().notNull(),
    description: text().notNull(),
    context_mode: text().$type<"none" | "state" | "full">().notNull(),
    context_watermark: text().$type<MessageID>(),
    background: integer({ mode: "boolean" }).notNull(),
    tools: text({ mode: "json" }).$type<readonly string[] | "INHERIT">(),
    last_turn_time: integer().notNull(),
    turn_count: integer().notNull().default(0),
    last_error: text(),
    instance_id: text().notNull(),
    time_completed: integer(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.actor_id] }),
    index("actor_registry_session_agent_idx").on(table.session_id, table.agent),
    index("actor_registry_session_parent_idx").on(table.session_id, table.parent_actor_id),
    index("actor_registry_status_idx").on(table.status),
    index("actor_registry_status_last_turn_idx").on(table.status, table.last_turn_time),
  ],
)
