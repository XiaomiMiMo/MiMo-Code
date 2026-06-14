import { Effect } from "effect"
import { TaskRegistry } from "./registry"
import type { SessionID } from "@/session/schema"

/**
 * Cap on stop-gate ReAct re-entries when a subagent finishes with
 * non-terminal tasks on the board. Lower than the main-session cap because
 * subagents have shorter lifetimes; if 2 nudges don't close the work, the
 * actor returns "partial"/"blocked" and the main session picks it up.
 */
export const MAX_TASK_GATE_SUBAGENT_REACT = 2

/**
 * Cap on stop-gate ReAct re-entries on the main session loop. Higher than
 * the subagent cap because a main session is long-lived and the gate is the
 * last defense before stop. Lower than MAX_GOAL_REACT (12) because there is
 * no judge model — only DB state — so we can't disambiguate "model is still
 * working" from "model is stalling".
 */
export const MAX_TASK_GATE_MAIN_REACT = 3

export type GateMode = "subagent" | "main"

export type Decision =
  | { needReentry: false; capExceeded: false; incompleteTasks: [] }
  | { needReentry: true; reentryText: string; incompleteTasks: string[]; capExceeded: false }
  | { needReentry: false; capExceeded: true; incompleteTasks: string[] }

export interface DecideInput {
  session_id: SessionID
  /**
   * Subagent path: actorID — only that actor's tasks count.
   * Main path: undefined — every non-terminal task in the session counts
   * (catches subagent-orphaned tasks; see spec "Owner semantics").
   */
  owner?: string
  reactCount: number
  maxReact: number
  mode: GateMode
}

const buildReentryText = (
  incomplete: { id: string; status: string; summary: string }[],
  mode: GateMode,
): string => {
  // Headline shifts with mode because owner semantics differ:
  //   subagent: owner=actorID — every listed task IS owned by the recipient
  //     ("you own" is literally true).
  //   main:     owner=undefined — list spans all session tasks, including
  //     subagent-orphaned ones the recipient never created. Saying "you own"
  //     would mislead main into preferring `task abandon` over completing
  //     orphan work, defeating the safety-net purpose.
  const headline =
    mode === "subagent"
      ? "You are about to finish, but these tasks you own are still unfinished:"
      : "You are about to finish, but these tasks in this session are still unfinished:"
  const closingLine =
    mode === "subagent"
      ? "Then re-emit your final message starting with the **Status**/**Summary** header."
      : "Then continue or respond."
  return [
    "<system-reminder>",
    headline,
    ...incomplete.map((t) => `- ${t.id} (${t.status}): ${t.summary}`),
    "For EACH: complete the work then `task done <id> <summary>`, or `task abandon <id> <reason>` if it is genuinely not needed.",
    closingLine,
    "</system-reminder>",
  ].join("\n")
}

/**
 * Pure decision: list non-terminal tasks for (session, owner), return
 * one of three branches (empty / nudge-text / cap-exceeded). Caller owns
 * synthetic-message injection and cap-state management.
 *
 * orElseSucceed on registry failure: a transient DB error must NEVER trap
 * the agent in the gate — fail open by reporting empty so the caller stops
 * cleanly. Mirrors actor/spawn.ts:412 today.
 */
export const decide = Effect.fn("TaskGate.decide")(function* (input: DecideInput) {
  const reg = yield* TaskRegistry.Service
  const tasks = yield* reg
    .list({
      session_id: input.session_id,
      owner: input.owner,
      include_terminal: false,
    })
    .pipe(Effect.orElseSucceed(() => []))

  // include_terminal:false keeps `blocked` (it's non-terminal). Drop it here:
  // a blocked task is one the actor genuinely can't proceed on, so nudging
  // "complete or abandon" would loop unanswerable. Mirrors the original
  // actor/spawn.ts gate filter that this helper preserves.
  const actionable = tasks.filter((t) => t.status === "open" || t.status === "in_progress")

  if (actionable.length === 0) {
    return { needReentry: false, capExceeded: false, incompleteTasks: [] } satisfies Decision
  }

  if (input.reactCount >= input.maxReact) {
    return {
      needReentry: false,
      capExceeded: true,
      incompleteTasks: actionable.map((t) => t.id),
    } satisfies Decision
  }

  return {
    needReentry: true,
    capExceeded: false,
    reentryText: buildReentryText(actionable, input.mode),
    incompleteTasks: actionable.map((t) => t.id),
  } satisfies Decision
})

export * as TaskGate from "./gate"
