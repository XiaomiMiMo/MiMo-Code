import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import type { SessionID, MessageID } from "../session/schema"

// 所有来源的输入均引用受理时写入的 user 消息；content 仅供旧格式启动转换。
export const InboxTable = sqliteTable(
  "inbox",
  {
    id: text().primaryKey(),
    receiver_session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    receiver_actor_id: text().notNull().default("main"),
    sender_session_id: text().$type<SessionID>(),
    sender_actor_id: text(),
    type: text().notNull().default("text"),
    /** Legacy-format rows only; new accepts never store the body here. */
    content: text({ mode: "json" }).$type<{ text?: string } | null>(),
    input_message_id: text().$type<MessageID>(),
    state: text()
      .$type<"accepted" | "claimed" | "settled" | "cancelled" | "rejected">()
      .notNull()
      .default("accepted"),
    epoch: integer().notNull().default(0),
    run_id: integer(),
    claim_frontier: text().$type<MessageID>(),
    consumed: integer({ mode: "boolean" }).notNull().default(false),
    outcome: text().$type<"success" | "assistant_error" | "interrupted" | "never_ran">(),
    delivery_message_id: text().$type<MessageID>(),
    error: text(),
    idempotency_key: text().notNull().default(""),
    created_at: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (t) => [
    index("inbox_receiver_idx").on(t.receiver_session_id, t.receiver_actor_id, t.id),
    index("inbox_state_idx").on(t.receiver_session_id, t.receiver_actor_id, t.state),
    index("inbox_created_idx").on(t.created_at),
    // Partial unique (non-empty keys only) lives in migration SQL — empty
    // string means "no idempotency key" and must not collide.
  ],
)

/** Per-lane consumption frontier + input revision. */
export const InboxLaneStateTable = sqliteTable(
  "inbox_lane_state",
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

/** Session-wide cancel epoch — abort increments; old-epoch rows are never claimed. */
export const InboxSessionEpochTable = sqliteTable("inbox_session_epoch", {
  session_id: text()
    .$type<SessionID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  epoch: integer().notNull().default(0),
  time_updated: integer().notNull(),
})

export type InboxRow = typeof InboxTable.$inferSelect
export type InboxLaneStateRow = typeof InboxLaneStateTable.$inferSelect
export type InboxSessionEpochRow = typeof InboxSessionEpochTable.$inferSelect
