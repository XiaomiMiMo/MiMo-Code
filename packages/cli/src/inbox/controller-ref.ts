import type { Interface } from "./controller"

/** Set by Inbox controller layer init. Optional so focused tests can omit the layer. */
export const inboxControllerRef: { current: Interface | undefined } = { current: undefined }

/**
 * Runs in this process that hold inbox claims, keyed by lane and run id. A run
 * outlives the Instance (and controller) that admitted it, so boot
 * reconciliation by a later controller must not settle these claims as crashed.
 */
export const liveClaimRuns = new Set<string>()

export const claimRunKey = (sessionID: string, agentID: string, runId: number) => `${sessionID}:${agentID}:${runId}`

let lastClaimRunId = 0
/** Run ids stay time-ordered but never repeat in this process, even for runs started in the same millisecond. */
export const nextClaimRunId = () => (lastClaimRunId = Math.max(Date.now(), lastClaimRunId + 1))
