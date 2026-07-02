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
- `MIMOCODE_PURE` — pure mode.
- `MIMOCODE_DISABLE_BUILTIN_SKILLS`, `_COMPOSE_SKILLS`, `_EXTERNAL_SKILLS`, `_CLAUDE_CODE_SKILLS`, `_CODEX_SKILLS`, `_OPENCODE_SKILLS`, `_PROJECT_CONFIG`, `_CLAUDE_IMPORT` — feature toggles.

## Top-level config keys

All optional.

### Models & providers
| Key | Purpose |
|-----|---------|
| `model` | Primary model, `provider/model` (e.g. `anthropic/claude-2`) |
| `small_model` | Model for cheap tasks like title generation |
| `model_groups` | Named capability tiers (e.g. ultra/standard/lite); usable anywhere a model string is |
| `provider` | Custom provider configs & model overrides |
| `enabled_providers` / `disabled_providers` | Allowlist / blocklist providers |

### Agents
| Key | Purpose |
|-----|---------|
| `default_agent` | Primary agent when none specified (falls back to `build`) |
| `agent` | Per-agent config: `plan`, `build`, `general`, `explore`, `title`, `summary`, `compaction`, plus custom |
| `username` | Display name in conversations |

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
  "small_model": "anthropic/claude-haiku",
  "dream": { "auto": true, "interval_days": 3 },
  "compaction": { "tail_turns": 3 },
  "permission": { "external_directory": { "/tmp/**": "allow" } },
  "mcp": {
    "my-server": { "type": "local", "command": ["node", "server.js"] }
  }
}
```
