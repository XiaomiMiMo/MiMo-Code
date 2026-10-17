import type { Interface } from "./controller"

/** Set by Inbox controller layer init. Optional so focused tests can omit the layer. */
export const inboxControllerRef: { current: Interface | undefined } = { current: undefined }
