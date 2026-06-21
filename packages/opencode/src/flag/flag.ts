import { Config } from "effect"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

function number(key: string) {
  const value = process.env[key]
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

const MIMOCODE_EXPERIMENTAL = truthy("MIMOCODE_EXPERIMENTAL")

// Defaults to false. When enabled, mimocode runs in pure-mimo mode:
//   — does NOT inherit Claude Code's settings (CLAUDE.md, ~/.claude/skills, etc.)
//   — does NOT pick up provider API keys from environment variables
//   — falls back to the mimo-auto model as the default
// Set MIMOCODE_MIMO_ONLY=true to disable .claude inheritance and env-based
// provider auto-detection.
const MIMOCODE_MIMO_ONLY = truthy("MIMOCODE_MIMO_ONLY")
const MIMOCODE_DISABLE_CLAUDE_CODE_ENV = truthy("MIMOCODE_DISABLE_CLAUDE_CODE")
const MIMOCODE_DISABLE_CLAUDE_CODE = MIMOCODE_MIMO_ONLY || MIMOCODE_DISABLE_CLAUDE_CODE_ENV

const MIMOCODE_DISABLE_EXTERNAL_SKILLS = truthy("MIMOCODE_DISABLE_EXTERNAL_SKILLS")
const MIMOCODE_DISABLE_CLAUDE_CODE_SKILLS =
  MIMOCODE_DISABLE_EXTERNAL_SKILLS || MIMOCODE_DISABLE_CLAUDE_CODE || truthy("MIMOCODE_DISABLE_CLAUDE_CODE_SKILLS")
const copy = process.env["MIMOCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  MIMOCODE_AUTO_SHARE: truthy("MIMOCODE_AUTO_SHARE"),
  MIMOCODE_AUTO_HEAP_SNAPSHOT: truthy("MIMOCODE_AUTO_HEAP_SNAPSHOT"),
  MIMOCODE_GIT_BASH_PATH: process.env["MIMOCODE_GIT_BASH_PATH"],
  MIMOCODE_CONFIG: process.env["MIMOCODE_CONFIG"],
  MIMOCODE_CONFIG_CONTENT: process.env["MIMOCODE_CONFIG_CONTENT"],

  MIMOCODE_DISABLE_AUTOUPDATE: truthy("MIMOCODE_DISABLE_AUTOUPDATE"),

  // Defaults to false (rotation enabled). When enabled, the active log file is
  // never archived to <name>.log.<stamp> on hitting MAX_FILE_SIZE — it grows in
  // place. Useful when an external tool tails/manages the single log file.
  MIMOCODE_DISABLE_LOG_ROTATION: truthy("MIMOCODE_DISABLE_LOG_ROTATION"),

  // Defaults to true (analytics enabled). Set MIMOCODE_ENABLE_ANALYSIS=false
  // to opt out of POSTing model_call/tool_call/agent_request metrics.
  MIMOCODE_ENABLE_ANALYSIS: !falsy("MIMOCODE_ENABLE_ANALYSIS"),
  MIMOCODE_ALWAYS_NOTIFY_UPDATE: truthy("MIMOCODE_ALWAYS_NOTIFY_UPDATE"),
  MIMOCODE_DISABLE_PRUNE: truthy("MIMOCODE_DISABLE_PRUNE"),
  MIMOCODE_DISABLE_TERMINAL_TITLE: truthy("MIMOCODE_DISABLE_TERMINAL_TITLE"),
  MIMOCODE_SHOW_TTFD: truthy("MIMOCODE_SHOW_TTFD"),
  MIMOCODE_PERMISSION: process.env["MIMOCODE_PERMISSION"],
  MIMOCODE_DISABLE_DEFAULT_PLUGINS: truthy("MIMOCODE_DISABLE_DEFAULT_PLUGINS"),
  MIMOCODE_DISABLE_LSP_DOWNLOAD: truthy("MIMOCODE_DISABLE_LSP_DOWNLOAD"),
  MIMOCODE_ENABLE_EXPERIMENTAL_MODELS: truthy("MIMOCODE_ENABLE_EXPERIMENTAL_MODELS"),
  MIMOCODE_DISABLE_AUTOCOMPACT: truthy("MIMOCODE_DISABLE_AUTOCOMPACT"),
  MIMOCODE_DISABLE_MODELS_FETCH: truthy("MIMOCODE_DISABLE_MODELS_FETCH"),
  MIMOCODE_DISABLE_MOUSE: truthy("MIMOCODE_DISABLE_MOUSE"),
  MIMOCODE_OUTPUT_LENGTH_CONTINUATION_LIMIT: number("MIMOCODE_OUTPUT_LENGTH_CONTINUATION_LIMIT") ?? 3,
  MIMOCODE_INVALID_OUTPUT_CONTINUATION_LIMIT: number("MIMOCODE_INVALID_OUTPUT_CONTINUATION_LIMIT") ?? 2,

  // Sliding-window n-gram repetition detection for streamed reasoning + text.
  // An n-gram of size N appearing REPEAT_THRESHOLD times within the last
  // WINDOW_TOKENS tokens triggers recovery (remind → replan → terminate).
  MIMOCODE_TEXT_NGRAM_N: number("MIMOCODE_TEXT_NGRAM_N") ?? 6,
  MIMOCODE_TEXT_REPEAT_THRESHOLD: number("MIMOCODE_TEXT_REPEAT_THRESHOLD") ?? 3,
  MIMOCODE_TEXT_WINDOW_TOKENS: number("MIMOCODE_TEXT_WINDOW_TOKENS") ?? 500,

  // Caps applied to image attachments before a prompt is sent. Both default to
  // undefined (no limit). MIMOCODE_MAX_PROMPT_IMAGES bounds how many images may
  // be sent per request (oldest excess images are dropped); MIMOCODE_MAX_PROMPT_IMAGE_SIZE
  // bounds the decoded byte size of a single image. Values must be positive integers.
  MIMOCODE_MAX_PROMPT_IMAGES: number("MIMOCODE_MAX_PROMPT_IMAGES"),
  MIMOCODE_MAX_PROMPT_IMAGE_SIZE: number("MIMOCODE_MAX_PROMPT_IMAGE_SIZE"),
  MIMOCODE_MIMO_ONLY,
  MIMOCODE_DISABLE_PROVIDER_ENV: MIMOCODE_MIMO_ONLY || truthy("MIMOCODE_DISABLE_PROVIDER_ENV"),
  MIMOCODE_DISABLE_CLAUDE_CODE,
  get MIMOCODE_DISABLE_CLAUDE_CODE_MCP() {
    // MCP compatibility stays on in mimo-only mode so users can reuse Claude Code
    // MCP servers without inheriting prompts, skills, or provider env keys.
    return MIMOCODE_DISABLE_CLAUDE_CODE_ENV || truthy("MIMOCODE_DISABLE_CLAUDE_CODE_MCP")
  },
  MIMOCODE_DISABLE_CLAUDE_CODE_PROMPT: MIMOCODE_DISABLE_CLAUDE_CODE || truthy("MIMOCODE_DISABLE_CLAUDE_CODE_PROMPT"),
  // Defaults to false (enabled): markdown commands under ~/.claude/commands and
  // {project}/.claude/commands load as slash commands. Independent of the
  // mimo-only master switch. Set MIMOCODE_DISABLE_CLAUDE_CODE_COMMANDS=true to disable.
  MIMOCODE_DISABLE_CLAUDE_CODE_COMMANDS: truthy("MIMOCODE_DISABLE_CLAUDE_CODE_COMMANDS"),
  MIMOCODE_DISABLE_CLAUDE_CODE_SKILLS,
  MIMOCODE_DISABLE_EXTERNAL_SKILLS,
  MIMOCODE_DISABLE_CODEX_SKILLS: MIMOCODE_DISABLE_EXTERNAL_SKILLS || truthy("MIMOCODE_DISABLE_CODEX_SKILLS"),
  MIMOCODE_DISABLE_OPENCODE_SKILLS: MIMOCODE_DISABLE_EXTERNAL_SKILLS || truthy("MIMOCODE_DISABLE_OPENCODE_SKILLS"),
  MIMOCODE_FAKE_VCS: process.env["MIMOCODE_FAKE_VCS"],

  // When enabled, skips all git subprocess calls during project discovery
  // (which git, rev-parse --git-common-dir, rev-parse --show-toplevel) and
  // branch detection. The project is treated as a non-git directory rooted at
  // the working directory. Use to avoid touching git in restricted/sandboxed
  // environments or where git startup probing is undesirable.
  MIMOCODE_DISABLE_GIT: truthy("MIMOCODE_DISABLE_GIT"),
  MIMOCODE_SERVER_PASSWORD: process.env["MIMOCODE_SERVER_PASSWORD"],
  MIMOCODE_SERVER_USERNAME: process.env["MIMOCODE_SERVER_USERNAME"],
  MIMOCODE_ENABLE_QUESTION_TOOL: truthy("MIMOCODE_ENABLE_QUESTION_TOOL"),

  // Experimental
  MIMOCODE_EXPERIMENTAL,
  MIMOCODE_EXPERIMENTAL_FILEWATCHER: Config.boolean("MIMOCODE_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  MIMOCODE_EXPERIMENTAL_ICON_DISCOVERY: MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_ICON_DISCOVERY"),
  MIMOCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("MIMOCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  MIMOCODE_ENABLE_EXA: truthy("MIMOCODE_ENABLE_EXA") || MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_EXA"),
  MIMOCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: number("MIMOCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  MIMOCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: number("MIMOCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  MIMOCODE_EXPERIMENTAL_OXFMT: MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_OXFMT"),
  MIMOCODE_EXPERIMENTAL_LSP_TY: truthy("MIMOCODE_EXPERIMENTAL_LSP_TY"),
  MIMOCODE_EXPERIMENTAL_LSP_TOOL: MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_LSP_TOOL"),
  // Defaults to true: dynamic workflow + built-in deep-research are on by default.
  // Set MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL=false to opt out. The env-var name is
  // kept for backwards compat (long-running experiments still pass it as `1`).
  MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL: !falsy("MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL"),
  MIMOCODE_EXPERIMENTAL_MARKDOWN: !falsy("MIMOCODE_EXPERIMENTAL_MARKDOWN"),
  MIMOCODE_MODELS_URL: process.env["MIMOCODE_MODELS_URL"],
  MIMOCODE_MODELS_PATH: process.env["MIMOCODE_MODELS_PATH"],
  MIMOCODE_DISABLE_EMBEDDED_WEB_UI: truthy("MIMOCODE_DISABLE_EMBEDDED_WEB_UI"),
  MIMOCODE_DB: process.env["MIMOCODE_DB"],

  // Defaults to true — all channels share a single mimocode.db. The per-channel
  // DB isolation (mimocode-{channel}.db) is unnecessary for mimocode since we
  // don't ship multiple release channels yet. Use MIMOCODE_HOME to isolate dev
  // environments instead. Set MIMOCODE_DISABLE_CHANNEL_DB=false to restore
  // per-channel isolation.
  MIMOCODE_DISABLE_CHANNEL_DB: !falsy("MIMOCODE_DISABLE_CHANNEL_DB"),
  MIMOCODE_SKIP_MIGRATIONS: truthy("MIMOCODE_SKIP_MIGRATIONS"),
  MIMOCODE_STRICT_CONFIG_DEPS: truthy("MIMOCODE_STRICT_CONFIG_DEPS"),

  MIMOCODE_WORKSPACE_ID: process.env["MIMOCODE_WORKSPACE_ID"],
  MIMOCODE_EXPERIMENTAL_HTTPAPI: truthy("MIMOCODE_EXPERIMENTAL_HTTPAPI"),
  MIMOCODE_EXPERIMENTAL_WORKSPACES: MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get MIMOCODE_DISABLE_COMPOSE_SKILLS() {
    return truthy("MIMOCODE_DISABLE_COMPOSE_SKILLS")
  },
  get MIMOCODE_DISABLE_PROJECT_CONFIG() {
    return truthy("MIMOCODE_DISABLE_PROJECT_CONFIG")
  },
  get MIMOCODE_TUI_CONFIG() {
    return process.env["MIMOCODE_TUI_CONFIG"]
  },
  get MIMOCODE_CONFIG_DIR() {
    return process.env["MIMOCODE_CONFIG_DIR"]
  },
  get MIMOCODE_HOME() {
    return process.env["MIMOCODE_HOME"]
  },
  get MIMOCODE_PURE() {
    return truthy("MIMOCODE_PURE")
  },
  get MIMOCODE_PLUGIN_META_FILE() {
    return process.env["MIMOCODE_PLUGIN_META_FILE"]
  },
  get MIMOCODE_CLIENT() {
    return process.env["MIMOCODE_CLIENT"] ?? "cli"
  },
}
