/**
 * Config 核心 Schema 定义
 *
 * 从 config.ts 分离，专注 Effect Schema 定义与类型导出。
 */

import path from "path"
import os from "os"
import z from "zod"
import { mergeDeep } from "remeda"
import { Global } from "../global"
import { Instance, type InstanceContext } from "../project/instance"
import { InstallationLocal, InstallationVersion } from "@/installation/version"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "./console-state"
import { Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { zod, ZodOverride } from "@/util/effect-zod"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigFormatter } from "./formatter"
import { ConfigHistory } from "./history"
import { ConfigLayout } from "./layout"
import { ConfigLSP } from "./lsp"
import { ConfigManaged } from "./managed"
import { ConfigMCP } from "./mcp"
import { ConfigModelID } from "./model-id"
import { ConfigParse } from "./parse"
import { ConfigPermission } from "./permission"
import { ConfigPlugin } from "./plugin"
import { ConfigProvider } from "./provider"
import { ConfigServer } from "./server"
import { ConfigSkills } from "./skills"
import { ConfigVariable } from "./variable"
import { HooksConfig } from "./hooks"
import { Log } from "../util"

const log = Log.create({ service: "config" })

export const Server = ConfigServer.Server.zod
export const Layout = ConfigLayout.Layout.zod
export type Layout = ConfigLayout.Layout

