import type { Effect } from "effect"
import type { SessionID } from "./schema"

/**
 * Invoked by SessionRunState work ensuring (main) and by the prompt-entry
 * sweep. Set by SessionPrompt.layer.
 *
 * Ownership model (RL-ORPHAN-D01):
 * - `completedOnly`: only rewrite tools on assistant messages that already
 *   have `time.completed`. Live-turn tools sit on an incomplete message and
 *   are out of scope — this is message-lifecycle ownership, not wall clock.
 *   Safe to call while Runner is still Running (work ensuring).
 * - Without `completedOnly`: full main-slice sweep. Caller MUST hold a
 *   status==idle gate (prompt entry). Never force-sweep after Runner Idle.
 */
export type OrphanToolIdleSweep = (
  sessionID: SessionID,
  opts?: { before?: number; completedOnly?: boolean },
) => Effect.Effect<void>

export const orphanToolIdleSweepRef: { current: OrphanToolIdleSweep | undefined } = {
  current: undefined,
}
