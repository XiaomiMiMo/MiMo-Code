import { sqliteTable, text, integer, index, primaryKey, foreignKey } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import type { SessionID } from "../session/schema"

export const TaskTable = sqliteTable(
  "task",
  {
    id: text().notNull(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_task_id: text(),
    status: text()
      .$type<
        "open" | "dispatched" | "in_progress" | "blocked" | "human_review" | "done" | "failed" | "abandoned"
      >()
      .notNull(),
    summary: text().notNull(),
    owner: text(),
    // Deliberately NOT a foreign key to SessionTable: a worker session may be
    // torn down (or its row cascade-deleted) while the task must survive as
    // durable history. Same soft-link treatment `owner` already gets.
    worker_session_id: text().$type<SessionID>(),
    dispatched_at: integer(),
    result_ref: text(),
    created_at: integer().notNull(),
    last_event_at: integer().notNull(),
    ended_at: integer(),
    cleanup_after: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.id] }),
    index("task_session_idx").on(table.session_id),
    index("task_parent_idx").on(table.session_id, table.parent_task_id),
    index("task_status_idx").on(table.status),
    index("task_worker_idx").on(table.worker_session_id, table.status),
  ],
)

export const TaskEventTable = sqliteTable(
  "task_event",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    task_id: text().notNull(),
    at: integer().notNull(),
    kind: text().notNull(),
    summary: text(),
  },
  (table) => [
    foreignKey({
      columns: [table.session_id, table.task_id],
      foreignColumns: [TaskTable.session_id, TaskTable.id],
    }).onDelete("cascade"),
    index("task_event_task_idx").on(table.session_id, table.task_id, table.at),
  ],
)
