// Process-global snapshots let permission inheritance cross Instance boundaries.
// This ref only stores parent grants; on a miss, the Permission caller's
// interactive setting determines whether to ask or fail closed. The parent's
// Permission instance refreshes the snapshot on load and persisted approval.

type Rule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" }

// The parent's grant snapshot is kept as TWO ordered phases, never flattened.
// The child mirrors the parent's own two-phase evaluation: a `ruleset` deny must
// win outright, and only a non-denying ruleset lets an `approved` allow upgrade
// an ask. Flattening into one array would let `findLast` pick a trailing
// approved allow over a ruleset deny — inverting deny precedence.
type ParentGrantSnapshot = { ruleset: Rule[]; approved: Rule[] }

const parentGrants = new Map<string, ParentGrantSnapshot>()

export const forwardRef = {
  parentGrants,
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
}
