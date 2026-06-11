// Late-bound reference to the WorkflowRuntime service implementation.
//
// The `workflow` tool needs to call WorkflowRuntime (start/status/wait/cancel).
// Wiring `WorkflowRuntime.Service` as a normal Layer dependency on the tool would
// force it into `ToolRegistry.layer`'s requirement set, which every layer that
// builds the registry (the app runtime plus ~9 test harnesses) would then have
// to satisfy — the same blast radius that motivated `spawnRef` for the Actor
// service. Instead, `WorkflowRuntime.layer` populates this module-local
// reference on initialisation, and the tool reads from it at call time. The
// requirement is broken at the type level because the tool no longer declares a
// `WorkflowRuntime.Service` dependency.
//
// Paths that never run the workflow tool (most of the codebase) simply leave
// `current` undefined; the tool treats a missing `current` as a runtime guard
// rather than a hard invariant.
import type { Interface as WorkflowRuntimeInterface } from "./runtime"

export const workflowRef: { current: WorkflowRuntimeInterface | undefined } = { current: undefined }
