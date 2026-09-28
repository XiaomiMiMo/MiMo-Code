import type { Interface } from "./controller"

/** Set by TurnQueue.layer init. Optional so focused tests can omit the layer. */
export const turnQueueRef: { current: Interface | undefined } = { current: undefined }
