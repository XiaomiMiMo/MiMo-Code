# MiMoCode Configuration Reference

## File locations & precedence

Config is JSON or JSONC. MiMoCode discovers it by walking up from the cwd to the worktree root, then falls back to global.

- Project: `.mimocode/mimocode.json` or `.mimocode/mimocode.jsonc`
- Global: `~/.config/mimocode/mimocode.json` (XDG config dir)
- Extra config dirs are also searched via `$MIMOCODE_CONFIG_DIR`.

Project config merges **over** global. Always include `"$schema": "https://mimo.xiaomi.com/mimocode/config.json"` for validation.

## On-disk data layout

Base directories resolve from `MIMOCODE_HOME` if set (must be absolute → `<home>/{data,cache,config,state}`), otherwise from XDG:

| Kind | Default location | Holds |
|------|------------------|-------|
| data | `~/.local/share/mimocode/` | memory, logs, `builtin_skills/<version>/`, bin |
| config | `~/.config/mimocode/` | global `mimocode.json` |
| cache | `~/.cache/mimocode/` | caches, downloaded bins |
| state | `~/.local/state/mimocode/` | runtime state |

Memory files live under `~/.local/share/mimocode/memory/`:
- `projects/global/MEMORY.md` — project memory
- `sessions/<id>/checkpoint.md`, `notes.md`, `tasks/<id>/progress.md`
- `global/MEMORY.md` — cross-project user preferences

## Environment variables & flags

- `MIMOCODE_HOME` — override all base dirs (absolute path).
- `MIMOCODE_CONFIG_DIR` — extra config directory to search.
- `MIMOCODE_PURE` — run without external plugins (same as `mimo --pure`). Does **not** change models or Claude Code inheritance.
- `MIMOCODE_MIMO_ONLY` — pure-MiMo mode: don't inherit Claude Code settings (CLAUDE.md, `~/.claude/skills`), don't read provider API keys from env, fall back to the mimo-auto model.
- `MIMOCODE_DISABLE_LOG_ROTATION` — keep a single growing log file instead of rotating.
- `MIMOCODE_TEXT_TOOL_CALL_RETRY_LIMIT` — retries when a model emits a tool call as prose markup instead of a structured call (default 2).
- `MIMOCODE_EXPERIMENTAL_CRON` — scheduled prompts (cron/loop); **on by default**. `MIMOCODE_DISABLE_CRON` kills it at runtime. Tune loop keepalive with `MIMOCODE_LOOP_KEEPALIVE_BUDGET` (default 1) and `MIMOCODE_LOOP_KEEPALIVE_DELAY_S` (default 1200).
- `MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_HEURISTIC` — shape-based compaction of bash output to save tokens; off by default.
- `MIMOCODE_DISABLE_BUILTIN_SKILLS`, `_COMPOSE_SKILLS`, `_EXTERNAL_SKILLS`, `_CLAUDE_CODE_SKILLS`, `_CODEX_SKILLS`, `_OPENCODE_SKILLS`, `_PROJECT_CONFIG`, `_CLAUDE_IMPORT` — feature toggles.

## Top-level config keys

All optional.

