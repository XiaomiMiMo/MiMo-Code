import { Effect } from "effect"
import { ActorRegistry } from "../actor/registry"
import type { SessionID } from "./schema"
import type { PromptContext } from "./prompt-context"

/** Materialize message-owned instructions without modifying the stable snapshot. */
export const appendTurnInstructions = Effect.fn("Session.appendTurnInstructions")(function* (
  system: string[],
  sessionID: SessionID,
  user: { agentID?: string; promptContext?: PromptContext },
) {
  const instructions = user.promptContext?.instructions
  if (!instructions) return system
  const eligible = yield* ActorRegistry.Service.use((registry) => registry.servesCheckpoint(sessionID, user.agentID)).pipe(
    Effect.provide(ActorRegistry.defaultLayer),
  )
  return eligible ? [...system, instructions] : system
})
