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

function nonNegativeNumber(key: string) {
  const value = process.env[key]
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
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

/**
 * Password for a listener nobody asked for, held in memory only.
 *
 * Opening a socket makes every instance route reachable by any process running as
 * this user — `/file` reads and writes the project, `/pty` and `/bash-interactive`
 * run commands. The token-authenticated `/v1` routes are carved out of basic auth on
 * purpose (see `server/middleware.ts`), so generating this closes everything else
 * without closing the surface the listener exists for.
 */
let generatedServerPassword: string | undefined

/**
 * Generate the password for an implicit listener, once.
 *
 * Idempotent: a second listener in the same process must not invalidate the
 * credential the first one is already authenticating against. A user-supplied
 * password always wins, and in that case nothing is generated at all — the operator
 * has already said what auth should be.
 */
export function generateServerPassword() {
  if (process.env["MIMOCODE_SERVER_PASSWORD"]) return
  generatedServerPassword ??= Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
}

/**
 * Disarm the generated password once its listener is gone.
 *
 * A credential outliving the socket it was minted for is state with no owner: nothing can
 * present it any more, but every in-process request still has to satisfy it. Clearing it
 * belongs with `stop()` for the same reason unpublishing the address does.
 */
export function clearGeneratedServerPassword() {
  generatedServerPassword = undefined
}

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

  // Defaults to false. When false, the bash tool intercepts irreversible
  // deletion commands (rm, rmdir, unlink, shred, del, erase, rd, remove-item,
  // and git destructive subcommands like reset --hard / clean -f / branch -D /
  // worktree remove / push --force / stash drop|clear / tag -d) and forces an
  // extra permission prompt with permission="bash_delete" — separate from the
  // normal bash-permission ask so it can't be silently pre-approved by a broad
  // `bash: allow` rule. Set MIMOCODE_AUTO_APPROVE_DELETE=true to trust the
  // model with deletes and skip the second confirmation.
  // Read lazily (getter, not an eagerly-evaluated literal) so an embedder can
  // flip it at runtime: the desktop app runs the server in-process, so its
  // approval mode — switchable mid-session, like the TUI's /skip-permissions —
  // has no process boundary at which to re-read env. A literal would freeze
  // this at module-evaluation time and make every later write a no-op.
  get MIMOCODE_AUTO_APPROVE_DELETE() {
    return truthy("MIMOCODE_AUTO_APPROVE_DELETE")
  },
  // Set by the TUI's --dangerously-skip-permissions flag. When truthy, an
  // allow-all base ruleset is injected UNDER the user's config permission so
  // every tool auto-approves unless the user explicitly denied it.
  MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS: truthy("MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS"),
  MIMOCODE_DISABLE_DEFAULT_PLUGINS: truthy("MIMOCODE_DISABLE_DEFAULT_PLUGINS"),
  MIMOCODE_DISABLE_LSP_DOWNLOAD: truthy("MIMOCODE_DISABLE_LSP_DOWNLOAD"),
  MIMOCODE_ENABLE_EXPERIMENTAL_MODELS: truthy("MIMOCODE_ENABLE_EXPERIMENTAL_MODELS"),
  // Defaults to false. When enabled, checkpoint writers, checkpoint-based
  // context rebuilds, and checkpoint copy in the system prompt and tool
  // schemas are disabled; context overflow falls back to compaction.
  // Read lazily so tests and in-process embedders can toggle it at runtime.
  get MIMOCODE_DISABLE_CHECKPOINT() {
    return truthy("MIMOCODE_DISABLE_CHECKPOINT")
  },
  MIMOCODE_DISABLE_AUTOCOMPACT: truthy("MIMOCODE_DISABLE_AUTOCOMPACT"),
  MIMOCODE_DISABLE_MODELS_FETCH: truthy("MIMOCODE_DISABLE_MODELS_FETCH"),
  // Defaults to false. When enabled, every model uses the GPT system prompt
  // and Codex toolset regardless of its model ID.
  get MIMOCODE_CODEX_MODE() {
    return truthy("MIMOCODE_CODEX_MODE")
  },
  MIMOCODE_DISABLE_MOUSE: truthy("MIMOCODE_DISABLE_MOUSE"),
  MIMOCODE_OUTPUT_LENGTH_CONTINUATION_LIMIT: number("MIMOCODE_OUTPUT_LENGTH_CONTINUATION_LIMIT") ?? 3,
  MIMOCODE_INVALID_OUTPUT_CONTINUATION_LIMIT: number("MIMOCODE_INVALID_OUTPUT_CONTINUATION_LIMIT") ?? 2,
  MIMOCODE_TEXT_TOOL_CALL_RETRY_LIMIT: number("MIMOCODE_TEXT_TOOL_CALL_RETRY_LIMIT") ?? 2,
  // Defaults to false. When enabled, unsigned historical reasoning sent through
  // the Anthropic Messages format receives an empty placeholder signature so it
  // follows the same native thinking-block serialization path as signed content.
  get MIMOCODE_FORCE_ANTHROPIC_REASONING_CONTENT() {
    return truthy("MIMOCODE_FORCE_ANTHROPIC_REASONING_CONTENT")
  },

  // Consecutive-block repetition detection for streamed reasoning + text.
  // A block of at least N tokens repeating REPEAT_THRESHOLD times consecutively
  // within the last WINDOW_TOKENS tokens triggers recovery (remind → replan → terminate).
  MIMOCODE_TEXT_NGRAM_N: number("MIMOCODE_TEXT_NGRAM_N") ?? 4,
  MIMOCODE_TEXT_REPEAT_THRESHOLD: number("MIMOCODE_TEXT_REPEAT_THRESHOLD") ?? 20,
  MIMOCODE_TEXT_WINDOW_TOKENS: number("MIMOCODE_TEXT_WINDOW_TOKENS") ?? 500,

  // Caps applied to image attachments before a prompt is sent.
  // MIMOCODE_MAX_PROMPT_IMAGES (default undefined = no count limit) bounds how
  // many images may be sent per request (oldest excess images are dropped).
  // MIMOCODE_MAX_PROMPT_IMAGE_SIZE overrides the default per-image byte cap
  // (DEFAULT_MAX_IMAGE_BYTES ~4.5 MB, kept under the provider 5 MB hard limit);
  // oversized images are recompressed under the cap, or stripped to a text
  // placeholder when they can't be compressed. Values must be positive integers.
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
  MIMOCODE_DISABLE_AGENTS_SKILLS: MIMOCODE_DISABLE_EXTERNAL_SKILLS || truthy("MIMOCODE_DISABLE_AGENTS_SKILLS"),
  MIMOCODE_DISABLE_CODEX_SKILLS: MIMOCODE_DISABLE_EXTERNAL_SKILLS || truthy("MIMOCODE_DISABLE_CODEX_SKILLS"),
  MIMOCODE_DISABLE_OPENCODE_SKILLS: MIMOCODE_DISABLE_EXTERNAL_SKILLS || truthy("MIMOCODE_DISABLE_OPENCODE_SKILLS"),

  // Skill-search ranking and loading policy. Exact mentions stay above BM25;
  // the BM25/coverage blend has a 0.90 ceiling, and near-max results auto-load.
  MIMOCODE_SKILL_SEARCH_EXACT_SCORE: 1,
  MIMOCODE_SKILL_SEARCH_BM25_K1: 1.5,
  MIMOCODE_SKILL_SEARCH_BM25_LENGTH_NORMALIZATION: 0.75,
  MIMOCODE_SKILL_SEARCH_BM25_IDF_SMOOTHING: 0.5,
  MIMOCODE_SKILL_SEARCH_BM25_SCORE_WEIGHT: 0.55,
  MIMOCODE_SKILL_SEARCH_QUERY_COVERAGE_WEIGHT: 0.35,
  MIMOCODE_SKILL_SEARCH_AUTO_LOAD_THRESHOLD: 0.85,
  MIMOCODE_SKILL_SEARCH_SCORE_PRECISION: 4,
  MIMOCODE_SKILL_SEARCH_MAX_RESULTS: 3,
  MIMOCODE_SKILL_SEARCH_STEM_MIN_LENGTH: 3,
  MIMOCODE_SKILL_SEARCH_FILE_SAMPLE_LIMIT: 10,

  // Defaults to false. When enabled, skill-source commands appear in the `/`
  // autocomplete dropdown alongside user commands and MCP prompts. Skills are
  // surfaced in `/` completion by default; set MIMOCODE_DISABLE_SLASH_SKILLS=1
  // to hide them and fall back to the `/skills` picker + model-driven
  // invocation only.
  MIMOCODE_DISABLE_SLASH_SKILLS: truthy("MIMOCODE_DISABLE_SLASH_SKILLS"),
  MIMOCODE_FAKE_VCS: process.env["MIMOCODE_FAKE_VCS"],

  // When enabled, skips all git subprocess calls during project discovery
  // (which git, rev-parse --git-common-dir, rev-parse --show-toplevel) and
  // branch detection. The project is treated as a non-git directory rooted at
  // the working directory. Use to avoid touching git in restricted/sandboxed
  // environments or where git startup probing is undesirable.
  MIMOCODE_DISABLE_GIT: truthy("MIMOCODE_DISABLE_GIT"),

  /**
   * The password every non-`/v1` route is authenticated against.
   *
   * A getter rather than a snapshot, because a listener the user did not ask for
   * generates one at bind time (see `generateServerPassword`). The generated value
   * is deliberately NOT written to `process.env`: every child we spawn inherits the
   * environment, and a subprocess is supposed to hold a scoped task token, never the
   * credential that opens the whole instance API.
   */
  get MIMOCODE_SERVER_PASSWORD() {
    return process.env["MIMOCODE_SERVER_PASSWORD"] || generatedServerPassword
  },
  /**
   * Did the OPERATOR configure auth, as opposed to us generating a password for a
   * listener we opened on our own initiative?
   *
   * The difference is load-bearing for `InstanceMiddleware`: a user-secured server is
   * allowed to serve directories outside its cwd (the desktop engine does exactly
   * that), while an implicit listener must stay pinned to one project no matter what
   * credential guards it.
   */
  get MIMOCODE_SERVER_PASSWORD_SUPPLIED() {
    return Boolean(process.env["MIMOCODE_SERVER_PASSWORD"])
  },
  MIMOCODE_SERVER_USERNAME: process.env["MIMOCODE_SERVER_USERNAME"],
  MIMOCODE_ENABLE_QUESTION_TOOL: truthy("MIMOCODE_ENABLE_QUESTION_TOOL"),

  // Defaults to false. Set MIMOCODE_ENABLE_TRY_BEST_HANDOFF=true (or 1) to
  // enable try-best loop detection, automatic turn pausing, and handoff UI.
  MIMOCODE_ENABLE_TRY_BEST_HANDOFF: truthy("MIMOCODE_ENABLE_TRY_BEST_HANDOFF"),

  // Defaults to false. Opt in to append runtime-derived environment and
  // instruction-file content to the model's system prompt.
  get MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT() {
    return truthy("MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT")
  },

  // Defaults to false. The edit tool does pure exact-string matching with
  // explicit error signals. Set MIMOCODE_ENABLE_FUZZY_EDIT=true to opt into the
  // legacy multi-stage fuzzy fallback chain (line-trimmed / block-anchor /
  // whitespace-normalized / indentation-flexible / etc.) when old_string fails
  // to match exactly.
  MIMOCODE_ENABLE_FUZZY_EDIT: truthy("MIMOCODE_ENABLE_FUZZY_EDIT"),

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
  // Token-efficient post-cleanse: strip ANSI / fold \r progress bars / redact
  // secrets / elide super-long lines from bash tool output before it is
  // returned to the model. Only applies when the output fits inline — if the
  // output spills to a truncation file, cleaning is skipped so the on-disk
  // archive stays raw. Off by default. Set to 1/true to opt in.
  MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY: truthy("MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY"),
  // Tunables for the token-efficient post-cleanse pipeline (see
  // src/tool/bash_token_efficient_pipeline.ts). Positive integers only;
  // unset / non-positive values fall back to the documented defaults.
  //   MAX_LINE_CHARS   threshold above which a single line is elided  (default 500)
  //   LINE_HEAD_KEEP   chars kept from the head of an elided line     (default 160)
  //   NEVER_WORSE_MARGIN  bytes the cleaned output must beat the raw  (default 0)
  MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_MAX_LINE_CHARS: number("MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_MAX_LINE_CHARS") ?? 500,
  MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_LINE_HEAD_KEEP: number("MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_LINE_HEAD_KEEP") ?? 160,
  MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_NEVER_WORSE_MARGIN: number("MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_NEVER_WORSE_MARGIN") ?? 0,
  // Heuristic (shape-based) filter pipeline for bash output. Runs AFTER the
  // common pipeline, only when the common pipeline is enabled AND this flag is
  // explicitly opted in. Each shape (gitdiff / pytest / npm / make /
  // stacktrace / tsc / kubectl / json / md / gostest) recognises a command
  // pattern or body fingerprint and rewrites the body to strip predictable
  // noise. Off by default. Set to 1/true to opt in.
  MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_HEURISTIC: truthy("MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_HEURISTIC"),
  MIMOCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: number("MIMOCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  MIMOCODE_EXPERIMENTAL_OXFMT: MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_OXFMT"),
  MIMOCODE_EXPERIMENTAL_LSP_TY: truthy("MIMOCODE_EXPERIMENTAL_LSP_TY"),
  MIMOCODE_EXPERIMENTAL_LSP_TOOL: MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_LSP_TOOL"),
  // Defaults to OFF: exec (tool_script orchestration) is registered only for
  // GPT-toolset models. Opt in here to expose it to every model.
  MIMOCODE_ENABLE_EXEC_TOOL: truthy("MIMOCODE_ENABLE_EXEC_TOOL"),
  // Defaults to OFF for non-GPT models. GPT models enable MCP Tool Search in
  // SessionPrompt regardless of this flag. Opt in here to enable it for every
  // function-calling model.
  MIMOCODE_EXPERIMENTAL_MCP_TOOL_SEARCH:
    MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_MCP_TOOL_SEARCH"),
  // Defaults to OFF (opt-in): the Orchestrator primary mode — a general
  // coordinator that delegates to child sessions via the `session` tool, with a
  // global singleton workspace and child permission-approval routing. Enable with
  // MIMOCODE_EXPERIMENTAL_ORCHESTRATOR=true (or the umbrella MIMOCODE_EXPERIMENTAL).
  MIMOCODE_EXPERIMENTAL_ORCHESTRATOR: MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_ORCHESTRATOR"),
  // Defaults to OFF (opt-in): dynamic workflows and built-in workflows.
  // Enable with MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL=true (or the umbrella
  // MIMOCODE_EXPERIMENTAL flag).
  MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL:
    MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL"),
  // Defaults to true: cron + self-paced loop scheduling are on by default.
  // Set MIMOCODE_EXPERIMENTAL_CRON=false to opt out. Runtime kill switch is
  // MIMOCODE_DISABLE_CRON (checked live every tick).
  MIMOCODE_EXPERIMENTAL_CRON: !falsy("MIMOCODE_EXPERIMENTAL_CRON"),
  // Keepalive contract for self-paced loops (spec [S8]). Budget = how many
  // "forget" turns the model gets before the loop is declared model_stopped;
  // delay seconds = the auto-arm horizon used for the keepalive fire. Budget
  // accepts 0 (end immediately on the first turn without a re-arm) for tests
  // and aggressive policies. Both are getters so tests can flip the env var
  // between cases without restarting the process.
  get MIMOCODE_LOOP_KEEPALIVE_BUDGET() {
    return nonNegativeNumber("MIMOCODE_LOOP_KEEPALIVE_BUDGET") ?? 1
  },
  get MIMOCODE_LOOP_KEEPALIVE_DELAY_S() {
    return number("MIMOCODE_LOOP_KEEPALIVE_DELAY_S") ?? 1200
  },
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

  // Disables compose-agent-internal skills (e.g. compose:plan, compose:review,
  // compose:tdd). These are hidden workflow-orchestration skills only visible
  // to the compose agent and are NOT part of builtin skills.
  get MIMOCODE_DISABLE_COMPOSE_SKILLS() {
    return truthy("MIMOCODE_DISABLE_COMPOSE_SKILLS")
  },
  // Disables user-facing builtin skills shipped with the binary (e.g.
  // evolve). Does not affect compose skills — the two sets are
  // independent and non-overlapping.
  get MIMOCODE_DISABLE_BUILTIN_SKILLS() {
    return truthy("MIMOCODE_DISABLE_BUILTIN_SKILLS")
  },
  // Disables the built-in official skills (docx, pdf, pptx, xlsx,
  // html-to-video-pipeline) while keeping the rest of the builtin bundle
  // available. Defaults to false (all skills are extracted and loaded). Set
  // MIMOCODE_DISABLE_OFFICIAL_SKILLS=true to skip them.
  get MIMOCODE_DISABLE_OFFICIAL_SKILLS() {
    return truthy("MIMOCODE_DISABLE_OFFICIAL_SKILLS")
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
