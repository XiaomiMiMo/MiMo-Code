// Process-global forward/grant ref for orchestrator child-session permission
// approval routing. A plain module singleton (no Effect Layer), mirroring
// actor/spawn-ref.ts, so it crosses per-Instance boundaries: an orchestrator
// peer child may run in a different Instance (its own --isolate worktree) than
// the orchestrator, yet the delegation grants and pending-forward records must
// be shared process-wide.
//
// - grants:  parentSessionID -> Set of (childSessionID | "*"). A grant lets the
//            orchestrator pre-authorize a forwarded ask without a human.
// - pending: requestID -> which child/parent a forwarded, not-yet-resolved ask
//            belongs to, so a `session approve <child>` can find the requestID
//            and the orchestrator can drop its copy on resolution.

type PendingRec = { childSessionID: string; parentSessionID: string }

const grants = new Map<string, Set<string>>()
const pending = new Map<string, PendingRec>()

export const forwardRef = {
  grants,
  pending,
  setGrant(parentSessionID: string, target: string) {
    const set = grants.get(parentSessionID) ?? new Set<string>()
    set.add(target)
    grants.set(parentSessionID, set)
  },
  grantAllowed(parentSessionID: string, childSessionID: string): boolean {
    const set = grants.get(parentSessionID)
    if (!set) return false
    return set.has(childSessionID) || set.has("*")
  },
  clearGrantsForParent(parentSessionID: string) {
    grants.delete(parentSessionID)
  },
  clearGrantsForChild(childSessionID: string) {
    for (const set of grants.values()) set.delete(childSessionID)
    for (const [id, rec] of pending) if (rec.childSessionID === childSessionID) pending.delete(id)
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
}
