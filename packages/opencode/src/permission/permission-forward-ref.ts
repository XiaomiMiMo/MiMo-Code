// Process-global forward/grant ref for orchestrator child-session permission
// approval routing. A plain module singleton (no Effect Layer), mirroring
// actor/spawn-ref.ts, so it crosses per-Instance boundaries: an orchestrator
// peer child may run in a different Instance (its own --isolate worktree) than
// the orchestrator, yet the delegation grants and pending-forward records must
// be shared process-wide.
//
// - grants:  parentSessionID -> Set of (childSessionID | "*"). A grant lets the
//            orchestrator pre-authorize a forwarded ask without a human. This
//            in-memory map is a fast cache; it is WRITE-THROUGH to the shared
//            SQLite `permission_grant` table (see permission.sql.ts) so a grant
//            survives restart AND is visible to isolated children that run in a
//            SEPARATE PROCESS (they don't share this module singleton, but they
//            open the same on-disk DB). grantAllowed consults the DB, not just
//            the cache, so a child spawned AFTER the grant still sees it.
// - pending: requestID -> which child/parent a forwarded, not-yet-resolved ask
//            belongs to, PLUS a resolver bound to the child's own Deferred (in
//            the child's Instance) so `session approve` can resolve it from the
//            orchestrator's Instance and the orchestrator can drop its copy.
// - parentGrants: parentSessionID -> the parent session's current approved
//            ruleset snapshot. Lets an ordinary background subagent (in a
//            different Instance/directory than its parent) reuse the exact
//            directories/permissions the parent already holds a grant for,
//            WITHOUT a human round-trip and WITHOUT blocking. An ungranted path
//            simply isn't in the snapshot → the child fails closed. Snapshot is
//            refreshed by the parent's Permission instance on load and on every
//            persisted approval.

import { Database, eq } from "../storage"
import { PermissionGrantTable } from "./permission.sql"
import { Log } from "../util"

const log = Log.create({ service: "permission-forward-ref" })

type Decision = "allow" | "deny"
type PendingRec = {
  childSessionID: string
  parentSessionID: string
  resolve: (decision: Decision) => void
}

type Rule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" }

// The parent's grant snapshot is kept as TWO ordered phases, never flattened.
// The child mirrors the parent's own two-phase evaluation: a `ruleset` deny must
// win outright, and only a non-denying ruleset lets an `approved` allow upgrade
// an ask. Flattening into one array would let `findLast` pick a trailing
// approved allow over a ruleset deny — inverting deny precedence.
type ParentGrantSnapshot = { ruleset: Rule[]; approved: Rule[] }

const grants = new Map<string, Set<string>>()
const pending = new Map<string, PendingRec>()
const parentGrants = new Map<string, ParentGrantSnapshot>()

export const forwardRef = {
  grants,
  pending,
  parentGrants,
  setGrant(parentSessionID: string, target: string) {
    const set = grants.get(parentSessionID) ?? new Set<string>()
    set.add(target)
    grants.set(parentSessionID, set)
    // Write-through to shared SQLite so separate-process children created later
    // (and restarts) see this grant. Best-effort: a DB hiccup must not break the
    // in-memory grant for same-process children.
    try {
      Database.use((db) =>
        db
          .insert(PermissionGrantTable)
          .values({ parent_session_id: parentSessionID as any, target, created_at: Date.now() })
          .onConflictDoNothing()
          .run(),
      )
    } catch (err) {
      log.warn("setGrant persist failed", { parentSessionID, target, err })
    }
  },
  grantAllowed(parentSessionID: string, childSessionID: string): boolean {
    // In-memory fast path (same-process parent that just granted).
    const set = grants.get(parentSessionID)
    if (set && (set.has(childSessionID) || set.has("*"))) return true
    // Cross-process / post-restart path: consult the shared DB. A child in its
    // own Instance/process has no in-memory grant but must honor a parent grant
    // that was persisted, including "*" matching a child created after the grant.
    try {
      return Database.use((db) => {
        const rows = db
          .select({ target: PermissionGrantTable.target })
          .from(PermissionGrantTable)
          .where(eq(PermissionGrantTable.parent_session_id, parentSessionID as any))
          .all()
        return rows.some((r) => r.target === childSessionID || r.target === "*")
      })
    } catch (err) {
      log.warn("grantAllowed lookup failed", { parentSessionID, childSessionID, err })
      return false
    }
  },
  clearGrantsForParent(parentSessionID: string) {
    grants.delete(parentSessionID)
    try {
      Database.use((db) =>
        db.delete(PermissionGrantTable).where(eq(PermissionGrantTable.parent_session_id, parentSessionID as any)).run(),
      )
    } catch (err) {
      log.warn("clearGrantsForParent persist failed", { parentSessionID, err })
    }
  },
  clearGrantsForChild(childSessionID: string) {
    for (const set of grants.values()) set.delete(childSessionID)
    for (const [id, rec] of pending) if (rec.childSessionID === childSessionID) pending.delete(id)
    // Remove any persisted specific-child grant (never touches "*" wildcards,
    // which belong to the parent and outlive an individual child).
    try {
      Database.use((db) =>
        db.delete(PermissionGrantTable).where(eq(PermissionGrantTable.target, childSessionID)).run(),
      )
    } catch (err) {
      log.warn("clearGrantsForChild persist failed", { childSessionID, err })
    }
  },
  // Publish/refresh the parent session's grant snapshot so background children
  // in another Instance can consult it. Stored as two ordered phases (ruleset,
  // approved) — NEVER flattened — so the child can mirror the parent's two-phase
  // evaluation (ruleset deny wins outright; only then may an approved allow
  // upgrade). Each phase is shallow-copied so later mutation of the parent's live
  // arrays can't retroactively widen a child grant.
  setParentGrants(parentSessionID: string, snapshot: ParentGrantSnapshot) {
    parentGrants.set(parentSessionID, { ruleset: [...snapshot.ruleset], approved: [...snapshot.approved] })
  },
  getParentGrants(parentSessionID: string): ParentGrantSnapshot | undefined {
    return parentGrants.get(parentSessionID)
  },
  clearParentGrants(parentSessionID: string) {
    parentGrants.delete(parentSessionID)
  },
  addPending(requestID: string, rec: PendingRec) {
    pending.set(requestID, rec)
  },
  removePending(requestID: string) {
    pending.delete(requestID)
  },
  findPendingByChild(childSessionID: string): { requestID: string; rec: PendingRec } | undefined {
    for (const [requestID, rec] of pending) {
      if (rec.childSessionID === childSessionID) return { requestID, rec }
    }
    return undefined
  },
  // Resolve the child's current pending forwarded ask (allow/deny) via the bound
  // resolver, then drop the record. Returns true if there was one to resolve.
  // Idempotent: a second call (or after a direct user reply cleared it) no-ops.
  resolve(childSessionID: string, decision: Decision): boolean {
    const found = this.findPendingByChild(childSessionID)
    if (!found) return false
    found.rec.resolve(decision)
    pending.delete(found.requestID)
    return true
  },
}
