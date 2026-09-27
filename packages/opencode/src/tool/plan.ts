import z from "zod"
import path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider"
import { Instance } from "../project/instance"
import { planExitContinuationRef } from "../session/plan-exit-continuation-ref"
import { type SessionID, MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

function getLastModel(sessionID: SessionID) {
  for (const item of MessageV2.stream(sessionID, { agentID: "*" })) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return undefined
}

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: z.object({}),
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (ctx.agent !== "plan") {
            return {
              title: "Not in plan mode",
              output: "You are not in plan mode. This tool is only effective in plan mode.",
              metadata: { switched: false, feedback: "" },
            }
          }

          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(Instance.worktree, Session.plan(info))
          const answers = yield* question
            .ask({
              sessionID: ctx.sessionID,
              questions: [
                {
                  key: "plan_exit",
                  params: { plan },
                  question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                  header: "Plan",
                  options: [
                    { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                    { label: "No", description: "Stay with plan agent to continue refining the plan" },
                  ],
                },
              ],
              tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            })
            .pipe(
              // Dismissing the approval prompt (esc) must not kill the turn:
              // RejectedError would set ctx.blocked in the processor and abort
              // the whole LLM conversation. Surface the dismissal as a regular
              // "stay in plan mode" result so the agent loop auto-continues.
              Effect.catchIf(
                (error) => error instanceof Question.RejectedError,
                () => Effect.succeed(undefined),
              ),
            )

          if (!answers) {
            return {
              title: "Staying in plan mode",
              output:
                "User dismissed the plan approval question without answering. Plan mode is still active — do NOT start implementing. Do not call plan_exit again right away; use the question tool to ask the user whether they want to refine anything in the plan or proceed, and call plan_exit again only after they explicitly confirm they are ready.",
              metadata: { switched: false, feedback: "" },
            }
          }

          const answer = answers[0]?.[0]
          if (answer === "No") {
            return {
              title: "Staying in plan mode",
              output:
                "User chose to stay in plan mode and continue refining the plan. Plan mode is still active — do NOT start implementing. Use the question tool to ask the user which aspects of the plan they want to refine or change, then update the plan file accordingly and call plan_exit again when ready.",
              metadata: { switched: false, feedback: "" },
            }
          }

          if (answer !== "Yes") {
            return {
              title: "User provided feedback",
              output: `User chose not to switch yet and provided feedback: ${answer}\n\nPlan mode is still active — do NOT start implementing. Address the feedback by refining the plan file, then call plan_exit again when the plan is ready.`,
              metadata: { switched: false, feedback: answer },
            }
          }

          const model = getLastModel(ctx.sessionID) ?? (yield* provider.defaultModel())

          const msg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
            synthetic: true,
          } satisfies MessageV2.TextPart)

          // The approval must keep the session working even when the turn that
          // asked died while the user was reading (long-idle transport drop,
          // error, abort): resume a fresh run from the synthetic build message.
          // While the asking run is still alive this is a no-op (resume rejects
          // busy and the live runLoop continues on its own).
          const continuation = planExitContinuationRef.current
          const launched = continuation
            ? yield* continuation.continueFromUserMessage({ sessionID: ctx.sessionID, userMessageID: msg.id })
            : false

          if (launched && ctx.callID) {
            // The asking run is dead: its cleanup already stamped this tool
            // part aborted, so the processor's completion (which only rewrites
            // `running` parts) will no-op. Rewrite it completed with the
            // switched metadata so the TUI flips to the build view like the
            // alive-run path would.
            const part = MessageV2.parts(ctx.messageID).find(
              (p) => p.type === "tool" && p.callID === ctx.callID,
            )
            if (part?.type === "tool" && (part.state.status === "error" || part.state.status === "pending")) {
              yield* session.updatePart({
                ...part,
                state: {
                  status: "completed",
                  input: part.state.input,
                  output: "User approved switching to build agent. Executing the plan.",
                  metadata: { switched: true, feedback: "" },
                  title: "Switching to build agent",
                  time: {
                    start: part.state.status === "error" ? part.state.time.start : Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }

          return {
            title: "Switching to build agent",
            output: "User approved switching to build agent. Wait for further instructions.",
            metadata: { switched: true, feedback: "" },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
