import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"
import { SessionTable } from "@/session/session.sql"
import type { SessionID, MessageID } from "@/session/schema"

/** Session-wide cancel epoch — abort increments; old-epoch receipts are never claimed. */
export const TurnSessionEpochTable = sqliteTable("turn_session_epoch", {
  session_id: text()
    .$type<SessionID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  epoch: integer().notNull().default(0),
  time_updated: integer().notNull(),
})

/** Per-lane consumption frontier + steer revision. */
export const TurnLaneStateTable = sqliteTable(
  "turn_lane_state",
  {
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    agent_id: text().notNull().default("main"),
    consumed_frontier: text().$type<MessageID>(),
    input_revision: integer().notNull().default(0),
    time_updated: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.session_id, t.agent_id] })],
)

export const TurnReceiptTable = sqliteTable(
  "turn_receipt",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    agent_id: text().notNull().default("main"),
    state: text().$type<"accepted" | "claimed" | "settled" | "cancelled" | "rejected">().notNull(),
    intent: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    epoch: integer().notNull(),
    run_id: integer(),
    claim_frontier: text().$type<MessageID>(),
    consumed: integer({ mode: "boolean" }).notNull().default(false),
    suspended: integer({ mode: "boolean" }).notNull().default(false),
    outcome: text().$type<"success" | "assistant_error" | "interrupted" | "never_ran">(),
    message_id: text().$type<MessageID>(),
    error: text(),
    idempotency_key: text().notNull().default(""),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (t) => [
    index("turn_receipt_lane_state_idx").on(t.session_id, t.agent_id, t.state),
    // Partial unique (non-empty keys only) lives in migration SQL — empty
    // string means "no idempotency key" and must not collide.
  ],
)

export type TurnReceiptRow = typeof TurnReceiptTable.$inferSelect
