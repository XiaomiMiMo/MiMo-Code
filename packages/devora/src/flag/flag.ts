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

const DEVORA_EXPERIMENTAL = truthy("DEVORA_EXPERIMENTAL")

// Defaults to false. When enabled, devora runs in pure-devora mode:
//   — does NOT inherit Claude Code's settings (CLAUDE.md, ~/.claude/skills, etc.)
//   — does NOT pick up provider API keys from environment variables
//   — falls back to the devora-auto model as the default
// Set DEVORA_DEVORA_ONLY=true to disable .claude inheritance and env-based
// provider auto-detection.
const DEVORA_DEVORA_ONLY = truthy("DEVORA_DEVORA_ONLY")
const DEVORA_DISABLE_CLAUDE_CODE_ENV = truthy("DEVORA_DISABLE_CLAUDE_CODE")
const DEVORA_DISABLE_CLAUDE_CODE = DEVORA_DEVORA_ONLY || DEVORA_DISABLE_CLAUDE_CODE_ENV

const DEVORA_DISABLE_EXTERNAL_SKILLS = truthy("DEVORA_DISABLE_EXTERNAL_SKILLS")
const DEVORA_DISABLE_CLAUDE_CODE_SKILLS =
  DEVORA_DISABLE_EXTERNAL_SKILLS || DEVORA_DISABLE_CLAUDE_CODE || truthy("DEVORA_DISABLE_CLAUDE_CODE_SKILLS")
