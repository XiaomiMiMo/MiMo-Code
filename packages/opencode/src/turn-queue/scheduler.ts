import { Effect } from "effect"
import type { Lane } from "./schema"

/**
 * Lane kick hook registered by SessionPrompt after services exist.
 * Avoids a circular import: Controller.admit only knows this ref.
 * kick is fire-and-forget — scheduling owner is still LaneController receipts;
 * the kick only starts a Runner lease when the lane is idle.
 */
export type LaneScheduler = {
  readonly kick: (lane: Lane) => Effect.Effect<void>
}

export const schedulerRef: { current: LaneScheduler | undefined } = { current: undefined }
