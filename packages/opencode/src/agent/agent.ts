import { Config } from "../config"
import z from "zod"
import { Provider } from "../provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Instance } from "../project/instance"
import { Truncate } from "../tool"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_DREAM from "./prompt/dream.txt"
import PROMPT_DISTILL from "./prompt/distill.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer } from "effect"
import { InstanceState } from "@/effect"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"

export const Info = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    mode: z.enum(["subagent", "primary", "all"]),
    native: z.boolean().optional(),
    hidden: z.boolean().optional(),
    topP: z.number().optional(),
    temperature: z.number().optional(),
    color: z.string().optional(),
    permission: Permission.Ruleset.zod,
    model: z
      .object({
        modelID: ModelID.zod,
        providerID: ProviderID.zod,
      })
      .optional(),
    modelRef: z.string().optional(),
    variant: z.string().optional(),
    prompt: z.string().optional(),
    options: z.record(z.string(), z.any()),
    steps: z.number().int().positive().optional(),
    toolAllowlist: z.array(z.string()).optional(),
  })
  .meta({
    ref: "Agent",
  })
export type Info = z.infer<typeof Info>

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<{
    identifier: string
    whenToUse: string
    systemPrompt: string
  }>
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (_ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const whitelistedDirs = [Truncate.GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            color: "#fb8147",
            description: "Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          // Max mode is experimental and opt-in: only registered when
          // `experimental.maxMode` is configured. This keeps the default agent
          // set as {build, plan, compose} when the feature is off.
          ...(cfg.experimental?.maxMode
            ? {
                max: {
                  name: "max",
                  color: "#e85d75",
                  description:
                    "Max mode (experimental). Runs N parallel reasoning candidates each step and executes the best one. Same permissions as build.",
                  options: {},
                  permission: Permission.merge(
                    defaults,
                    Permission.fromConfig({
                      question: "allow",
                      plan_enter: "allow",
                    }),
                    user,
                  ),
                  mode: "primary" as const,
                  native: true,
                },
              }
            : {}),
          plan: {
            name: "plan",
            color: "#c7e2a8",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".mimocode", "plans", "*.md")]: "allow",
                  [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          compose: {
            name: "compose",
            color: "#a7a3d8",
            description: "Compose mode. Orchestrates workflows with built-in compose skills.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                skill: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            color: "#aac4e1",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                change_directory: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            color: "#f5c9b0",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                codesearch: "allow",
                read: "allow",
                external_directory: {
                  "*": "ask",
                  ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
                },
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          title: {
            name: "title",
            mode: "subagent",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
            toolAllowlist: [],
          },
          summary: {
            name: "summary",
            mode: "subagent",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
            toolAllowlist: [],
          },
          compaction: {
            name: "compaction",
            mode: "subagent",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_COMPACTION,
            toolAllowlist: [],
          },
          "checkpoint-writer": {
            name: "checkpoint-writer",
            mode: "subagent" as const,
            options: {},
            native: true,
            hidden: true,
            // No `prompt` field — fork agent contract: at spawn time,
            // tryStartCheckpointWriter captures parent's full LLM request prefix
            // (system + tools + messages-to-watermark) into a frozen ForkContext,
            // stored in Actor service's in-memory map. fork's runLoop reads from
            // that snapshot instead of recomputing from this agent's identity.
            // See docs/superpowers/specs/2026-05-26-fork-agent-prefix-cache-design.md
            //
            // No `toolAllowlist` field — fork agents must mirror parent's tool
            // schema for prefix-cache alignment. Runtime tool restriction is
            // enforced via actor.tools whitelist (set in tryStartCheckpointWriter).
            // Permission inherits `defaults` (+ user) only — NO bespoke block.
            // At runtime the fork's LLM-visible tool schema is filtered against the
            // PARENT agent's permission (ForkContext.parentPermission, fed to
            // handle.process in prompt.ts's fork branch), so it matches the parent
            // (prompt-cache parity). NOTE: the per-call ctx.ask still evaluates this
            // agent's own permission, but that is bounded by the actor.tools whitelist
            // (set in tryStartCheckpointWriter) and memory-path-guard — the real write
            // authority — so inheriting `defaults` over-grants nothing in practice.
            // Memory writes skip the edit ask (askEditUnlessMemory), and any
            // un-answerable ask fails clean (SYSTEM_SPAWNED_AGENT_TYPES →
            // interactive:false). See
            // docs/superpowers/specs/2026-06-05-checkpoint-writer-permission-deadlock-design.md
            permission: Permission.merge(defaults, user),
          },
          dream: {
            name: "dream",
            mode: "subagent" as const,
            options: {},
            native: true,
            hidden: true,
            prompt: PROMPT_DREAM,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                write: "allow",
                edit: "allow",
                glob: "allow",
                grep: "allow",
                memory: "allow",
                bash: "allow",
                external_directory: {
                  [path.join(Global.Path.data, "memory")]: "allow",
                  [path.join(Global.Path.data, "memory", "*")]: "allow",
                },
              }),
              user,
            ),
            toolAllowlist: ["read", "write", "edit", "glob", "grep", "memory", "bash"],
          },
          distill: {
            name: "distill",
            mode: "subagent" as const,
            options: {},
            native: true,
            hidden: true,
            prompt: PROMPT_DISTILL,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                write: "allow",
                edit: "allow",
                glob: "allow",
                grep: "allow",
                memory: "allow",
                bash: "allow",
                external_directory: {
                  [path.join(Global.Path.data, "memory")]: "allow",
                  [path.join(Global.Path.data, "memory", "*")]: "allow",
                },
              }),
              user,
            ),
            toolAllowlist: ["read", "write", "edit", "glob", "grep", "memory", "bash"],
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) {
            if (value.model.includes("/")) item.model = Provider.parseModel(value.model)
            else item.modelRef = value.model
          }
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.toolAllowlist = value.tool_allowlist ?? item.toolAllowlist
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => cfg.default_agent !== undefined && x.name === cfg.default_agent, "desc"],
              [(x) => x.name === "build", "desc"],
              [(x) => x.name === "plan", "desc"],
              [(x) => x.name === "compose", "desc"],
              [(x) => x.name === "max", "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent.name
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible.name
        })

        return {
          get,
          list,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderID; modelID: ModelID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: z.object({
            identifier: z.string(),
            whenToUse: z.string(),
            systemPrompt: z.string(),
          }),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Agent from "./agent"
