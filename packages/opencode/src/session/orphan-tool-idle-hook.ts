import type { Effect } from "effect"
import type { SessionID } from "./schema"

/**
 * Invoked by SessionStatus.commit whenever a session transitions to idle.
 * Set by SessionPrompt.layer with the real sweepOrphanToolParts implementation.
 *
 * A module ref (not a service) because SessionStatus must not depend on
 * SessionPrompt, and the hook must be available from every idle path
 * (run-state natural end, processor halt, cancel) without layer-circular wiring.
 */
export type OrphanToolIdleSweep = (
  sessionID: SessionID,
  opts?: { before?: number },
) => Effect.Effect<void>

export const orphanToolIdleSweepRef: { current: OrphanToolIdleSweep | undefined } = {
  current: undefined,
}
