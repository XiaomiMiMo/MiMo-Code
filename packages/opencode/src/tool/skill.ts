import z from "zod"
import { Effect } from "effect"
import { Agent } from "../agent/agent"
import { Ripgrep } from "../file/ripgrep"
import { Skill } from "../skill"
import { BuiltinWorkflow } from "../workflow/builtin"
import * as Tool from "./tool"
import { renderSkillContent } from "./skill-content"
import DESCRIPTION from "./skill.txt"

const Parameters = z.object({
  name: z.string().describe("The name of the skill from available_skills"),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const rg = yield* Ripgrep.Service
    const agents = yield* Agent.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* skill.get(params.name)
          if (!info) {
            // A common miss: the name is a built-in WORKFLOW, not a skill (e.g.
            // the user said "run the naming workflow"). Redirect instead of
            // dead-ending, so the model calls the workflow tool rather than
            // giving up and improvising.
            if (BuiltinWorkflow.get(params.name)) {
              throw new Error(
                `"${params.name}" is a built-in WORKFLOW, not a skill. Run it with the workflow tool: ` +
                  `workflow({ operation: "run", name: "${params.name}", args: { ... } }). Do NOT use the skill tool for it.`,
              )
            }
            // Same set the tool description advertises, so a near miss cannot
            // reveal a skill the model is not allowed to see.
            const available = (yield* skill.modelInvocable(yield* agents.get(ctx.agent)))
              .map((item) => item.name)
              .join(", ")
            throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
          }

          // Model reachability gate. The user can still load this skill by
          // typing /name; redirect there instead of dead-ending, so the model
          // reports the option rather than retrying and giving up.
          if (info.disable_model_invocation) {
            throw new Error(
              `Skill "${info.name}" sets disable-model-invocation, so it cannot be loaded with the skill tool. ` +
                `Only the user can start it by typing /${info.name}. Do not retry this tool — tell the user to run ` +
                `/${info.name} if that is the workflow they want.`,
            )
          }

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          const rendered = yield* renderSkillContent(info, rg, ctx.abort)

          return {
            title: `Loaded skill: ${info.name}`,
            output: rendered.output,
            metadata: {
              name: info.name,
              dir: rendered.dir,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
