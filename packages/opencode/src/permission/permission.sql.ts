import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"
import type { SessionID } from "../session/schema"

// Persisted orchestrator delegation grants. Backs the in-memory `grants` map in
// permission-forward-ref.ts so a `session grant-approval all` (or a specific
// child) by a parent orchestrator survives a restart AND is visible to isolated
// (separate-process) children created AFTER the grant.
//
// Keyed by (parent_session_id, target) where target is a child SessionID or the
// "*" wildcard. Scoped strictly to the parent session — never global/cross-session.
// No FK to `session`(id): the target may be "*" (not a session) or a child that
// does not yet have a row when the grant is set, and grants must outlive the
// parent row's own lifecycle for restart survival.
export const PermissionGrantTable = sqliteTable(
  "permission_grant",
  {
    parent_session_id: text().$type<SessionID>().notNull(),
    target: text().notNull(),
    created_at: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.parent_session_id, t.target] })],
)

export type PermissionGrantRow = typeof PermissionGrantTable.$inferSelect
