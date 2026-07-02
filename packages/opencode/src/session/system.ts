import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_DEEPSEEK from "./prompt/deepseek.txt"
import PROMPT_GLM from "./prompt/glm.txt"
import PROMPT_MINIMAX from "./prompt/minimax.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import { Provider } from "@/provider"
import { sortVisionModels } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  if (model.api.id.toLowerCase().includes("deepseek")) return [PROMPT_DEEPSEEK]
  if (model.api.id.toLowerCase().includes("glm")) return [PROMPT_GLM]
  if (model.api.id.toLowerCase().includes("minimax")) return [PROMPT_MINIMAX]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model, now: number) => string[]
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    const provider = yield* Provider.Service
    const preferred = yield* provider.getVisionModel().pipe(Effect.orElseSucceed(() => undefined))
    const visionModels = yield* provider
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

    return Service.of({
      environment(model, now) {
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
            // Anchored to the session's creation time (not request time) so this block
            // stays byte-identical across every turn of a session — including ones that
            // cross midnight — keeping it inside the Anthropic cached system prefix.
            // Both the runLoop and checkpoint prefix-capture paths pass the same value.
            `  Today's date: ${new Date(now).toDateString()}`,
            `</env>`,
          ].join("\n"),
          `IMPORTANT: Your response must ALWAYS strictly follow the same major language as the user.`,
        ]
        if (!model.capabilities.input.image)
          base.push(
            [
              `<vision-capability>`,
              `You CANNOT see or interpret image content — this model has no vision support.`,
              `Never attempt to analyze an image's visual content yourself. If a task needs image understanding, dispatch a vision-capable subagent via the actor tool, passing the image file path so the subagent can Read it.`,
              visionModels.length
                ? `Vision-capable models you can pass to --model: ${visionModels.join(", ")}. Run \`actor models --vision\` to see all of them. Example: actor run <type> "<desc>" "analyze the image at <path>" --model ${preferredRef}.`
                : `No vision-capable model is currently configured. Ask the user to configure a vision model, or use an OCR tool to extract text.`,
              `If instead you need a file's raw binary structure (not its visual content), use a shell tool such as \`hexdump -C <path>\`, NOT the read tool.`,
            ].join("\n"),
          )
        return base
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

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer), Layer.provide(Provider.defaultLayer))

export * as SystemPrompt from "./system"
