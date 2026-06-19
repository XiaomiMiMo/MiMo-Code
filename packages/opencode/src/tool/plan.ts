import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { AGENT_BUILD, AGENT_PLAN } from "@/agent/config"
import { type SessionID, MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const fsys = yield* AppFileSystem.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: z.object({}),
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // 仅 plan agent 可以调用此工具
          if (ctx.agent !== AGENT_PLAN) {
            return {
              title: "Invalid agent",
              output: "The plan_exit tool can only be called by the plan agent.",
              metadata: { switched: false, feedback: "", model: "" },
            }
          }

          const info = yield* session.get(ctx.sessionID)
          const plan = Session.planRelative(info)

          // 检查 plan 文件是否存在
          const planAbs = Session.plan(info)
          if (!(yield* fsys.existsSafe(planAbs))) {
            return {
              title: "No plan file found",
              output: `No plan file exists at ${plan}. Please create a plan file first before calling plan_exit.`,
              metadata: { switched: false, feedback: "", model: "" },
            }
          }

          const answers = yield* question.ask({
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

          const answer = answers[0]?.[0]
          if (answer === "No") {
            return {
              title: "Staying in plan mode",
              output: "User chose to stay in plan mode and continue refining the plan.",
              metadata: { switched: false, feedback: "", model: "" },
            }
          }

          if (answer !== "Yes") {
            return {
              title: "User provided feedback",
              output: `User chose not to switch yet and provided feedback: ${answer}`,
              metadata: { switched: false, feedback: answer, model: "" },
            }
          }

          const model = MessageV2.findLastUserModel(ctx.sessionID) ?? (yield* provider.defaultModel())

          const msg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: AGENT_BUILD,
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

          return {
            title: "Switching to build agent",
            output: `User approved switching to build agent. Current model: ${model.providerID}/${model.modelID}. You can use /model to change the model after switching. Wait for further instructions.`,
            metadata: { switched: true, feedback: "", model: `${model.providerID}/${model.modelID}` },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
