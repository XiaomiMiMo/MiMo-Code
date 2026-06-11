import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import type { SessionID } from "../session/schema"
import { Timestamps } from "../storage/schema.sql"

export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    status: text().$type<"running" | "completed" | "failed" | "cancelled">().notNull(),
    running: integer().notNull().default(0),
    succeeded: integer().notNull().default(0),
    failed: integer().notNull().default(0),
    current_phase: text(),
    parent_actor_id: text(),
    args: text({ mode: "json" }),
    script_sha: text(),
    agent_timeout_ms: integer(),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    index("workflow_run_session_idx").on(table.session_id),
    index("workflow_run_status_idx").on(table.status),
  ],
)
