import { Log } from "../util"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import z from "zod"
import { mergeDeep, pipe } from "remeda"
import { Global } from "../global"
import fsNode from "fs/promises"
import { NamedError } from "@mimo-ai/shared/util/error"
import { Flag } from "../flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { Instance, type InstanceContext } from "../project/instance"
import { InstallationLocal, InstallationVersion } from "@/installation/version"
import { existsSync } from "fs"
import { GlobalBus } from "@/bus/global"
import { Event } from "../server/event"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "./console-state"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { InstanceState } from "@/effect"
import { Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { EffectFlock } from "@mimo-ai/shared/util/effect-flock"
import { InstanceRef } from "@/effect/instance-ref"
import { zod, ZodOverride } from "@/util/effect-zod"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigCompose } from "./compose"
import { ConfigFormatter } from "./formatter"
import { MIMOCODE_GITIGNORE_ENTRIES } from "./gitignore"
import { ConfigHistory } from "./history"
import { ConfigLayout } from "./layout"
import { ConfigLSP } from "./lsp"
import { ConfigManaged } from "./managed"
import { ConfigMCP } from "./mcp"
import { ConfigModelID } from "./model-id"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPermission } from "./permission"
import { ConfigPlugin } from "./plugin"
import { ConfigProvider } from "./provider"
import { ConfigServer } from "./server"
import { ConfigSkills } from "./skills"
import { ConfigVariable } from "./variable"
import { Npm } from "@/npm"

const log = Log.create({ service: "config" })

// Custom merge function that concatenates array fields instead of replacing them
function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeDeep(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown, source: string) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  log.warn("tui keys in mimocode config are deprecated; move them to tui.json", { path: source })
  return copy
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPlugin.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

export const Server = ConfigServer.Server.zod
export const Layout = ConfigLayout.Layout.zod
export type Layout = ConfigLayout.Layout

// Schemas that still live at the zod layer (have .transform / .preprocess /
// .meta not expressible in current Effect Schema) get referenced via a
// ZodOverride-annotated Schema.Any.  Walker sees the annotation and emits the
// exact zod directly, preserving component $refs.
const AgentRef = Schema.Any.annotate({ [ZodOverride]: ConfigAgent.Info })
const PermissionRef = Schema.Any.annotate({ [ZodOverride]: ConfigPermission.Info })
const LogLevelRef = Schema.Any.annotate({ [ZodOverride]: Log.Level })

const PositiveInt = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))
const NonNegativeInt = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))

