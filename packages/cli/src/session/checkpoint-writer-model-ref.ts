// Late-bound reference to the checkpoint-writer model resolver.
//
// tryStartCheckpointWriter (in SessionCheckpoint) needs the model the user
// pinned on the checkpoint-writer agent (`agent.checkpoint-writer.model`).
// Reading that pin requires Agent.Service and Provider.Service, which
// SessionCheckpoint cannot declare as layer dependencies without adding a
// SessionCheckpoint → Agent/Provider edge to a graph that already reaches it
// from the other side (same constraint as spawn-ref.ts and
// prefix-capture-ref.ts). SessionPrompt.layer, which holds both services,
// populates this ref on initialisation; checkpoint.ts reads it at spawn time.
//
// A missing ref means nothing can resolve the pin (an embedder built the
// checkpoint layer on its own). The writer then inherits the session model,
// which is what it always did.

import type { Effect } from "effect"

/** One provider/model pair, as resolved for the writer to spawn on. */
export type CheckpointWriterModelRef = { providerID: string; modelID: string }

/**
 * Resolves `agent.checkpoint-writer.model` for a session. `providerID` is the
 * parent session's provider, which a bare tier name is resolved against.
 * `undefined` means the agent pins nothing and the caller keeps inheriting.
 */
export type CheckpointWriterModelResolver = (
  providerID?: string,
) => Effect.Effect<CheckpointWriterModelRef | undefined>

export const checkpointWriterModelRef: { current: CheckpointWriterModelResolver | undefined } = {
  current: undefined,
}
