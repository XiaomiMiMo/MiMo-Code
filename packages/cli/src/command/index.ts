import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect"
import { EffectBridge } from "@/effect"
import { Flag } from "@/flag/flag"
import type { InstanceContext } from "@/project/instance"
import { SessionID, MessageID } from "@/session/schema"
import { Deferred, Effect, Layer, Context } from "effect"
import z from "zod"
import { Config } from "../config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { Log } from "../util"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_LOOPS from "./template/loops.txt"
import PROMPT_REVIEW from "./template/review.txt"

const log = Log.create({ service: "command" })

type State = {
  commands: Record<string, Info>
  mcp: Record<string, Info>
  mcpReady: Deferred.Deferred<void>
}

export const Event = {
  Executed: BusEvent.define(
    "command.executed",
    z.object({
      name: z.string(),
      sessionID: SessionID.zod,
      arguments: z.string(),
      messageID: MessageID.zod,
    }),
  ),
}

export const Info = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    source: z.enum(["command", "mcp", "skill"]).optional(),
    bundled: z.boolean().optional(),
    // workaround for zod not supporting async functions natively so we use getters
    // https://zod.dev/v4/changelog?id=zfunction
    template: z.promise(z.string()).or(z.string()),
    subtask: z.boolean().optional(),
    hints: z.array(z.string()),
  })
  .meta({
    ref: "Command",
  })

// for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
export type Info = Omit<z.infer<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
  DREAM: "dream",
  DISTILL: "distill",
  GOAL: "goal",
  DEEP_RESEARCH: "deep-research",
  LOOPS: "loops",
  REBUILD: "rebuild",
} as const

