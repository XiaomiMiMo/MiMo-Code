import { PlanEnterTool, PlanExitTool } from "./plan"
import { Session } from "../session"
import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { HistoryTool } from "./history"
import { MemoryTool } from "./memory"
import { ReadTool } from "./read"
import { ActorTool } from "./actor"
import { TaskTool } from "./task"
import { CronTool } from "./cron"
import { SessionTool } from "./session"
import { WorkflowTool } from "./workflow"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { NotebookEditTool } from "./notebook-edit"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import { SkillSearchTool } from "./skill-search"
import * as Tool from "./tool"
import { Config } from "../config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@mimo-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { Provider } from "../provider"
import { Worktree } from "../worktree"
import { Git } from "../git"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util"
import { errorMessage } from "@/util/error"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { ChangeDirectoryTool } from "./change-directory"
import { Glob } from "@mimo-ai/shared/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { Ripgrep } from "../file/ripgrep"
import { Format } from "../format"
import { InstanceState } from "@/effect"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "../lsp"
import { Instruction } from "../session/instruction"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Bus } from "../bus"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { ActorRegistry } from "@/actor/registry"
import { ActorWaiter } from "@/actor/waiter"
import { Team } from "@/team"
import { Memory } from "@/memory"
import { History } from "@/history"
import { SessionCheckpoint } from "@/session/checkpoint"
import { TaskRegistry } from "@/task/registry"
import { defaultLayer as SchedulerDefaultLayer } from "@/cron/scheduler"
import { Auth } from "@/auth"
import { shellWrap } from "./shell-wrap"
import * as BashInteractive from "./bash-interactive"
import { resolveInvocationStyle } from "./invocation-style"
import { BuiltinWorkflow } from "@/workflow/builtin"
import { ToolScriptTool, renderToolScriptDeclarations } from "./tool-script"
import { toolScriptRegistry, toolScriptMcp } from "./tool-script-ref"

const log = Log.create({ service: "tool.registry" })

export function renderWorkflowCatalog(): string {
  const list = BuiltinWorkflow.list()
  if (list.length === 0) return ""
  const entries = list.map((w) => {
    const phases = w.phases?.length ? "\n  Phases: " + w.phases.map((p) => p.title).join(" → ") : ""
    const when = w.whenToUse ? `\n  When to use: ${w.whenToUse}` : ""
    return `- ${w.name}: ${w.description}${when}${phases}`
  })
  return [
    "",
    "## Built-in workflows",
    'These named workflows are available via operation "run" with `name`. When a request matches one, invoke it instead of writing a script from scratch:',
    "",
    ...entries,
    "",
    'Invoke a built-in: workflow({ operation: "run", name: "deep-research", args: "<the refined request>" })',
  ].join("\n")
}

const fallbackWarned = new Set<string>()
function warnShellFallbackOnce(id: string) {
  if (fallbackWarned.has(id)) return
  fallbackWarned.add(id)
  log.warn(`tool '${id}' configured with invocation_style='shell' but has no shell field; falling back to JSON`)
}

type ActorDef = Tool.InferDef<typeof ActorTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  actor: ActorDef
  read: ReadDef
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ actor: ActorDef; read: ReadDef }>
  readonly tools: (model: { providerID: ProviderID; modelID: ModelID; agent: Agent.Info }) => Effect.Effect<Tool.Def[]>
  readonly reload: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

