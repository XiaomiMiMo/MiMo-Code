// Late-bound reference to SessionPrompt's plan-approval continuation hook.
//
// plan_exit (tool/plan.ts) writes a synthetic build user message when the user
// approves the plan, then relies on the ORIGINAL runLoop being alive to pick it
// up. If the turn that asked the question died while the user was reading
// (long-idle transport drop, error, abort), nothing drives the session and the
// approval is stranded — the session silently stops responding.
//
// Wiring SessionPrompt.Service into the tool would form a layer cycle
// (SessionPrompt → ToolRegistry → plan_exit tool), so the same late-binding
// pattern as prefix-capture-ref.ts is used: SessionPrompt.layer (which already
// holds resumeBackground) populates this ref at initialisation; plan_exit reads
// it at answer time. A missing ref is a runtime guard (minimal test fixtures):
// the alive-runLoop path works without it, only stranded-approval recovery is
// unavailable.
import type { Effect } from "effect"
import type { SessionID, MessageID } from "./schema"

export interface PlanExitContinuation {
  /**
   * Start a fresh run from an existing trailing user message when the session
   * is idle. Resolves to true when a run was launched, false when not (busy —
   * the asking run is still alive and continues itself; or no resumable
   * tail). Never fails.
   */
  readonly continueFromUserMessage: (input: {
    sessionID: SessionID
    userMessageID: MessageID
  }) => Effect.Effect<boolean>
}

export const planExitContinuationRef: { current: PlanExitContinuation | undefined } = {
  current: undefined,
}
