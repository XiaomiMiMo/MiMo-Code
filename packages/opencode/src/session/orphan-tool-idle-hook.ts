import type { Effect } from "effect"
import type { SessionID } from "./schema"

/**
 * Invoked by SessionStatus.commit whenever a session transitions to idle.
 * Set by SessionPrompt.layer with the real sweepOrphanToolParts implementation.
 *
 * A module ref (not a service) because SessionStatus must not depend on
 * SessionPrompt, and the hook must be available from every idle path
 * (run-state natural end, processor halt, cancel) without layer-circular wiring.
 *
 * `force`: caller has decided the main runner is done. Skip the status==idle
 * self-gate so sweep can run WHILE status still reports busy — clients must
 * not observe queryable idle until orphan terminal states are persisted.
 * `before`: only rewrite parts whose time.start is at or before this epoch
 * (protects tools from a concurrent new turn).
 */
export type OrphanToolIdleSweep = (
  sessionID: SessionID,
  opts?: { before?: number; force?: boolean },
) => Effect.Effect<void>

export const orphanToolIdleSweepRef: { current: OrphanToolIdleSweep | undefined } = {
  current: undefined,
}