// SessionTool's `dashboard` verb correlates worktrees via Git.Service. Git is a
// leaf layer (needs only ChildProcessSpawner) with no shared state, so the
// registry self-provides it rather than leaking Git.Service as an external
// requirement onto every consumer (production wiring + ~20 test harnesses).
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const skill = yield* Skill.Service
    const truncate = yield* Truncate.Service

    const invalid = yield* InvalidTool
    const actor = yield* ActorTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const lsptool = yield* LspTool
    const planexit = yield* PlanExitTool
    const planenter = yield* PlanEnterTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const bash = yield* BashTool
    const codesearch = yield* CodeSearchTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const notebookedit = yield* NotebookEditTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const changedirtool = yield* ChangeDirectoryTool
    const skilltool = yield* SkillTool
    const skillsearch = yield* SkillSearchTool
    const historytool = yield* HistoryTool
    const memorytool = yield* MemoryTool
    const tasktool = yield* TaskTool
    const crontool = yield* CronTool
    const sessiontool = yield* SessionTool
    const workflowtool = yield* WorkflowTool
    const toolscript = yield* ToolScriptTool
    const agent = yield* Agent.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          return {
            id,
            parameters: z.object(def.args),
            description: def.description,
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => toolCtx.ask(req),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: "",
                  output: out.truncated ? out.content : output,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }),
          }
        }

        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) yield* config.waitForDependencies()
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
          // Import it as `file://` so Node on Windows accepts the dynamic import.
          const mod = yield* Effect.tryPromise({
            try: () => import(`${pathToFileURL(match).href}?v=${Date.now()}`),
            catch: (err) => err,
          }).pipe(Effect.catch((err) => {
            log.error("failed to load file tool, skipping", { path: match, error: errorMessage(err) })
            return Effect.succeed(undefined)
          }))
          if (!mod) continue
          for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
            custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            custom.push(fromPlugin(id, def))
          }
        }

        yield* config.get()
        const questionEnabled =
          ["app", "cli", "desktop"].includes(Flag.MIMOCODE_CLIENT) || Flag.MIMOCODE_ENABLE_QUESTION_TOOL

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          bash: Tool.init(bash),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          notebookedit: Tool.init(notebookedit),
          actor: Tool.init(actor),
          fetch: Tool.init(webfetch),
          search: Tool.init(websearch),
          code: Tool.init(codesearch),
          skill: Tool.init(skilltool),
          skillsearch: Tool.init(skillsearch),
          patch: Tool.init(patchtool),
          changedir: Tool.init(changedirtool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          planexit: Tool.init(planexit),
          planenter: Tool.init(planenter),
          memory: Tool.init(memorytool),
          history: Tool.init(historytool),
          task: Tool.init(tasktool),
          cron: Tool.init(crontool),
          session: Tool.init(sessiontool),
          workflow: Tool.init(workflowtool),
          toolscript: Tool.init(toolscript),
        })

        return {
          custom,
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.bash,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            tool.notebookedit,
            tool.actor,
            tool.fetch,
            tool.search,
            tool.code,
            tool.skillsearch,
            tool.skill,
            tool.patch,
            tool.changedir,
            ...(Flag.MIMOCODE_EXPERIMENTAL_LSP_TOOL ? [tool.lsp] : []),
            tool.planexit,
            tool.planenter,
            tool.memory,
            tool.history,
            tool.task,
            ...(Flag.MIMOCODE_ENABLE_TOOL_SCRIPT ? [tool.toolscript] : []),
            ...(Flag.MIMOCODE_EXPERIMENTAL_CRON ? [tool.cron] : []),
            ...(Flag.MIMOCODE_EXPERIMENTAL_ORCHESTRATOR ? [tool.session] : []),
            ...(Flag.MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL ? [tool.workflow] : []),
          ],
          actor: tool.actor,
          read: tool.read,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      const customIds = new Set(s.custom.map((t) => t.id))
      const builtins = s.builtin.filter((t) => !customIds.has(t.id))
      return [...builtins, ...s.custom] as Tool.Def[]
    })

    // Late-bound ref (see tool-script-ref.ts): tool_script dispatches guest RPC
    // calls through the same def list the agent sees, without a module cycle.
    toolScriptRegistry.current = all

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeSkill = Effect.fn("ToolRegistry.describeSkill")(function* (agent: Agent.Info) {
      const list = yield* skill.available(agent)
      if (list.length === 0) return "No skills are currently available."
      return [
        "Load a specialized skill that provides domain-specific instructions and workflows.",
        "",
        "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
        "",
        "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
        "",
        'Tool output includes a `<skill_content name="...">` block with the loaded content.',
        "",
        "The following skills provide specialized sets of instructions for particular tasks",
        "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
        "",
        Skill.fmt(list, { verbose: false }),
      ].join("\n")
    })

    const describeWorkflow = Effect.fn("ToolRegistry.describeWorkflow")(function* () {
      return renderWorkflowCatalog()
    })

    const describeToolScript = Effect.fn("ToolRegistry.describeToolScript")(function* () {
      // MCP declarations ride along when SessionPrompt has populated the ref
      // (interactive sessions); registry-only contexts render builtins only.
      const mcp = toolScriptMcp.current ? yield* toolScriptMcp.current() : {}
      return renderToolScriptDeclarations(yield* all(), mcp)
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter(
        (item) => item.mode !== "primary" && !item.hidden,
      )
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      let filtered = (yield* all()).filter((tool) => {
        if (tool.id === CodeSearchTool.id || tool.id === WebSearchTool.id) {
          if (tool.id === WebSearchTool.id) {
            return (
              input.providerID === ProviderID.opencode ||
              input.providerID === "xiaomi" ||
              Flag.MIMOCODE_ENABLE_EXA
            )
          }
          return input.providerID === ProviderID.opencode || Flag.MIMOCODE_ENABLE_EXA
        }

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      if (input.agent.toolAllowlist) {
        const allowed = new Set(input.agent.toolAllowlist)
        filtered = filtered.filter((tool) => tool.id === "invalid" || allowed.has(tool.id))
      }

      // The `session` tool is orchestrator-only. Orchestrator is a
      // full-capability agent (no toolAllowlist), so gate on the agent name
      // rather than an allowlist: every other agent — primaries without an
      // allowlist (build/plan/compose) and subagents — must not see `session`.
      filtered = filtered.filter((tool) => tool.id !== "session" || input.agent.name === "orchestrator")

      const cfg = yield* config.get()
      const resolveStyle = (toolId: string): "json" | "shell" => resolveInvocationStyle(cfg.tool, toolId)

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          using _ = log.time(tool.id)
          const output = {
            description: tool.description,
            parameters: tool.parameters,
          }
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          const style = resolveStyle(tool.id)
          const useShell = style === "shell" && tool.shell !== undefined
          if (style === "shell" && !tool.shell) {
            warnShellFallbackOnce(tool.id)
          }
          const effective: Tool.Def = useShell ? shellWrap(tool) : tool
          const description = useShell ? tool.shell!.description : output.description
          return {
            id: tool.id,
            description: [
              description,
              tool.id === ActorTool.id ? yield* describeTask(input.agent) : undefined,
              tool.id === SkillTool.id ? yield* describeSkill(input.agent) : undefined,
              tool.id === WorkflowTool.id ? yield* describeWorkflow() : undefined,
              tool.id === ToolScriptTool.id ? yield* describeToolScript() : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: useShell ? effective.parameters : output.parameters,
            execute: effective.execute,
            formatValidationError: effective.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { actor: s.actor, read: s.read }
    })

    const reload: Interface["reload"] = Effect.fn("ToolRegistry.reload")(function* () {
      yield* skill.reload()
      yield* plugin.reloadFileHooks()
      yield* InstanceState.invalidate(state)
    })

    return Service.of({ ids, all, named, tools, reload })
  }),
).pipe(Layer.provide(Git.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Question.defaultLayer),
    Layer.provide(Todo.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Layer.mergeAll(ActorRegistry.defaultLayer, ActorWaiter.defaultLayer, Worktree.defaultLayer)),
    Layer.provide(Team.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        Memory.defaultLayer,
        History.defaultLayer,
        SessionCheckpoint.defaultLayer,
        TaskRegistry.defaultLayer,
        SchedulerDefaultLayer,
        Auth.defaultLayer,
      ),
    ),
  ),
)
