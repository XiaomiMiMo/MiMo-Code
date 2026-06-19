import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export const AutomationTaskTable = sqliteTable(
  "automation_task",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    description: text(),
    schedule: text().notNull(),
    skill: text().notNull(),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    priority: text().$type<"low" | "medium" | "high">().notNull().default("medium"),
    timeout: integer(),
    retries: integer().notNull().default(0),
    ...Timestamps,
  },
)

export const AutomationResultTable = sqliteTable(
  "automation_result",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    task_id: text().notNull(),
    task_name: text().notNull(),
    skill: text().notNull(),
    status: text().$type<"success" | "failure" | "timeout" | "skipped">().notNull(),
    output: text(),
    error: text(),
    duration_ms: integer().notNull(),
    executed_at: integer().notNull(),
    ...Timestamps,
  },
)
