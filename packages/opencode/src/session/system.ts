import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"

// 所有模型共享统一的核心行为指令
import PROMPT_CORE_BEHAVIOR from "./prompt/core-behavior.txt"

import type { Provider } from "@/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

/**
 * 所有模型使用统一的核心行为 prompt
 *
 * 设计哲学：不同模型的能力差异由 extended thinking budget 控制，
 * 而行为风格（思考方式、输出风格、工具策略等）保持一致。
 * 这确保了无论使用哪个模型，用户都能获得一致的交互体验。
 */
export function provider(_model: Provider.Model) {
  return [PROMPT_CORE_BEHAVIOR]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => string[]
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment(model) {
        const project = Instance.project
        return [
          [
            `You are MiMoCode, a professional software engineering assistant built by Xiaomi MiMo Team.`,
            `You are powered by ${model.api.id} (model ID: ${model.providerID}/${model.api.id}).`,
            `Environment:`,
            `<env>`,
            `  Working directory: ${Instance.directory}`,
            `  Workspace root: ${Instance.worktree}`,
            `  Git repo: ${project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
          `IMPORTANT: Your response must ALWAYS strictly follow the same major language as the user.`,
        ]
      },

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
