import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Goal } from "../session/goal"

// scaffold PI-62: expose the session-level goal stop-condition to the agent so a
// coordination (hub) task can be armed with an Outcome Gate that the existing
// main-loop goalGate (session/prompt.ts) enforces in the main TUI session — the
// place plugin actor.preStop can never reach. Mirrors the /goal command setter,
// but callable by the agent itself (e.g. prime at coordination-task start).
const DESCRIPTION = `Set or clear a session-level stop-condition goal for the MAIN session.

When a goal is set, the main loop refuses to stop until an independent judge confirms the condition is met; otherwise it re-enters with the judge's reason. Use this to enforce an OUTCOME on a coordination task: arm the goal at task start, then satisfy it by personally verifying the result (scaffold_outcome_verified) or escalating with one concrete blocker (scaffold_escalate). A written document, sent brief, accepted report, status update, or commit do NOT satisfy an outcome goal.

- action "set" requires "condition" — the stop-condition text. Example: "Координационная задача закрыта: вызван scaffold_outcome_verified после личной проверки исхода ИЛИ scaffold_escalate с одним конкретным блокером. Документ/коммит/accepted не считаются."
- action "clear" removes the active goal (use when the task is genuinely done or out of scope).`

export const GoalTool = Tool.define(
  "goal",
  Effect.gen(function* () {
    const goal = yield* Goal.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        action: z.enum(["set", "clear"]),
        condition: z.string().optional().describe("Stop-condition text. Required when action=set."),
      }),
      execute: (params: { action: "set" | "clear"; condition?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.action === "clear") {
            yield* goal.clear(ctx.sessionID)
            return { title: "Goal cleared", output: "Session goal cleared.", metadata: { action: "clear" } }
          }
          const condition = params.condition?.trim()
          if (!condition)
            return {
              title: "Goal not set",
              output: "action=set requires a non-empty `condition`.",
              metadata: { action: "set", ok: false },
            }
          yield* goal.set(ctx.sessionID, condition)
          return {
            title: "Goal set",
            output: `Session goal armed. The loop will not stop until satisfied:\n${condition}`,
            metadata: { action: "set", ok: true, condition },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