const InfoSchema = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Log level" }),
  server: Schema.optional(ConfigServer.Server).annotate({
    description: "Server configuration for mimo serve and web commands",
  }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommand.Info)).annotate({
    description: "Command configuration, see https://mimo.xiaomi.com/mimocode/commands",
  }),
  skills: Schema.optional(ConfigSkills.Info).annotate({ description: "Additional skill folder paths" }),
  compose: Schema.optional(ConfigCompose.Info).annotate({ description: "Compose mode configuration" }),
  watcher: Schema.optional(
    Schema.Struct({
      ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    }),
  ),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
  }),
  // User-facing plugin config is stored as Specs; provenance gets attached later while configs are merged.
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPlugin.Spec))),
  share: Schema.optional(Schema.Literals(["manual", "auto", "disabled"])).annotate({
    description:
      "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
  }),
  autoshare: Schema.optional(Schema.Boolean).annotate({
    description: "@deprecated Use 'share' field instead. Share newly created sessions automatically",
  }),
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])).annotate({
    description:
      "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
  }),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Disable providers that are loaded automatically",
  }),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "When set, ONLY these providers will be enabled. All other providers will be ignored",
  }),
  model: Schema.optional(ConfigModelID).annotate({
    description: "Model to use in the format of provider/model, eg anthropic/claude-2",
  }),
  small_model: Schema.optional(ConfigModelID).annotate({
    description: "Small model to use for tasks like title generation in the format of provider/model",
  }),
  vision_model: Schema.optional(ConfigModelID).annotate({
    description:
      "Model to use for image/vision subagent tasks in the format of provider/model. If unset, a vision-capable model is chosen automatically (in-house models preferred, then cheapest).",
  }),
  model_groups: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([
        // string shorthand: group is just its default model
        ConfigModelID,
        Schema.Struct({
          default: ConfigModelID,
          models: Schema.optional(Schema.mutable(Schema.Array(ConfigModelID))),
        }),
      ]),
    ),
  ).annotate({
    description:
      "Named model groups (capability tiers, e.g. ultra/standard/lite). Each group has a default model and optional member models. A group name can be used anywhere a provider/model string is accepted.",
  }),
  default_agent: Schema.optional(Schema.String).annotate({
    description:
      "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Custom username to display in conversations instead of system username",
  }),
  mode: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        build: Schema.optional(AgentRef),
        plan: Schema.optional(AgentRef),
      }),
      [Schema.Record(Schema.String, AgentRef)],
    ),
  ).annotate({ description: "@deprecated Use `agent` field instead." }),
  agent: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        // primary
        plan: Schema.optional(AgentRef),
        build: Schema.optional(AgentRef),
        // subagent
        general: Schema.optional(AgentRef),
        explore: Schema.optional(AgentRef),
        // specialized
        title: Schema.optional(AgentRef),
        summary: Schema.optional(AgentRef),
        compaction: Schema.optional(AgentRef),
      }),
      [Schema.Record(Schema.String, AgentRef)],
    ),
  ).annotate({ description: "Agent configuration, see https://mimo.xiaomi.com/mimocode/agents" }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProvider.Info)).annotate({
    description: "Custom provider configurations and model overrides",
  }),
  mcp: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([
        ConfigMCP.Info,
        // Matches the legacy `{ enabled: false }` form used to disable a server.
        Schema.Any.annotate({ [ZodOverride]: z.object({ enabled: z.boolean() }).strict() }),
      ]),
    ),
  ).annotate({ description: "MCP (Model Context Protocol) server configurations" }),
  formatter: Schema.optional(ConfigFormatter.Info),
  lsp: Schema.optional(ConfigLSP.Info),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional instruction files or patterns to include",
  }),
  layout: Schema.optional(ConfigLayout.Layout).annotate({ description: "@deprecated Always uses stretch layout." }),
  permission: Schema.optional(PermissionRef),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  tool: Schema.optional(
    Schema.Struct({
      invocation_style: Schema.optional(Schema.Literals(["json", "shell"])).annotate({
        description:
          "Default invocation style for all tools. 'json' (default) exposes the original Zod schema; 'shell' exposes a single `script` parameter and uses the tool's shell.parse mapping.",
      }),
      invocation_style_by_tool: Schema.optional(
        Schema.Record(Schema.String, Schema.Literals(["json", "shell"])),
      ).annotate({
        description:
          "Per-tool override of invocation_style. Keys are tool IDs. A tool without a `shell` field falls back to JSON regardless of this setting.",
      }),
    }),
  ).annotate({
    description: "Tool invocation style configuration (JSON vs shell-style).",
  }),
  enterprise: Schema.optional(
    Schema.Struct({
      url: Schema.optional(Schema.String).annotate({ description: "Enterprise URL" }),
    }),
  ),
  compaction: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic compaction when context is full (default: true)",
      }),
      prune: Schema.optional(Schema.Boolean).annotate({
        description: "Enable pruning of old tool outputs (default: true)",
      }),
      tail_turns: Schema.optional(NonNegativeInt).annotate({
        description:
          "Number of recent user turns, including their following assistant/tool responses, to keep verbatim during compaction (default: 2)",
      }),
      preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
        description: "Maximum number of tokens from recent turns to preserve verbatim after compaction",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer for compaction. Leaves enough window to avoid overflow during compaction.",
      }),
    }),
  ),
  checkpoint: Schema.optional(
    Schema.Struct({
      thresholds: Schema.optional(Schema.Array(Schema.String)).annotate({
        description:
          "Context fill thresholds that trigger checkpoint writes. Strings may be percentages (\"40%\"), absolute tokens (\"100K\", \"1.5M\"), or mixed (\"100K\", \"50%\"). Each threshold must be <= window - 20K reserved. Default: [\"40%\", \"60%\", \"80%\"].",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer reserved for checkpoint operations. Default: 20000.",
      }),
      max_writer_failures: Schema.optional(PositiveInt).annotate({
        description:
          "Maximum consecutive writer failures per session before checkpointing stops retrying until process restart. Default: 3.",
      }),
      fork: Schema.optional(Schema.Boolean).annotate({
        description:
          "Whether to fork the parent agent's message prefix into the writer session for prefix-cache reuse. Requires provider cache-breakpoint support. Default: false.",
      }),
      push_caps: Schema.optional(
        Schema.Struct({
          tasks_ledger: Schema.optional(PositiveInt).annotate({
            description: "Token cap for the tasks ledger section of rebuild context. Default: 2000.",
          }),
          focus_task: Schema.optional(PositiveInt).annotate({
            description: "Token cap for the focus task body in rebuild context. Default: 4000.",
          }),
          actor_ledger: Schema.optional(PositiveInt).annotate({
            description: "Token cap for the actor ledger section of rebuild context. Default: 500.",
          }),
          memory_titles: Schema.optional(PositiveInt).annotate({
            description: "Token cap for memory titles in rebuild context. Default: 500.",
          }),
          global: Schema.optional(PositiveInt).annotate({
            description:
              "Token cap for the global memory section (global/MEMORY.md) of rebuild context. Default: 6000.",
          }),
          checkpoint: Schema.optional(PositiveInt).annotate({
            description:
              "Token cap for the session checkpoint section (checkpoint.md) of rebuild context. Default: 11000.",
          }),
          memory: Schema.optional(PositiveInt).annotate({
            description: "Token cap for the project memory section (MEMORY.md) of rebuild context. Default: 10000.",
          }),
          notes: Schema.optional(PositiveInt).annotate({
            description: "Token cap for the session notes (notes.md) of rebuild context. Default: 6000.",
          }),
          design_decisions: Schema.optional(PositiveInt).annotate({
            description: "Token cap for §10 Design decisions section of checkpoint.md (writer-side budget validation). Default: 3000.",
          }),
          open_notes: Schema.optional(PositiveInt).annotate({
            description: "Token cap for §11 Open notes section of checkpoint.md (writer-side budget validation). Default: 800.",
          }),
          recent_user: Schema.optional(NonNegativeInt).annotate({
            description: "Token cap for the recent user input section (verbatim user messages from the live DB, FIFO eviction). Default: 16000. Set 0 to disable.",
          }),
          recent_user_per_msg: Schema.optional(PositiveInt).annotate({
            description: "Per-message cap inside recent user input section; oversized messages get head/tail truncation with messageID elision marker. Default: 2000.",
          }),
        }),
      ).annotate({
        description:
          "Per-section token caps for rebuild context (renderRebuildContext). Each section is loaded up to its cap so the rebuild stays within a predictable budget.",
      }),
      task_archive_days: Schema.optional(PositiveInt).annotate({
        description: "Number of days after task done/abandoned before it's filtered out of `list({include_archived: false})`. Rows are NOT deleted — see v9 for true GC. Default: 7.",
      }),
      task_cleanup_days: Schema.optional(PositiveInt).annotate({
        description: "[deprecated] Alias for task_archive_days. Will be removed in v9.",
      }),
      memory_reconcile_on_search: Schema.optional(Schema.Boolean).annotate({
        description: "Whether to reconcile memory state on search operations. Default: true.",
      }),
      memory_search_score_floor: Schema.optional(Schema.Number).annotate({
        description:
          "Relative BM25 floor for memory.search (OR-joined query): keep results scoring >= this fraction of the top hit, dropping common-word-only noise. The #1 result is always kept. Default: 0.15. Set 0 to keep all matches.",
      }),
    }),
  ),
  memory: Schema.optional(
    Schema.Struct({
      cc_index: Schema.optional(Schema.Boolean).annotate({
        description:
          "Index Claude Code memory (~/.claude/projects/<slug>/memory) and expose under scope='cc'. Default: false. Note: when enabled, every mimocode agent (build/explore/subagents) can search these memories via the builtin `memory` tool — including CC's `type: user` (your role/preferences) and `type: feedback` (your guidance) categories. CC originally writes them for future CC sessions; flipping this on widens the consumer set to mimocode agents on the same machine. Leave disabled (default) if you don't want personal context recallable from a prompt-injection-vulnerable agent.",
      }),
    }),
  ),
  history: Schema.optional(ConfigHistory.Info).annotate({
    description: "Trajectory (conversation history) FTS index configuration.",
  }),
  dream: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description:
          "Auto-trigger dream memory consolidation on new session start. Default: true.",
      }),
      interval_days: Schema.optional(NonNegativeInt).annotate({
        description: "Minimum days between automatic dream runs. Set to 0 to trigger on every new session. Default: 7.",
      }),
    }),
  ),
  distill: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description:
          "Auto-trigger distill workflow packaging on new session start. Default: true.",
      }),
      interval_days: Schema.optional(NonNegativeInt).annotate({
        description: "Minimum days between automatic distill runs. Default: 30.",
      }),
    }),
  ),
  voice: Schema.optional(
    Schema.Struct({
      asr_model: Schema.optional(ConfigModelID).annotate({
        description:
          "Model to use for voice ASR transcription in provider/model format. Defaults to xiaomi/mimo-v2.5-asr.",
      }),
      control_model: Schema.optional(ConfigModelID).annotate({
        description:
          "Model to use for voice control (multimodal) in provider/model format. Defaults to xiaomi/mimo-v2.5.",
      }),
    }),
  ).annotate({ description: "Voice input provider and model configuration." }),
  experimental: Schema.optional(
    Schema.Struct({
      disable_paste_summary: Schema.optional(Schema.Boolean),
      batch_tool: Schema.optional(Schema.Boolean).annotate({ description: "Enable the batch tool" }),
      openTelemetry: Schema.optional(Schema.Boolean).annotate({
        description: "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)",
      }),
      primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Tools that should only be available to primary agents.",
      }),
      continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
        description: "Continue the agent loop when a tool call is denied",
      }),
      try_best: Schema.optional(
        Schema.Struct({
          edit_window: Schema.optional(PositiveInt).annotate({
            description: "Recent edit events to compare (default 12).",
          }),
          edit_similarity: Schema.optional(Schema.Number).annotate({
            description: "Jaccard threshold for near-identical edit detection (default 0.8).",
          }),
          edit_matches: Schema.optional(PositiveInt).annotate({
            description: "Prior similar edits required before pausing (default 2).",
          }),
          action_streak: Schema.optional(PositiveInt).annotate({
            description: "Consecutive edit or verify actions without progress before pausing (default 4).",
          }),
        }),
      ).annotate({ description: "Try-best loop detector thresholds." }),
      mcp_timeout: Schema.optional(PositiveInt).annotate({
        description: "Timeout in milliseconds for model context protocol (MCP) requests",
      }),
      predict_next_prompt: Schema.optional(Schema.Boolean).annotate({
        description:
          "Predict the user's likely next prompt after each turn and show it as inline ghost text (Tab to accept). Enabled by default; set to false to disable.",
      }),
      maxMode: Schema.optional(
        Schema.Struct({
          candidates: Schema.optional(PositiveInt).annotate({
            description: "Number of parallel reasoning candidates per step in max mode (default 5).",
          }),
        }),
      ).annotate({
        description:
          "Max mode (experimental): the 'max' agent runs N parallel reasoning candidates each step, picks the best via a judge call, and executes only the winner.",
      }),
    }),
  ),
  workflow: Schema.optional(
    Schema.Struct({
      maxConcurrentAgents: Schema.optional(Schema.Number).annotate({
        description:
          "Process-wide ceiling on subagents running concurrently across ALL workflow runs (including nested children). Default min(16, 2x CPU cores). No upper clamp: the previous 2x-cores hard cap was removed so an operator can match real provider capacity — but that also means a misconfigured value (e.g. an extra zero) can exhaust provider rate limits or host memory. This is the only concurrency ceiling, so set it deliberately.",
      }),
      maxDepth: Schema.optional(Schema.Number).annotate({
        description: "Max nesting depth for workflow()-calls-workflow. Default 8. Exceeding it fails the run.",
      }),
      maxLifecycleAgents: Schema.optional(Schema.Number).annotate({
        description:
          "Hard ceiling on total agents a single workflow run may spawn over its life. Default 1000. Over-cap agent() calls return null (graceful degradation). PER-RUN, not tree-wide: each child workflow has its own independent budget, so a deep nesting can spawn maxDepth × this over the whole tree (concurrent in-flight is still bounded by maxConcurrentAgents).",
      }),
      scriptDeadlineMs: Schema.optional(Schema.Number).annotate({
        description:
          "Wall-clock budget for a whole workflow script, in milliseconds. Default 12h. The sandbox interrupt handler enforces this as a hard kill-switch.",
      }),
    }),
  ).annotate({ description: "Dynamic workflow runtime settings." }),
})

