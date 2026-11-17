export * as CheckpointWriterModel from "./checkpoint-writer-model"

import { Effect } from "effect"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider"
import { ProviderID } from "@/provider/schema"
import type { CheckpointWriterModelRef } from "./checkpoint-writer-model-ref"

/**
 * The model a checkpoint writer should run on, or `undefined` when its agent
 * pins nothing.
 *
 * Background: the writer is spawned with an explicit model
 * (`SessionCheckpoint.tryStartCheckpointWriter`), and its callers used to hand
 * it the parent session's model unconditionally. `agent.checkpoint-writer.model`
 * therefore validated and then did nothing: every writer ran on whatever model
 * the parent session happened to use, which turned an Opus session into
 * Opus-priced checkpoints and made a provider-side request cap fail the writer
 * while the session itself kept working.
 *
 * Resolution order matches every other spawn path (`tool/actor.ts`): a
 * tier/group name (`modelRef`, provider-aware) first, then a literal
 * provider/model. Callers fall back to the session model when this yields
 * `undefined`, which keeps the previous inheritance behaviour for agents that
 * pin nothing.
 *
 * Takes the resolved services rather than requiring them so the returned
 * function has no requirements of its own — that is what lets
 * SessionPrompt.layer stash it behind a late-bound ref
 * (`checkpoint-writer-model-ref.ts`), the same way it stashes prefix capture.
 * `providerID` is the parent session's provider; a bare tier name is resolved
 * against it, exactly as a subagent spawned from that turn would be.
 */
export const resolve = (agents: Agent.Interface, provider: Provider.Interface) => (providerID?: string) =>
  Effect.gen(function* () {
    const writer = yield* agents.get("checkpoint-writer")
    if (!writer) return undefined as CheckpointWriterModelRef | undefined
    if (writer.modelRef) {
      const model = yield* provider.resolveModelRef(
        writer.modelRef,
        providerID ? ProviderID.make(providerID) : undefined,
      )
      return { providerID: model.providerID, modelID: model.id } satisfies CheckpointWriterModelRef
    }
    if (writer.model)
      return {
        providerID: writer.model.providerID,
        modelID: writer.model.modelID,
      } satisfies CheckpointWriterModelRef
    return undefined
  })
