// Late-bound reference to a pre-wired prefix-capture helper.
//
// tryStartCheckpointWriter (in SessionCheckpoint) needs to call
// buildLLMRequestPrefix, which requires LLM.Service and ToolRegistry.Service.
// But ToolRegistry depends on SessionCheckpoint, so these cannot be added as
// normal Layer deps without creating a cycle:
//
//   ToolRegistry → SessionCheckpoint → ToolRegistry
//
// The same late-binding pattern used by spawn-ref.ts is applied here.
// SessionPrompt.layer (which already holds all needed services) populates
// this ref on initialisation; tryStartCheckpointWriter reads it at call time.
//
// Missing ref at call time → tryStartCheckpointWriter logs a warning and
// proceeds without forkContext (same guard as a missing spawnRef).
import type { Effect } from "effect"
import type { SessionID } from "./schema"
import type { ModelMessage, Tool as AITool } from "ai"
import type { Permission } from "../permission"

export interface PrefixCaptureResult {
  readonly system: string[]
  readonly tools: Record<string, AITool>
  readonly inheritedMessages: ModelMessage[]
  readonly parentPermission: Permission.Ruleset
}

/**
 * Accepts providerID/modelID strings rather than a full Provider.Model so
 * SessionCheckpoint (which does not have Provider.Service) can call this.
 * The closure inside SessionPrompt.layer resolves the full model internally.
 *
 * The caller (checkpoint.ts) passes already-sliced msgs and wraps the result
 * into a ForkContext that adds watermarkMsgID as a boundary marker. The
 * watermark is NOT threaded through this closure.
 */
export type PrefixCaptureFn = (input: {
  sessionID: SessionID
  agentName: string
  providerID: string
  modelID: string
  // Typed as `unknown[]` to break the import cycle — caller passes
  // `MessageV2.WithParts[]` but importing that type here would
  // re-introduce the SessionCheckpoint↔ToolRegistry cycle.
  msgs: unknown[]
}) => Effect.Effect<PrefixCaptureResult, never>

export const prefixCaptureRef: { current: PrefixCaptureFn | undefined } = { current: undefined }
