import type { Effect } from "effect"
import type { SessionID } from "./schema"

/**
 * Orphan tool sweep hook. Set by SessionPrompt.layer.
 *
 * `ownedMessageIds` (optional): only rewrite tools whose messageID is in this
 * set. Callers snapshot assistant message IDs while they still hold a boundary
 * (work ensuring, before finishRun releases the Runner). New turns create new
 * messages — they cannot appear in an earlier snapshot. This is ownership by
 * message identity, not wall clock or Runner Idle/Running (RL-ORPHAN-D01).
 *
 * Without `ownedMessageIds`, full main-slice sweep requires status==idle
 * (prompt entry).
 */
export type OrphanToolIdleSweep = (
  sessionID: SessionID,
  opts?: { before?: number; ownedMessageIds?: ReadonlySet<string> },
) => Effect.Effect<void>

export const orphanToolIdleSweepRef: { current: OrphanToolIdleSweep | undefined } = {
  current: undefined,
}

/** Snapshot of assistant message IDs for a session. Wired by SessionPrompt. */
export type AssistantMessageIdsSnapshot = (sessionID: SessionID) => Effect.Effect<ReadonlySet<string>>

export const assistantMessageIdsSnapshotRef: { current: AssistantMessageIdsSnapshot | undefined } = {
  current: undefined,
}
