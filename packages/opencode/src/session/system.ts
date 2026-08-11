import { Context, Effect, Layer } from "effect"
import os from "os"

import { Instance } from "../project/instance"
import { Git } from "@/git"
import { Shell } from "@/shell/shell"
import { which } from "@/util/which"

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
import { isSkillSearchDisabled, type SkillSearchModel } from "@/skill/search"

function renderGitResult(result: Git.Result, fallback = "(none)") {
  if (result.exitCode !== 0) return fallback
  return result.text().trim() || fallback
}

const anthropicEnvironment = new Map<string, string>()

export function provider(model: Provider.Model) {
  const prompt = (id: string) => {
    if (id.includes("gpt-4") || id.includes("o1") || id.includes("o3")) return PROMPT_BEAST
    if (id.includes("gpt")) return id.includes("codex") ? PROMPT_CODEX : PROMPT_GPT
    if (id.includes("gemini-")) return PROMPT_GEMINI
    if (id.includes("claude")) return PROMPT_ANTHROPIC
    if (id.toLowerCase().includes("trinity")) return PROMPT_TRINITY
    if (id.toLowerCase().includes("kimi")) return PROMPT_KIMI
    if (id.toLowerCase().includes("deepseek")) return PROMPT_DEEPSEEK
    if (id.toLowerCase().includes("glm")) return PROMPT_GLM
    if (id.toLowerCase().includes("minimax")) return PROMPT_MINIMAX
  }
  return [prompt(model.id) ?? prompt(model.api.id) ?? PROMPT_DEFAULT]
}

export function agent(agent: Agent.Info, model: Provider.Model) {
  return agent.prompt ? [agent.prompt] : provider(model)
}

export interface Interface {
  readonly environment: (model: Provider.Model, now: number) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info, model?: SkillSearchModel) => Effect.Effect<string | undefined>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Skill.Info[]>
  readonly all: () => Effect.Effect<Skill.Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const providerService = yield* Provider.Service
    const git = yield* Git.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model, now: number) {
        const project = Instance.project
        if (provider(model)[0] === PROMPT_ANTHROPIC) {
          const key = `${Instance.directory}\0${now}\0${model.providerID}\0${model.api.id}`
          const cached = anthropicEnvironment.get(key)
          if (cached)
            return [cached, `IMPORTANT: Your response must ALWAYS strictly follow the same major language as the user.`]

          const [branch, base, user, status, commits] = yield* Effect.all(
            [
              git.branch(Instance.directory),
              git.defaultBranch(Instance.directory),
              git.run(["config", "user.name"], { cwd: Instance.directory }),
              git.run(["status", "--short", "--untracked-files=all"], { cwd: Instance.directory }),
              git.run(["log", "-2", "--oneline", "--decorate=no"], { cwd: Instance.directory }),
            ],
            { concurrency: 5 },
          )
          const prompt = [
            `# Environment`,
            `You have been invoked in the following environment:`,
            ` - Primary working directory: ${Instance.directory}`,
            ` - Is a git repository: ${project.vcs === "git" ? "true" : "false"}`,
            ` - Platform: ${process.platform}`,
            ` - Shell: ${Shell.name(Shell.preferred())}`,
            ` - OS Version: ${os.type()} ${os.release()}`,
            ` - You are powered by the model named ${model.name}. The exact model ID is ${model.providerID}/${model.api.id}.`,
            ...(which("claude") ? [` - Claude Code is available as a CLI in the terminal.`] : []),
            ``,
            `gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.`,
            ``,
            `Current branch: ${branch ?? "(detached or unavailable)"}`,
            ``,
            `Main branch (you will usually use this for PRs): ${base?.name ?? "(unknown)"}`,
            ``,
            `Git user: ${renderGitResult(user, "(unknown)")}`,
            ``,
            `Status:`,
            renderGitResult(status, project.vcs === "git" ? "(clean)" : "(unavailable)"),
            ``,
            `Recent commits:`,
            renderGitResult(commits),
          ].join("\n")
          anthropicEnvironment.set(key, prompt)
          return [prompt, `IMPORTANT: Your response must ALWAYS strictly follow the same major language as the user.`]
        }
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
            `  Today's date: ${new Date(now).toDateString()}`,
            `</env>`,
          ].join("\n"),
          `IMPORTANT: Your response must ALWAYS strictly follow the same major language as the user.`,
        ]
        const maskVisionCapability = [model.id, model.api.id, model.providerID].some((id) =>
          /(^|[^a-z0-9])(gpt|claude|gemini)($|[^a-z0-9])/i.test(id),
        )
        if (!model.capabilities.input.image && !maskVisionCapability) {
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
              `Never attempt to analyze an image's visual content yourself. If a task needs image understanding, dispatch a vision-capable subagent via the actor tool, passing the image file path so the subagent can Read it.`,
              visionModels.length
                ? `Vision-capable models you can pass to --model: ${visionModels.join(", ")}. Run \`actor models --vision\` to see all of them. Example: actor run <type> "<desc>" "analyze the image at <path>" --model ${preferredRef}.`
                : `No vision-capable model is currently configured. Ask the user to configure a vision model, or use an OCR tool to extract text.`,
              `If instead you need a file's raw binary structure (not its visual content), use a shell tool such as \`hexdump -C <path>\`, NOT the read tool.`,
            ].join("\n"),
          )
        }
        return base
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info, model?: SkillSearchModel) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.modelInvocable(agent)

        if (model && isSkillSearchDisabled(model)) {
          return [
            "Skills provide specialized instructions and workflows for specific tasks.",
            "Use the skill tool to load a skill when a task matches its description.",
            Skill.fmt(list, { verbose: true }),
          ].join("\n")
        }

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "On the first user query in a session, when the task might benefit from a specialized workflow, call skill_search to find the best matching non-Compose skill.",
          "Rewrite the user's request into a concise Skill Query with these dimensions when available: action, input, output, audience.",
          "Preserve an explicitly mentioned skill ID, name, or alias verbatim in the Skill Query so exact matching can take priority over BM25.",
          "If skill_search returns a loaded_skill_id, follow the loaded instructions. If it returns uncertain candidates, choose the best fit or continue without a skill. If it returns no_match, continue normally.",
          "Compose skills are not searchable; load an explicitly requested Compose skill directly with the skill tool.",
          "Use the skill tool to load a skill when a task matches its description.",
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
  Layer.provide(Git.defaultLayer),
)

export * as SystemPrompt from "./system"
