import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import z from "zod"

export const WorkflowPhase = BusEvent.define(
  "workflow.phase",
  z.object({ sessionID: SessionID.zod, runID: z.string(), title: z.string() }),
)

export const WorkflowLog = BusEvent.define(
  "workflow.log",
  z.object({ sessionID: SessionID.zod, runID: z.string(), message: z.string() }),
)

export const WorkflowStarted = BusEvent.define(
  "workflow.started",
  z.object({ sessionID: SessionID.zod, runID: z.string(), name: z.string() }),
)

export const WorkflowFinished = BusEvent.define(
  "workflow.finished",
  z.object({
    sessionID: SessionID.zod,
    runID: z.string(),
    status: z.enum(["completed", "failed", "cancelled"]),
    error: z.string().optional(),
  }),
)

// agent() collapses every failure path to bare null (over-cap, spawn-reject,
// timeout, actor-error, no-deliverable). The script can detect failure but not
// WHY — operators end up grep-mining 25GB of bus chatter to triage. This event
// emits the reason without changing agent()'s null return contract: existing
// scripts work unchanged; new consumers (drivers, /workflows view, tests) can
// subscribe to count failures by reason. Backward-compatible / additive only.
export const WorkflowAgentFailed = BusEvent.define(
  "workflow.agent_failed",
  z.object({
    sessionID: SessionID.zod,
    runID: z.string(),
    /** The child actor's id; absent when no spawn happened (over-cap path). */
    actorID: z.string().optional(),
    /** AgentOpts.agentType (defaulted to "general" by the spawn code). */
    agentType: z.string(),
    /** AgentOpts.label, observability tag (e.g. "port:bun_sys/fd.rs"). */
    label: z.string().optional(),
    /** Phase title at failure time, either AgentOpts.phase or run.currentPhase. */
    phase: z.string().optional(),
    reason: z.enum(["over-cap", "spawn-reject", "timeout", "actor-error", "no-deliverable"]),
    /** For actor-error: the outcome.error message if available. */
    errorMessage: z.string().optional(),
  }),
)

// A child workflow run (started via the guest workflow() primitive) reached a
// non-success terminal for a RUNTIME reason (its agents failed, deadline, or it
// was cancelled). workflow() still resolves to null (never-throw, like agent()),
// so the orchestrator script continues; this event carries the child runID +
// status so operators can triage without grep-mining bus chatter. Structural
// faults (cycle/depth/unknown-name) do NOT emit this — they propagate loud and
// fail the parent run instead. Additive / backward-compatible, mirrors WorkflowAgentFailed.
export const WorkflowChildFailed = BusEvent.define(
  "workflow.child_failed",
  z.object({
    sessionID: SessionID.zod,
    runID: z.string(), // the PARENT (orchestrator) run
    childRunID: z.string(),
    name: z.string(), // the child workflow name, or "inline"
    status: z.enum(["failed", "cancelled"]),
    error: z.string().optional(),
  }),
)