// Schema.Struct produces readonly types by default, but the service code
// below mutates Info objects directly (e.g. `config.mode = ...`). Strip the
// readonly recursively so callers get the same mutable shape zod inferred.
//
// `Types.DeepMutable` from effect-smol would be a drop-in, but its fallback
// branch `{ -readonly [K in keyof T]: ... }` collapses `unknown` to `{}`
// (since `keyof unknown = never`), which widens `Record<string, unknown>`
// fields like `ConfigPlugin.Options`. The local version gates on
// `extends object` so `unknown` passes through.
//
// Tuple branch preserves `ConfigPlugin.Spec`'s `readonly [string, Options]`
// shape (otherwise the general array branch widens it to an array).
type DeepMutable<T> = T extends readonly [unknown, ...unknown[]]
  ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
  : T extends readonly (infer U)[]
    ? DeepMutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
      : T

// The walker emits `z.object({...})` which is non-strict by default. Config
// historically uses `.strict()` (additionalProperties: false in openapi.json),
// so layer that on after derivation.  Re-apply the Config ref afterward
// since `.strict()` strips the walker's meta annotation.
export const Info = (zod(InfoSchema) as unknown as z.ZodObject<any>)
  .strict()
  .meta({ ref: "Config" }) as unknown as z.ZodType<DeepMutable<Schema.Schema.Type<typeof InfoSchema>>>