export function deepResearchTemplate(): string {
  return [
    "The user wants a deep, multi-source, fact-checked research report.",
    "",
    "Research request:",
    "$ARGUMENTS",
    "",
    "If the request is underspecified (missing scope, constraints, region, time range, etc.),",
    "ask 2-3 brief clarifying questions FIRST, then weave the answers into a refined question.",
    "",
    "When the request is specific enough, run the built-in deep-research workflow:",
    '  workflow({ operation: "run", name: "deep-research", args: "<the refined research question>" })',
    "",
    "Pass the full refined question as `args`. The workflow fans out web searches, fetches sources,",
    "adversarially verifies claims, and returns a cited report; relay its result to the user.",
  ].join("\n")
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }
      commands[Default.DREAM] = {
        name: Default.DREAM,
        description: "manually consolidate project memory from memory files and raw trajectory",
        agent: "dream",
        source: "command",
        subtask: false,
        get template() {
          return [
            "Run one manual dream memory consolidation pass for the current project.",
            "",
            "User focus or constraints:",
            "$ARGUMENTS",
            "",
            "Use the memory files as the working index and the raw mimocode trajectory database as the source of truth.",
            "Use bash for read-only SQLite and filesystem inspection. Do not modify the database.",
            "Consolidate only durable, verified information into project memory.",
          ].join("\n")
        },
        hints: ["$ARGUMENTS"],
      }
      commands[Default.DISTILL] = {
        name: Default.DISTILL,
        description: "find repeated workflows in recent work and package them into skills, subagents, or commands",
        agent: "distill",
        source: "command",
        subtask: false,
        get template() {
          return [
            "Run one manual distill pass for the current project.",
            "",
            "User focus or constraints:",
            "$ARGUMENTS",
            "",
            "Look back over recent work and identify repeated manual workflows worth packaging.",
            "Use the raw mimocode trajectory database as the source of truth and memory files to spot cross-session patterns.",
            "Inventory existing skills, agents, and commands first so you reuse or extend instead of duplicating.",
            "Use bash for read-only SQLite and filesystem inspection. Do not modify the database.",
            "Produce a compact shortlist, then create only the high-confidence missing assets.",
          ].join("\n")
        },
        hints: ["$ARGUMENTS"],
      }
      commands[Default.GOAL] = {
        name: Default.GOAL,
        description: "set a stop-condition goal; runs until a judge says it's met. /goal clear to abort",
        source: "command",
        subtask: false,
        get template() {
          return "$ARGUMENTS"
        },
        hints: ["$ARGUMENTS"],
      }
      commands[Default.REBUILD] = {
        name: Default.REBUILD,
        description: "rebuild the conversation context now from the latest checkpoint (frees context; recent activity is summarized)",
        source: "command",
        subtask: false,
        get template() {
          return "$ARGUMENTS"
        },
        hints: ["$ARGUMENTS"],
      }

      if (Flag.MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL) {
        commands[Default.DEEP_RESEARCH] = {
          name: Default.DEEP_RESEARCH,
          description: "deep multi-source, fact-checked research report (runs the deep-research workflow)",
          source: "command",
          bundled: true,
          subtask: false,
          get template() {
            return deepResearchTemplate()
          },
          hints: ["$ARGUMENTS"],
        }
      }

      if (Flag.MIMOCODE_EXPERIMENTAL_CRON) {
        commands[Default.LOOPS] = {
          name: Default.LOOPS,
          description: "list active scheduled jobs; accepts `cancel <id>` to delete one",
          source: "command",
          subtask: false,
          get template() {
            return PROMPT_LOOPS
          },
          hints: hints(PROMPT_LOOPS),
        }
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      // MCP prompts become commands once every server has settled. Collect them
      // in the background so listing commands (slash completion) never waits
      // for the slowest server.
      const mcpCommands: Record<string, Info> = {}
      const mcpReady = yield* Deferred.make<void>()
      yield* mcp.prompts().pipe(
        Effect.map((prompts) => {
          for (const [name, prompt] of Object.entries(prompts)) {
            mcpCommands[name] = {
              name,
              source: "mcp",
              description: prompt.description,
              get template() {
                return bridge.promise(
                  mcp
                    .getPrompt(
                      prompt.client,
                      prompt.name,
                      prompt.arguments
                        ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                        : {},
                    )
                    .pipe(
                      Effect.map(
                        (template) =>
                          template?.messages
                            .map((message) => (message.content.type === "text" ? message.content.text : ""))
                            .join("\n") || "",
                      ),
                    ),
                )
              },
              hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
            }
          }
        }),
        Effect.catchCause((cause) => Effect.sync(() => log.warn("failed to collect MCP prompt commands", { cause }))),
        Effect.ensuring(Deferred.succeed(mcpReady, undefined)),
        Effect.forkScoped,
      )

      return {
        commands,
        mcp: mcpCommands,
        mcpReady,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    // Skills are rescanned on every lookup so a skill added on disk is listed
    // and runnable without a restart. MCP prompts override built-in and config
    // commands of the same name; skills never override anything.
    const current = Effect.fnUntraced(function* () {
      const s = yield* InstanceState.get(state)
      yield* skill.refresh()
      const commands: Record<string, Info> = { ...s.commands, ...s.mcp }
      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          bundled: item.bundled,
          get template() {
            return item.content
          },
          hints: [],
        }
      }
      return commands
    })

    // Running a command by name may race MCP startup: on a miss, wait for the
    // prompt collection and look again. Listing never waits.
    const get = Effect.fn("Command.get")(function* (name: string) {
      const found = (yield* current())[name]
      if (found) return found
      const s = yield* InstanceState.get(state)
      if (yield* Deferred.isDone(s.mcpReady)) return undefined
      yield* Deferred.await(s.mcpReady)
      return s.mcp[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      return Object.values(yield* current())
    })

    return Service.of({ get, list })
  }),
)

/**
 * Application composition variant. The process-wide AppLayer supplies the
 * MCP service so Command and SessionPrompt share one client set instead of
 * each hiding a separately scoped transport layer.
 */
export const appLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export const defaultLayer = appLayer.pipe(Layer.provide(MCP.defaultLayer))

export * as Command from "."
