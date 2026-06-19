import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"

import PROMPT_CORE from "./prompt/core-behavior-core.txt"

// 各提供商精简版提示词（仅工程流程部分，核心行为在 assistant-core.txt）
import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

// 所有模型共享的助手核心行为（身份、输出风格、工具策略等）
import ASSISTANT_CORE from "./prompt/assistant-core.txt"

import type { Provider } from "@/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

const PROMPT_BY_PROVIDER: Record<string, string> = {
  anthropic: PROMPT_ANTHROPIC,
  "amazon-bedrock": PROMPT_ANTHROPIC,
  "google-vertex": PROMPT_ANTHROPIC,
  openai: PROMPT_GPT,
  google: PROMPT_GEMINI,
  kimi: PROMPT_KIMI,
  moonshot: PROMPT_KIMI,
}

/**
 * 根据模型提供商选择提示词。
 *
 * 返回两个部分：
 *   [0] ASSISTANT_CORE — 所有提供商共享的核心行为（身份、输出风格、工具策略）
 *   [1] provider-specific — 工程流程（分析、任务、代码质量）
 *
 * 这种分层结构让 LLM 前缀缓存对稳定的 core 部分保持高命中率。
 * 模型相关占位符（${model.providerID} / ${model.api.id}）在此处替换。
 */
export function provider(_model: Provider.Model) {
  const prompt = PROMPT_BY_PROVIDER[_model.providerID]
  if (prompt) {
    const resolved = prompt
      .replace(/\$\{model\.providerID\}/g, _model.providerID)
      .replace(/\$\{model\.api\.id\}/g, _model.api.id)
    return [ASSISTANT_CORE, resolved]
  }
  return [ASSISTANT_CORE, PROMPT_CORE]
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
            // 模型标识已由 assistant-core.txt 提供，此处只注入运行环境
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