const copy = process.env["DEVORA_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  DEVORA_AUTO_SHARE: truthy("DEVORA_AUTO_SHARE"),
  DEVORA_AUTO_HEAP_SNAPSHOT: truthy("DEVORA_AUTO_HEAP_SNAPSHOT"),
  DEVORA_GIT_BASH_PATH: process.env["DEVORA_GIT_BASH_PATH"],
  DEVORA_CONFIG: process.env["DEVORA_CONFIG"],
  DEVORA_CONFIG_CONTENT: process.env["DEVORA_CONFIG_CONTENT"],

  DEVORA_DISABLE_AUTOUPDATE: truthy("DEVORA_DISABLE_AUTOUPDATE"),

  // Defaults to true (analytics enabled). Set DEVORA_ENABLE_ANALYSIS=false
  // to opt out of POSTing model_call/tool_call/agent_request metrics.
  DEVORA_ENABLE_ANALYSIS: !falsy("DEVORA_ENABLE_ANALYSIS"),
  DEVORA_ALWAYS_NOTIFY_UPDATE: truthy("DEVORA_ALWAYS_NOTIFY_UPDATE"),
  DEVORA_DISABLE_PRUNE: truthy("DEVORA_DISABLE_PRUNE"),
  DEVORA_DISABLE_TERMINAL_TITLE: truthy("DEVORA_DISABLE_TERMINAL_TITLE"),
  DEVORA_SHOW_TTFD: truthy("DEVORA_SHOW_TTFD"),
  DEVORA_PERMISSION: process.env["DEVORA_PERMISSION"],
  DEVORA_DISABLE_DEFAULT_PLUGINS: truthy("DEVORA_DISABLE_DEFAULT_PLUGINS"),
  DEVORA_DISABLE_LSP_DOWNLOAD: truthy("DEVORA_DISABLE_LSP_DOWNLOAD"),
  DEVORA_ENABLE_EXPERIMENTAL_MODELS: truthy("DEVORA_ENABLE_EXPERIMENTAL_MODELS"),
  DEVORA_DISABLE_AUTOCOMPACT: truthy("DEVORA_DISABLE_AUTOCOMPACT"),
  DEVORA_DISABLE_MODELS_FETCH: truthy("DEVORA_DISABLE_MODELS_FETCH"),
  DEVORA_DISABLE_MOUSE: truthy("DEVORA_DISABLE_MOUSE"),
  DEVORA_OUTPUT_LENGTH_CONTINUATION_LIMIT: number("DEVORA_OUTPUT_LENGTH_CONTINUATION_LIMIT") ?? 3,
  DEVORA_INVALID_OUTPUT_CONTINUATION_LIMIT: number("DEVORA_INVALID_OUTPUT_CONTINUATION_LIMIT") ?? 2,

  // Caps applied to image attachments before a prompt is sent. Both default to
  // undefined (no limit). DEVORA_MAX_PROMPT_IMAGES bounds how many images may
  // be sent per request (oldest excess images are dropped); DEVORA_MAX_PROMPT_IMAGE_SIZE
  // bounds the decoded byte size of a single image. Values must be positive integers.
  DEVORA_MAX_PROMPT_IMAGES: number("DEVORA_MAX_PROMPT_IMAGES"),
  DEVORA_MAX_PROMPT_IMAGE_SIZE: number("DEVORA_MAX_PROMPT_IMAGE_SIZE"),
  DEVORA_DEVORA_ONLY,
  DEVORA_DISABLE_PROVIDER_ENV: DEVORA_DEVORA_ONLY || truthy("DEVORA_DISABLE_PROVIDER_ENV"),
  DEVORA_DISABLE_CLAUDE_CODE,
  get DEVORA_DISABLE_CLAUDE_CODE_MCP() {
    // MCP compatibility stays on in devora-only mode so users can reuse Claude Code
    // MCP servers without inheriting prompts, skills, or provider env keys.
    return DEVORA_DISABLE_CLAUDE_CODE_ENV || truthy("DEVORA_DISABLE_CLAUDE_CODE_MCP")
  },
  DEVORA_DISABLE_CLAUDE_CODE_PROMPT: DEVORA_DISABLE_CLAUDE_CODE || truthy("DEVORA_DISABLE_CLAUDE_CODE_PROMPT"),
  // Defaults to false (enabled): markdown commands under ~/.claude/commands and
  // {project}/.claude/commands load as slash commands. Independent of the
  // devora-only master switch. Set DEVORA_DISABLE_CLAUDE_CODE_COMMANDS=true to disable.
  DEVORA_DISABLE_CLAUDE_CODE_COMMANDS: truthy("DEVORA_DISABLE_CLAUDE_CODE_COMMANDS"),
  DEVORA_DISABLE_CLAUDE_CODE_SKILLS,
  DEVORA_DISABLE_EXTERNAL_SKILLS,
  DEVORA_DISABLE_CODEX_SKILLS: DEVORA_DISABLE_EXTERNAL_SKILLS || truthy("DEVORA_DISABLE_CODEX_SKILLS"),
  DEVORA_DISABLE_DEVORA_SKILLS: DEVORA_DISABLE_EXTERNAL_SKILLS || truthy("DEVORA_DISABLE_DEVORA_SKILLS"),
  DEVORA_FAKE_VCS: process.env["DEVORA_FAKE_VCS"],

  // When enabled, skips all git subprocess calls during project discovery
  // (which git, rev-parse --git-common-dir, rev-parse --show-toplevel) and
  // branch detection. The project is treated as a non-git directory rooted at
  // the working directory. Use to avoid touching git in restricted/sandboxed
  // environments or where git startup probing is undesirable.
  DEVORA_DISABLE_GIT: truthy("DEVORA_DISABLE_GIT"),
  DEVORA_SERVER_PASSWORD: process.env["DEVORA_SERVER_PASSWORD"],
  DEVORA_SERVER_USERNAME: process.env["DEVORA_SERVER_USERNAME"],
  DEVORA_ENABLE_QUESTION_TOOL: truthy("DEVORA_ENABLE_QUESTION_TOOL"),

  // Experimental
  DEVORA_EXPERIMENTAL,
  DEVORA_EXPERIMENTAL_FILEWATCHER: Config.boolean("DEVORA_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  DEVORA_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("DEVORA_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  DEVORA_EXPERIMENTAL_ICON_DISCOVERY: DEVORA_EXPERIMENTAL || truthy("DEVORA_EXPERIMENTAL_ICON_DISCOVERY"),
  DEVORA_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("DEVORA_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  DEVORA_ENABLE_EXA: truthy("DEVORA_ENABLE_EXA") || DEVORA_EXPERIMENTAL || truthy("DEVORA_EXPERIMENTAL_EXA"),
  DEVORA_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: number("DEVORA_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  DEVORA_EXPERIMENTAL_OUTPUT_TOKEN_MAX: number("DEVORA_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  DEVORA_EXPERIMENTAL_OXFMT: DEVORA_EXPERIMENTAL || truthy("DEVORA_EXPERIMENTAL_OXFMT"),
  DEVORA_EXPERIMENTAL_LSP_TY: truthy("DEVORA_EXPERIMENTAL_LSP_TY"),
  DEVORA_EXPERIMENTAL_LSP_TOOL: DEVORA_EXPERIMENTAL || truthy("DEVORA_EXPERIMENTAL_LSP_TOOL"),
  DEVORA_EXPERIMENTAL_WORKFLOW_TOOL: DEVORA_EXPERIMENTAL || truthy("DEVORA_EXPERIMENTAL_WORKFLOW_TOOL"),
  DEVORA_EXPERIMENTAL_MARKDOWN: !falsy("DEVORA_EXPERIMENTAL_MARKDOWN"),
  DEVORA_MODELS_URL: process.env["DEVORA_MODELS_URL"],
  DEVORA_MODELS_PATH: process.env["DEVORA_MODELS_PATH"],
  DEVORA_DISABLE_EMBEDDED_WEB_UI: truthy("DEVORA_DISABLE_EMBEDDED_WEB_UI"),
  DEVORA_DB: process.env["DEVORA_DB"],

  // Defaults to true — all channels share a single devora.db. The per-channel
  // DB isolation (devora-{channel}.db) is unnecessary for devora since we
  // don't ship multiple release channels yet. Use DEVORA_HOME to isolate dev
  // environments instead. Set DEVORA_DISABLE_CHANNEL_DB=false to restore
  // per-channel isolation.
  DEVORA_DISABLE_CHANNEL_DB: !falsy("DEVORA_DISABLE_CHANNEL_DB"),
  DEVORA_SKIP_MIGRATIONS: truthy("DEVORA_SKIP_MIGRATIONS"),
  DEVORA_STRICT_CONFIG_DEPS: truthy("DEVORA_STRICT_CONFIG_DEPS"),

  DEVORA_WORKSPACE_ID: process.env["DEVORA_WORKSPACE_ID"],
  DEVORA_EXPERIMENTAL_HTTPAPI: truthy("DEVORA_EXPERIMENTAL_HTTPAPI"),
  DEVORA_EXPERIMENTAL_WORKSPACES: DEVORA_EXPERIMENTAL || truthy("DEVORA_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get DEVORA_DISABLE_COMPOSE_SKILLS() {
    return truthy("DEVORA_DISABLE_COMPOSE_SKILLS")
  },
  get DEVORA_DISABLE_PROJECT_CONFIG() {
    return truthy("DEVORA_DISABLE_PROJECT_CONFIG")
  },
  get DEVORA_TUI_CONFIG() {
    return process.env["DEVORA_TUI_CONFIG"]
  },
  get DEVORA_CONFIG_DIR() {
    return process.env["DEVORA_CONFIG_DIR"]
  },
  get DEVORA_HOME() {
    return process.env["DEVORA_HOME"]
  },
  get DEVORA_PURE() {
    return truthy("DEVORA_PURE")
  },
  get DEVORA_PLUGIN_META_FILE() {
    return process.env["DEVORA_PLUGIN_META_FILE"]
  },
  get DEVORA_CLIENT() {
    return process.env["DEVORA_CLIENT"] ?? "cli"
  },
}