export type Info = z.output<typeof Info> & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
  mcp_origins?: Record<string, ConfigMCP.Origin>
}

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void, never>[]
  consoleState: ConsoleState
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<Info>
  readonly invalidate: (wait?: boolean) => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

function globalConfigFile() {
  const candidates = ["mimocode.jsonc", "mimocode.json", "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => {
    if (value === undefined) return result
    return patchJsonc(result, value, [...path, key])
  }, input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, mcp_origins: _mcp_origins, ...next } = info
  return next
}

export const ConfigDirectoryTypoError = NamedError.create(
  "ConfigDirectoryTypoError",
  z.object({
    path: z.string(),
    dir: z.string(),
    suggestion: z.string(),
  }),
)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service

    const readConfigFile = Effect.fnUntraced(function* (filepath: string) {
      return yield* fs.readFileString(filepath).pipe(
        Effect.catchIf(
          (e) => e.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
        Effect.orDie,
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options ? { text, type: "path", path: options.path } : { text, type: "virtual", ...options },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = ConfigParse.schema(Info, normalizeLoadedConfig(parsed, source), source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      if (!data.$schema || data.$schema === "https://opencode.ai/config.json") {
        data.$schema = "https://mimo.xiaomi.com/mimocode/config.json"
        const edits = modify(text, ["$schema"], "https://mimo.xiaomi.com/mimocode/config.json", {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
          isArrayInsertion: false,
        })
        if (edits.length) {
          const updated = applyEdits(text, edits)
          yield* fs.writeFileString(options.path, updated).pipe(Effect.catch(() => Effect.void))
        }
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      log.info("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath })
    })

    const loadGlobal = Effect.fnUntraced(function* () {
      let result: Info = pipe(
        {},
        mergeDeep(yield* loadFile(path.join(Global.Path.config, "config.json"))),
        mergeDeep(yield* loadFile(path.join(Global.Path.config, "mimocode.json"))),
        mergeDeep(yield* loadFile(path.join(Global.Path.config, "mimocode.jsonc"))),
      )

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              result["$schema"] = "https://mimo.xiaomi.com/mimocode/config.json"
              result = mergeDeep(result, rest)
              await fsNode.writeFile(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch(() => {}),
        )
      }

      // Seed a starter config when no global config file exists yet
      const globalConfigFile = path.join(Global.Path.config, "mimocode.jsonc")
      if (
        !existsSync(path.join(Global.Path.config, "config.json")) &&
        !existsSync(path.join(Global.Path.config, "mimocode.json")) &&
        !existsSync(globalConfigFile)
      ) {
        const starter = '{\n  "$schema": "https://mimo.xiaomi.com/mimocode/config.json"\n}\n'
        yield* fs.writeFileString(globalConfigFile, starter).pipe(Effect.catch(() => Effect.void))
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.sync(() => log.error("failed to load global config, using defaults", { error: String(error) })),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            MIMOCODE_GITIGNORE_ENTRIES.join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "MIMOCODE_CONFIG_CONTENT") return "local"
          if (yield* InstanceRef.use((ctx) => Effect.succeed(Instance.containsPath(source, ctx)))) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPlugin.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        const mergeMcpOrigins = (source: string, next: Info, type: ConfigMCP.Origin["type"]) => {
          if (!next.mcp) return
          result.mcp_origins = {
            ...(result.mcp_origins ?? {}),
            ...Object.fromEntries(Object.keys(next.mcp).map((name) => [name, { type, source }])),
          }
        }

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          mergeMcpOrigins(source, next, "opencode")
          return mergePluginOrigins(source, next.plugin, kind)
        }

        const readClaudeConfig = Effect.fnUntraced(function* (source: string) {
          const text = yield* readConfigFile(source)
          if (!text) return undefined
          return yield* Effect.try({
            try: () => JSON.parse(text) as unknown,
            catch: () => new Error(`failed to parse ${source}; Claude Code MCP compatibility skipped.`),
          }).pipe(
            Effect.tapError((error) => Effect.sync(() => log.warn(error.message))),
            Effect.option,
            Effect.map(Option.getOrUndefined),
          )
        })

        const mergeClaudeMcp = Effect.fnUntraced(function* (source: string) {
          const data = yield* readClaudeConfig(source)
          if (!isRecord(data)) return
          if (!isRecord(data.mcpServers)) return

          for (const [name, server] of Object.entries(data.mcpServers)) {
            const existing = result.mcp?.[name]
            if (existing && result.mcp_origins?.[name]?.type !== "claude") {
              log.info(`skipped Claude Code MCP server "${name}"; native opencode MCP with same name already exists.`)
              continue
            }

            const converted = ConfigMCP.fromClaude(name, server)
            if ("warning" in converted) {
              log.warn(converted.warning)
              continue
            }

            const next = ConfigParse.schema(Info, { mcp: { [name]: converted.config } }, source)
            result.mcp = {
              ...(result.mcp ?? {}),
              [name]: next.mcp![name],
            }
            result.mcp_origins = {
              ...(result.mcp_origins ?? {}),
              [name]: { type: "claude", source },
            }
          }
        })

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            process.env[value.key] = value.token
            log.debug("fetching remote config", { url: `${url}/.well-known/opencode` })
            const response = yield* Effect.promise(() =>
              fetch(`${url}/.well-known/opencode`, { signal: AbortSignal.timeout(1000) }),
            )
            if (!response.ok) {
              throw new Error(`failed to fetch remote config from ${url}: ${response.status}`)
            }
            const wellknown = (yield* Effect.promise(() => response.json())) as { config?: Record<string, unknown> }
            const remoteConfig = wellknown.config ?? {}
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://mimo.xiaomi.com/mimocode/config.json"
            const source = `${url}/.well-known/opencode`
            const next = yield* loadConfig(JSON.stringify(remoteConfig), {
              dir: path.dirname(source),
              source,
            })
            yield* merge(source, next, "global")
            log.debug("loaded remote config from well-known", { url })
          }
        }

        const global = yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (Flag.MIMOCODE_CONFIG) {
          yield* merge(Flag.MIMOCODE_CONFIG, yield* loadFile(Flag.MIMOCODE_CONFIG))
          log.debug("loaded custom config", { path: Flag.MIMOCODE_CONFIG })
        }

        if (!Flag.MIMOCODE_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("mimocode", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, yield* loadFile(file), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.MIMOCODE_CONFIG_DIR) {
          log.debug("loading config from MIMOCODE_CONFIG_DIR", { path: Flag.MIMOCODE_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void, never>[] = []

        // Load Claude Code commands first so .mimocode commands override on name collision.
        for (const dir of yield* ConfigPaths.claudeCommandDirectories(ctx.directory, ctx.worktree)) {
          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
        }

        for (const dir of directories) {
          if (dir.endsWith(".mimocode") || dir === Flag.MIMOCODE_CONFIG_DIR) {
            for (const file of ["mimocode.json", "mimocode.jsonc"]) {
              const source = path.join(dir, file)
              log.debug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source))
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          const dep = yield* npmSvc
            .install(dir, {
              add: [
                {
                  name: "@mimo-ai/plugin",
                  version: InstallationLocal ? undefined : InstallationVersion,
                },
              ],
            })
            .pipe(
              Effect.exit,
              Effect.tap((exit) =>
                Exit.isFailure(exit)
                  ? Effect.sync(() => {
                      log.warn("background dependency install failed", { dir, error: String(exit.cause) })
                    })
                  : Effect.void,
              ),
              Effect.asVoid,
              Effect.forkDetach,
            )
          deps.push(dep)

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.mimocode/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        if (process.env.MIMOCODE_CONFIG_CONTENT) {
          const source = "MIMOCODE_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.MIMOCODE_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          log.debug("loaded custom config from MIMOCODE_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              process.env["MIMOCODE_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("MIMOCODE_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(JSON.stringify(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              for (const providerID of Object.keys(next.provider ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) => {
              log.debug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              })
              return Effect.void
            }),
          )
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["mimocode.json", "mimocode.jsonc"]) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          const next = yield* loadConfig(managed.text, {
            dir: path.dirname(managed.source),
            source: managed.source,
          })
          result = mergeConfigConcatArrays(result, next)
          mergeMcpOrigins(managed.source, next, "opencode")
        }

        if (!Flag.MIMOCODE_DISABLE_CLAUDE_CODE_MCP) {
          yield* mergeClaudeMcp(path.join(Global.Path.home, ".claude.json"))
          yield* mergeClaudeMcp(path.join(ctx.directory, ".claude.json"))
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS) {
          // Allow-all base, merged UNDER user config so an explicit deny still
          // wins. Matches `mimo run --dangerously-skip-permissions`: auto-approve
          // everything not explicitly denied.
          result.permission = mergeDeep({ "*": "allow" } as ConfigPermission.Info, result.permission ?? {})
        }

        if (Flag.MIMOCODE_PERMISSION) {
          result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.MIMOCODE_PERMISSION))
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermission.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermission.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) result.username = os.userInfo().username

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        if (Flag.MIMOCODE_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.MIMOCODE_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        return {
          config: result,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(AppFileSystem.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file)
      yield* fs
        .writeFileString(file, JSON.stringify(mergeDeep(writable(existing), writable(config)), null, 2))
        .pipe(Effect.orDie)
      yield* Effect.promise(() => Instance.dispose())
    })

    const invalidate = Effect.fn("Config.invalidate")(function* (wait?: boolean) {
      yield* invalidateGlobal
      const task = Instance.disposeAll()
        .catch(() => undefined)
        .finally(() =>
          GlobalBus.emit("event", {
            directory: "global",
            payload: {
              type: Event.Disposed.type,
              properties: {},
            },
          }),
        )
      if (wait) yield* Effect.promise(() => task)
      else void task
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      const file = globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"

      let next: Info
      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.schema(Info, ConfigParse.jsonc(before, file), file)
        const merged = mergeDeep(writable(existing), writable(config))
        yield* fs.writeFileString(file, JSON.stringify(merged, null, 2)).pipe(Effect.orDie)
        next = merged
      } else {
        const updated = patchJsonc(before, writable(config))
        next = ConfigParse.schema(Info, ConfigParse.jsonc(updated, file), file)
        yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      yield* invalidate()
      return next
    })

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Account.defaultLayer),
  Layer.provide(Npm.defaultLayer),
)