### Models & providers
| Key | Purpose |
|-----|---------|
| `model` | Primary model, `provider/model` (e.g. `anthropic/claude-2`) |
| `small_model` | **Legacy / not recommended** — carried over from OpenCode for back-compat. Prefer configuring the `lite` group instead. If set, its literal `provider/model` still wins for cheap tasks (title generation, etc.); if unset, cheap tasks route through the `lite` group |
| `model_groups` | Named capability tiers usable anywhere a model string is accepted — see [Model groups](#model-groups) |
| `provider` | Custom provider configs & model overrides |
| `enabled_providers` / `disabled_providers` | Allowlist / blocklist providers |

### Model groups

`model_groups` lets you define named capability tiers and reference them by name (e.g. `"ultra"`) anywhere a `provider/model` string is accepted — the `model` key, an agent's model, the `actor` subagent `model` argument, and workflow model tiers.

Each group maps a name to either a single default model (string shorthand) or an object with a `default` plus optional member `models`:

```jsonc
{
  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",
  "model_groups": {
    // string shorthand: the group IS its default model
    "lite": "anthropic/claude-haiku",
    // object form: a default plus alternates on other providers
    "standard": {
      "default": "anthropic/claude-sonnet",
      "models": ["anthropic/claude-sonnet", "openrouter/xiaomi/mimo-v2.5"]
    },
    "ultra": "anthropic/claude-opus-4-8"
  },
  "model": "standard"
}
```

**Resolution rules:**
- A ref containing `/` is a literal `provider/model` and is used as-is.
- A ref without `/` is a group name. If configured, MiMoCode is **provider-aware**: it prefers a member on the caller's current provider, otherwise falls back to the group's `default`.
- `ultra`, `standard`, `lite` are **built-in tier names**. If you reference one but haven't configured it, it silently falls back to the default model (zero-config never errors).
- Any other unconfigured name errors with fuzzy suggestions of your defined groups.
- Cheap-task (small) model: **configure the `lite` group** — that is the recommended path. The legacy `small_model` literal, if set, still takes precedence for back-compat, but is not recommended for new configs.

Use groups when you want one label (`"standard"`) to map to different concrete models per provider, or to swap tiers globally without editing every agent/model reference.

### Agents
| Key | Purpose |
|-----|---------|
| `default_agent` | Primary agent when none specified (falls back to `build`) |
| `agent` | Per-agent config: `plan`, `build`, `general`, `explore`, `title`, `summary`, `compaction`, plus custom |
| `username` | Display name in conversations |

Prefer a markdown file (`.mimocode/agent/<name>.md`, body = system prompt) for defining a custom agent/mode — see the "Custom agents & modes" section in @guide.md. Use the `agent` config key for short, inline per-agent overrides.

### Tools, skills, MCP, extensions
| Key | Purpose |
|-----|---------|
| `skills` | `paths[]` extra skill folders + `urls[]` remote skill indexes |
| `mcp` | MCP servers: `local` (command/env) or `remote` (url/headers/oauth); `{ "enabled": false }` disables one |
| `tools` | Record of tool-id → boolean enable/disable |
| `tool.invocation_style` | `json` (default) or `shell`; `tool.invocation_style_by_tool` for per-tool override |
| `command` | Custom slash commands |
| `plugin` | Plugin specs |
| `formatter`, `lsp` | Formatter & language-server config |
| `instructions` | Extra instruction files/globs to include |
| `permission` | Permission rules incl. `external_directory` allowlist |

### Context management

As context fills, MiMoCode auto-checkpoints (a background writer distills the conversation into `checkpoint.md`) and, near the limit, **rebuilds**: it inserts a boundary at the last successful checkpoint so earlier messages collapse to the checkpoint summary while recent messages are kept verbatim. If a checkpoint writer is still running when a rebuild is needed, the rebuild waits for it (with a visible "Preparing conversation context…" status) — briefly when a usable checkpoint already exists, longer for the very first one — then proceeds; if no checkpoint can be produced it falls back to lossy compaction. You can trigger a rebuild yourself any time with the `/rebuild` slash command.

| Key | Purpose |
|-----|---------|
| `compaction.auto` | Auto-compact when context full (default true) |
| `compaction.prune` | Prune old tool outputs (default true) |
| `compaction.tail_turns` | Recent user turns kept verbatim (default 2) |
| `compaction.preserve_recent_tokens` | Max recent tokens kept verbatim |
| `compaction.reserved` | Token buffer to avoid overflow |
| `checkpoint.thresholds` | Context-fill triggers, e.g. `["40%","60%","80%"]` |
| `checkpoint.reserved` | Token buffer for checkpoint ops (default 20000) |
| `checkpoint.max_writer_failures` | Consecutive writer failures before pausing (default 3) |
| `checkpoint.fork` | Fork parent prefix into writer session for cache reuse (default false) |
| `checkpoint.push_caps.*` | Per-section token caps for rebuild context (tasks_ledger, focus_task, checkpoint, memory, notes, global, recent_user, …) |
| `checkpoint.task_archive_days` | Days before done/abandoned tasks filtered out (default 7) |
| `checkpoint.memory_search_score_floor` | BM25 relative floor for memory search (default 0.15) |
| `memory.cc_index` | Index Claude Code memory under scope `cc` (default false; see privacy note in schema) |
| `history` | Conversation-history FTS index config |

### Autonomous / self-improvement
| Key | Purpose |
|-----|---------|
| `dream.auto` / `dream.interval_days` | Auto memory consolidation on session start (default true / 7 days) |
| `distill.auto` / `distill.interval_days` | Auto workflow packaging (default true / 30 days) |
| `voice.asr_model` | ASR model (default `xiaomi/mimo-v2.5-asr`) |
| `voice.control_model` | Voice control model (default `xiaomi/mimo-v2.5`) |
| `compose` | Compose mode config (`docs` dir default `docs/compose`, `docs_absolute`) |
| `workflow.maxConcurrentAgents` | Process-wide subagent concurrency ceiling (default min(16, 2×cores)) |
| `workflow.maxDepth` | Max workflow nesting depth (default 8) |

### Experimental
| Key | Purpose |
|-----|---------|
| `experimental.maxMode` | `max` agent runs N parallel reasoning candidates, judge picks winner (`candidates`, default 5) |
| `experimental.batch_tool` | Enable the batch tool |
| `experimental.predict_next_prompt` | Inline ghost-text next-prompt prediction (default on) |
| `experimental.continue_loop_on_deny` | Keep looping when a tool call is denied |
| `experimental.primary_tools` | Tools restricted to primary agents |
| `experimental.mcp_timeout` | MCP request timeout (ms) |

### Misc
| Key | Purpose |
|-----|---------|
| `autoupdate` | `true` / `false` / `"notify"` |
| `share` | `"manual"` / `"auto"` / `"disabled"` |
| `snapshot` | Filesystem snapshot tracking for undo/redo (default true) |
| `logLevel` | Log verbosity |
| `server` | Config for `mimo serve` |
| `enterprise.url` | Enterprise endpoint |

## Example: common tweaks

```jsonc
{
  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",
  "model": "anthropic/claude-opus-4-8",
  "model_groups": { "lite": "anthropic/claude-haiku" },
  "dream": { "auto": true, "interval_days": 3 },
  "compaction": { "tail_turns": 3 },
  "permission": { "external_directory": { "/tmp/**": "allow" } },
  "mcp": {
    "my-server": { "type": "local", "command": ["node", "server.js"] }
  }
}
```