// Schemas that still live at the zod layer (have .transform / .preprocess /
// .meta not expressible in current Effect Schema) get referenced via a
// ZodOverride-annotated Schema.Any.  Walker sees the annotation and emits the
// exact zod directly, preserving component $refs.
const AgentRef = Schema.Any.annotate({ [ZodOverride]: ConfigAgent.Info })
const PermissionRef = Schema.Any.annotate({ [ZodOverride]: ConfigPermission.Info })
const HooksRef = Schema.Any.annotate({ [ZodOverride]: HooksConfig })
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
    description: "Command configuration, see https://opencode.ai/docs/commands",
  }),
  skills: Schema.optional(ConfigSkills.Info).annotate({ description: "Additional skill folder paths" }),
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
        build: Schema.optional(AgentRef),
        plan: Schema.optional(AgentRef),
        compose: Schema.optional(AgentRef),
      }),
      [Schema.Record(Schema.String, AgentRef)],
    ),
  ).annotate({
    description:
      "Agent configuration. Keys are agent names, values are agent config overrides. Use this to customize permissions, prompts, and models for any agent.",
  }),
  permission: Schema.optional(PermissionRef).annotate({
    description: "Global permission overrides applied to all agents. Supports glob patterns for files and directories.",
  }),
  model_switch_threshold: Schema.optional(Schema.Number).annotate({
    description:
      "When the current model's context has reached this ratio (0-1), the provider will attempt to switch to a model with a larger context window. Defaults to 0 during non-compacting passes and 1 during compacting passes.",
  }),
  compact_pause_threshold: Schema.optional(PositiveInt).annotate({
    description: "Number of tool calls to wait before compacting. Default: 5.",
  }),
  compact_threshold: Schema.optional(Schema.Union([Schema.Number, Schema.Literal("off")])).annotate({
    description:
      "Context window ratio (0-1) at which a compact is triggered. Also 'off' to disable auto-compact. Default: 0.9.",
  }),
  checkpoint: Schema.optional(
    Schema.Struct({
      period: Schema.optional(PositiveInt).annotate({
        description: "Number of messages between checkpoints. Default: 10.",
      }),
      memory_reconcile_on_search: Schema.optional(Schema.Boolean).annotate({
        description:
          "When true, reconciliation runs before each memory search. Disable for better search latency at the cost of staleness.",
      }),
      memory_search_score_floor: Schema.optional(Schema.Number).annotate({
        description:
          "Relative BM25 score floor (0–1) for memory search. Results below `top_score * floor` are dropped. 0 keeps all matches. Default 0.15.",
      }),
      auto_dream: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic dream runs on new session start. Default: true.",
      }),
      auto_distill: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic distill runs on new session start. Default: true.",
      }),
      include_auto_distill: Schema.optional(Schema.Boolean).annotate({
        description: "Include auto-distill output in checkpoints. Default: false.",
      }),
    }),
  ),
  terminal: Schema.optional(
    Schema.Struct({
      shell: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "Terminal preferences." }),
  custom_instructions: Schema.optional(Schema.String).annotate({
    description: "@deprecated Use the `instructions` field instead.",
  }),
  instructions: Schema.optional(Schema.String).annotate({
    description:
      "Custom instructions that define how the AI should behave. These will be appended to the system prompt as user-defined guidelines.",
  }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProvider.Info)),
  mcpServers: Schema.optional(Schema.Record(Schema.String, ConfigMCP.Info)).annotate({
    description: "Model Context Protocol server configuration",
  }),
  mcp_always_allow: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description:
      "Tools that should be automatically approved when requested through MCP. Use with caution as this bypasses permission prompts.",
  }),
  lsp: Schema.optional(ConfigLSP.Info).annotate({
    description:
      "Language server configuration per language (e.g., typescript, python). Set to true to enable default, or provide custom server configuration.",
  }),
  disabled_lsps: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Language servers to disable, e.g. ['typescript', 'python']",
  }),
  formatter: Schema.optional(ConfigFormatter.Info).annotate({
    description:
      "Formatter configuration. Set to true to enable auto-formatting, false to disable, or provide per-language formatter settings.",
  }),
  history: Schema.optional(ConfigHistory.Info).annotate({
    description:
      "History/file-based interaction mode configuration. When enabled, the agent writes commands to a history file and reads results, rather than executing tools directly.",
  }),
  theme: Schema.optional(Schema.String).annotate({
    description:
      "UI theme identifier: built-in theme name or path to a custom theme file. Defaults to 'dark'.",
  }),
  runtime: Schema.optional(
    Schema.Struct({
      preserveOutput: Schema.optional(Schema.Boolean),
    }),
  ).annotate({
    description: "Runtime environment configuration for the AI model.",
  }),
  variable: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description:
      "Custom variable definitions. Variables are substituted in prompts and commands at load time.",
  }),
  tui: Schema.optional(
    Schema.Struct({
      delay: Schema.optional(NonNegativeInt).annotate({
        description: "Delay in milliseconds between streamed tokens.",
      }),
      inlineDiff: Schema.optional(Schema.Boolean).annotate({
        description: "Show inline diffs in the TUI. Default: false.",
      }),
      diffColor: Schema.optional(Schema.String).annotate({
        description: "Override the color scheme for diffs in the TUI.",
      }),
    }),
  ).annotate({ description: "TUI-specific settings." }),
  actions: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        description: Schema.String,
        key: Schema.optional(Schema.String),
        keybinding: Schema.optional(Schema.String),
        prompt: Schema.optional(Schema.String),
        internal: Schema.optional(Schema.Boolean),
      }),
    ),
  ).annotate({ description: "Custom action definitions for the TUI" }),
  llama: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      host: Schema.optional(Schema.String),
      port: Schema.optional(NonNegativeInt),
      num_threads: Schema.optional(PositiveInt),
      n_gpu_layers: Schema.optional(NonNegativeInt),
      context_size: Schema.optional(NonNegativeInt),
      batch_size: Schema.optional(NonNegativeInt),
      keep_model_in_memory: Schema.optional(Schema.Boolean),
      flash_attn: Schema.optional(Schema.Boolean),
    }),
  ).annotate({ description: "Llama.cpp provider configuration." }),
  mistral: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      host: Schema.optional(Schema.String),
      api_key: Schema.optional(Schema.String),
      api_key_command: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "Mistral AI provider configuration. Use host to set a self-hosted endpoint." }),
  google: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      api_key: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "Google AI provider configuration." }),
  xai: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      api_key: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "xAI provider configuration." }),
  openai: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      api_key: Schema.optional(Schema.String),
      base_url: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "OpenAI provider configuration." }),
  openai_native: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      api_key: Schema.optional(Schema.String),
      oauth: Schema.optional(
        Schema.Struct({
          client_id: Schema.optional(Schema.String),
          token_endpoint: Schema.optional(Schema.String),
          audience: Schema.optional(Schema.String),
          scopes: Schema.optional(
            Schema.Struct({
              chat: Schema.optional(Schema.String),
              reasoning: Schema.optional(Schema.String),
            }),
          ),
        }),
      ),
    }),
  ).annotate({
    description:
      "OpenAI native API provider configuration. Uses chat completions endpoint with oauth. Optional oauth for authenticated requests.",
  }),
  anthropic: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      api_key: Schema.optional(Schema.String),
      base_url: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "Anthropic provider configuration." }),
  aws: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      region: Schema.optional(Schema.String),
      profile: Schema.optional(Schema.String),
      access_key_id: Schema.optional(Schema.String),
      secret_access_key: Schema.optional(Schema.String),
      session_token: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "AWS Bedrock provider configuration." }),
  gcp: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      region: Schema.optional(Schema.String),
      project_id: Schema.optional(Schema.String),
      location: Schema.optional(Schema.String),
      publisher: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "GCP Vertex AI provider configuration." }),
  azure: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      api_key: Schema.optional(Schema.String),
      resource_name: Schema.optional(Schema.String),
      deployment_id: Schema.optional(Schema.String),
      api_version: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "Azure OpenAI provider configuration." }),
  deepseek: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      api_key: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "DeepSeek provider configuration." }),
  xiaomi: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      api_key: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "Xiaomi provider configuration." }),
  jetbrains: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      host: Schema.optional(Schema.String),
      port: Schema.optional(NonNegativeInt),
    }),
  ).annotate({ description: "JetBrains provider configuration." }),
  "openai-compatible": Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      api_key: Schema.optional(Schema.String),
      base_url: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "OpenAI-compatible provider configuration." }),
  keybinds: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([
        Schema.String,
        Schema.Struct({
          key: Schema.String,
          description: Schema.optional(Schema.String),
        }),
      ]),
    ),
  ).annotate({ description: "Keyboard shortcut configuration." }),
  act: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description:
          "Auto-trigger act workflow packaging on new session start. Default: true.",
      }),
      interval_days: Schema.optional(NonNegativeInt).annotate({
        description: "Minimum days between automatic act runs. Default: 7.",
      }),
    }),
  ),
  dream: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description:
          "Auto-trigger dream workflow packaging on new session start. Default: true.",
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
  hooks: Schema.optional(HooksRef).annotate({
    description:
      "Hooks configuration for run loop lifecycle events (SessionStart, PreToolUse, PostToolUse, etc.). Each hook can run commands, prompts, or agent evaluations.",
  }),
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
  : T extends Record<string, unknown>
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T

// The walker emits `z.object({...})` which is non-strict by default. Config
// historically uses `.strict()` (additionalProperties: false in openapi.json),
// so layer that on after derivation.  Re-apply the Config ref afterward
// since `.strict()` strips the walker's meta annotation.
export const Info = (zod(InfoSchema) as unknown as z.ZodObject<any>)
  .strict()
  .meta({ ref: "Config" })
export type Info = z.output<typeof Info> & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
  mcp_origins?: Record<string, ConfigMCP.Origin>
  hooks?: z.infer<typeof HooksConfig>
}
