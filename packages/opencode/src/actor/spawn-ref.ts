// Late-bound reference to the Actor service implementation.
//
// SessionCheckpoint.tryStartCheckpointWriter needs to spawn the checkpoint-writer
// subagent. Wiring `Actor.Service` as a normal Layer dependency here would
// create a layer cycle (Actor → SessionPrompt → SessionCheckpoint → Actor)
// that Effect cannot resolve. Instead, `Actor.layer` populates this module-
// local reference on initialisation, and SessionCheckpoint reads from it at
// call time. The cycle is broken at the type level because SessionCheckpoint
// no longer declares an `Actor.Service` requirement.
//
// Render-only paths (rebuild context, FileWatcher) never call tryStartCheckpointWriter,
// so a missing `current` is treated as a runtime guard rather than a hard
// invariant.
import type { Interface as ActorInterface } from "./spawn"

export const spawnRef: { current: ActorInterface | undefined } = { current: undefined }
