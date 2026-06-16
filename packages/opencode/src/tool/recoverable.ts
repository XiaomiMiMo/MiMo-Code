import { isRecord } from "@/util/record"

// Marks a tool failure as agent-recoverable: the model can fix it on the next
// turn (bad arguments, a malformed shell call, a nonexistent task/actor id).
// These are NOT genuine system faults, so the TUI renders them muted (struck
// through, no red error block) to avoid alarming the user, while the full
// actionable message still flows to the agent as the tool result.
//
// Throwing one from a tool: either `Effect.fail(new RecoverableError(...))` from
// within the tool's `execute`, or `Effect.die(new RecoverableError(...))` from a
// service downstream of the wrap's `Effect.orDie`. Both surface to the AI-SDK
// boundary as the same RecoverableError *instance* (orDie turns the failure into
// a defect; the rejected promise carries the original error), so `failToolCall`
// can detect it via `isRecoverableError`.
export class RecoverableError extends Error {
  readonly recoverable = true
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "RecoverableError"
  }
}

// True when `error` should be treated as agent-recoverable. Checks the class
// first, then falls back to a structural `recoverable === true` marker so the
// signal survives the orDie → defect → tool-error hop even if `instanceof` is
// defeated (e.g. cross-realm or after a serialization round-trip).
//
// Caveat: the structural check matches ANY object carrying `recoverable: true`,
// so a thrown plain object (e.g. from a guest workflow script) with that field
// would also be muted. That is acceptable for the defensive fallback; the class
// is the intended path.
export function isRecoverableError(error: unknown): boolean {
  if (error instanceof RecoverableError) return true
  return isRecord(error) && (error as { recoverable?: unknown }).recoverable === true
}
