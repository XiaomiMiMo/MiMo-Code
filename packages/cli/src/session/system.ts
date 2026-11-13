import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"

import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import { Provider } from "@/provider"
import { sortVisionModels } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { Flag } from "@/flag/flag"
import { type HarnessMode, usesCodexMode } from "@/tool/gpt"

// Every model sees the same default system prompt; only the opt-in Codex
// mode swaps in its own prompt to match the exec toolset.
export function provider(_model: Provider.Model, harness?: HarnessMode) {
  return [usesCodexMode(harness) ? PROMPT_GPT : PROMPT_DEFAULT]
}

export function agent(agent: Agent.Info, model: Provider.Model, harness?: HarnessMode) {
  if (!agent.prompt) return provider(model, harness)
  return agent.inheritProviderPrompt ? [...provider(model, harness), agent.prompt] : [agent.prompt]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Skill.Info[]>
  readonly all: () => Effect.Effect<Skill.Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const providerService = yield* Provider.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        if (!Flag.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT) return []
        const project = Instance.project
        const base = [
          [
            `You are MiMo Code Agent, built by Xiaomi MiMo Team. You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.`,
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${Instance.directory}`,
            `  Workspace root folder: ${Instance.worktree}`,
            `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `</env>`,
          ].join("\n"),
          `IMPORTANT: Your response must ALWAYS strictly follow the same major language as the user.`,
        ]
        if (!model.capabilities.input.image) {
          // NOTE: vision models are resolved per-call (lazy). If provider list changes
          // mid-session, this block may differ between turns and break cached system prefix.
          // In practice provider config is stable within a session.
          const preferred = yield* providerService.getVisionModel().pipe(Effect.orElseSucceed(() => undefined))
          const visionModels = yield* providerService
            .list()
            .pipe(
              Effect.map((providers) =>
                sortVisionModels(
                  Object.values(providers)
                    .flatMap((info) => Object.values(info.models))
                    .filter((m) => m.capabilities.input.image === true),
                )
                  .map((m) => `${m.providerID}/${m.id}`)
                  .slice(0, 3),
              ),
            )
            .pipe(Effect.orElseSucceed(() => [] as string[]))
          const preferredRef = preferred ? `${preferred.providerID}/${preferred.id}` : visionModels[0]
          base.push(
            [
              `<vision-capability>`,
              `You CANNOT see or interpret image content — this model has no vision support.`,
              `Never attempt to analyze an image's visual content yourself. If a task needs image understanding, dispatch a vision-capable subagent via the actor tool, passing the image file path so the subagent can \`read\` it.`,
              visionModels.length
                ? `Vision-capable models you can pass to --model: ${visionModels.join(", ")}. Run \`actor models --vision\` to see all of them. Example: actor run <type> "<desc>" "analyze the image at <path>" --model ${preferredRef}.`
                : `No vision-capable model is currently configured. Ask the user to configure a vision model, or use an OCR tool to extract text.`,
              `If instead you need a file's raw binary structure (not its visual content), use a shell tool such as \`hexdump -C <path>\`, NOT the read tool.`,
            ].join("\n"),
          )
        }
        return base
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.modelInvocable(agent)

        return [
          "Skills available in this session:",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),

      // The user surface: authorization-filtered but NOT model-reachability
      // filtered, because it backs the mention scan that loads a skill the user
      // invoked explicitly. Do not switch this to modelInvocable.
      available: Effect.fn("SystemPrompt.available")(function* (agent?: Agent.Info) {
        return yield* skill.available(agent)
      }),

      all: Effect.fn("SystemPrompt.all")(function* () {
        return yield* skill.all()
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Provider.defaultLayer),
)

export * as SystemPrompt from "./system"
