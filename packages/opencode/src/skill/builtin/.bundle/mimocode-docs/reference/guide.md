# MiMoCode Usage Guide

How-to for the features users most often ask about. For config keys see @config.md; for permissions see @permissions.md; for commands see @commands.md.

## Getting started & auth

1. **Sign in** — `mimo account login <url>` runs a device flow: it prints a URL + code and opens your browser. `/connect` does the same from inside the TUI (e.g. to add OpenRouter). Other account subcommands: `logout`, `switch`, `orgs`, `open`, `console`.
2. **Pick a model** — set `"model": "provider/model"` in config, or switch live in the TUI model dialog. Provider API keys are auto-detected from environment variables (unless `MIMOCODE_MIMO_ONLY=1`).
3. **List what's available** — `mimo models`, `mimo providers`.

## Memory: making MiMoCode remember

Memory persists across sessions and is auto-injected on resume, so the agent doesn't relearn project context.

- **Project rules / architecture** — edit `MEMORY.md` (project memory). Durable rules go under `## Rules`, design decisions under `## Architecture decisions`. The agent may also write here at checkpoint time.
- **`/dream`** — scans recent session traces, promotes durable knowledge into `MEMORY.md`, and prunes stale entries. Runs automatically per `dream.interval_days` (default 7).
- **Checkpoints** (`checkpoint.md`) are maintained *only* by the checkpoint-writer subagent — don't hand-edit them.
- **Scratch notes** (`notes.md`) are the agent's free-form scratchpad.
- To make a rule stick immediately without waiting for a checkpoint, just tell the agent — it can edit `MEMORY.md` directly.

Tune memory behavior with `checkpoint.*`, `compaction.*`, and `memory.cc_index` (see @config.md).

## Custom slash commands

Drop a markdown file at `.mimocode/command/<name>.md` (or `.mimocode/commands/`, `.claude/command(s)/` are also read). The frontmatter configures it; the body is the prompt template.

```markdown
---
description: Review the current diff for security issues
agent: build
model: standard
subtask: false
---
Review the staged diff. Focus on: $ARGUMENTS
```

- Invoke with `/name your args here`.
- Placeholders: `$ARGUMENTS` (all args), `$1`, `$2`, … (positional). If none are present, args are appended.
- `agent` picks which agent runs it; `model` accepts a `provider/model` or a group name; `subtask: true` runs it as a subagent.

Commands hot-reload on the next turn.

## Custom agents & modes (file-based system prompts)

A "mode" is just a **primary agent** with its own system prompt. To give MiMoCode a custom mode (e.g. a `general` chat mode alongside the coding-focused `build`), drop a markdown file — no code, no server changes. The frontmatter is config; the **markdown body becomes the agent's system prompt**.

```markdown
---
description: A friendly general-purpose assistant for everyday chat and Q&A
mode: primary
temperature: 0.7
---
You are "General" — a warm, concise, general-purpose assistant.
Keep replies short unless asked to elaborate; you are not focused on coding.
```

Where to put the file (all hot-reloaded on the next turn; `.claude/agent(s)` are also read):

| Path | Scope |
|------|-------|
| `.mimocode/agent/<name>.md` (or `agents/`) | project agent — most common |
| `.mimocode/mode/<name>.md` (or `modes/`) | project mode — same as an agent forced to `mode: primary` |
| `~/.config/mimocode/agent/<name>.md` | global agent, available in every project |

Frontmatter fields (all optional except that the body should be non-empty):

- `mode` — `primary` (selectable with `Tab`, replaces the base prompt for the session), `subagent` (spawnable by a primary via the `actor`/`task` tools), or `all`. Files under `mode/` are always primary.
- `model` — a `provider/model` or a group name (`ultra`/`standard`/`lite`); `variant`, `temperature`, `top_p` tune generation.
- `description` — when to use it (shown in the `@` autocomplete for subagents).
- `permission`, `tool_allowlist`, `tools`, `steps`, `color`, `hidden` — see @config.md.

**How it reaches the model:** for a primary agent the body is used as the base system prompt in place of the model's default prompt; the usual environment/skills/instructions blocks are still appended. Selecting the mode is session-scoped — the TUI `Tab` picker or, over the SDK, the `agent` field on `session.prompt`. So a desktop/SDK client switches modes by sending `agent: "general"` vs `agent: "build"` per session; the prompt itself lives in the file, server-side.

Verify a file loaded with `mimo agent list` — your agent shows up with its `(primary)` / `(subagent)` mode.

Config-file alternative: instead of a `.md` file you can inline an agent under the `agent` config key (`agent.<name>.prompt`, plus `model`, `mode`, …); the markdown form is preferred for anything beyond a couple of lines.

## Keybinds

All TUI keybinds are remappable under the `keybinds` config. The leader key defaults to `ctrl+x`, so `<leader>` in a binding means "press ctrl+x then …".

Common defaults: `Tab` cycle agents · `<leader>n` new session · `<leader>l` list sessions · `<leader>e` open external editor · `<leader>t` themes · `<leader>b` toggle sidebar · `ctrl+r` rename session. Set a binding to `"none"` to disable it.

```jsonc
{ "keybinds": { "session_new": "<leader>c", "sidebar_toggle": "none" } }
```

## MCP servers

Add servers under the `mcp` key. Two kinds:

```jsonc
{
  "mcp": {
    // local: spawn a process over stdio
    "fs": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] },
    // remote: connect to an HTTP endpoint (OAuth auto-detected; set "oauth": false to disable)
    "docs": { "type": "remote", "url": "https://mcp.example.com", "headers": { "Authorization": "Bearer ..." } },
    // disable one without deleting it
    "old": { "enabled": false }
  }
}
```

Inspect/manage with `mimo mcp`. Request timeout defaults to 5000ms (`timeout` per server, or `experimental.mcp_timeout` globally).

## Compose mode

Compose is a specs-driven orchestration agent: it coordinates built-in skills (plan, tdd, debug, review, verify, merge) across the full spec→ship lifecycle. Switch to it with `Tab`.

Artifacts land under `docs/compose/` by default (`specs/`, `plans/`, `reports/`). Change the location with `compose.docs`; set `compose.docs_absolute: true` to anchor a relative path to the worktree root.

For well-defined tasks that split into independent subtasks, prefer the deterministic **`compose` workflow** (fire-and-forget, auto-parallelized) over the agent — see @workflows.md.

## Jupyter notebooks

The `notebook-edit` tool edits `.ipynb` cells directly (replace / insert / delete a single cell) while preserving the surrounding JSON, outputs, and metadata — prefer it over raw text edits on notebooks.

## Scheduled prompts (cron) & loops

**Cron** schedules a prompt to be injected into a session on a recurring or one-shot basis. It is driven by the `cron` tool (no `/cron` slash command); `MIMOCODE_EXPERIMENTAL_CRON` is **on by default** (kill switch: `MIMOCODE_DISABLE_CRON`).

The `cron` tool has six verbs:

| Verb | Purpose |
|------|---------|
| `schedule` | Add a job: `cron` (5-field expression), `prompt`, optional `one_shot`, `durable`, `session_id` |
| `loop` | Arm a repeating loop by `delay_seconds` (clamped 60–3600) + `prompt` |
| `list` | List jobs (filter by `kind`, `durable_only`) |
| `get` | Show one job by `id` |
| `rename` | Replace a job's prompt body |
| `delete` (alias `cancel`) | Remove a job by `id` |

- **Expressions are 5-field** (`minute hour dom month dow`) and evaluated in **UTC** — there is no timezone config.
- **Durable** jobs persist to `<project>/.mimocode/scheduled_tasks.json` and survive restart; non-durable jobs live only for the session.
- When a job fires, the prompt is injected with an `[cron fire @ <ISO>]` prefix; the TUI shows a `🕒 cron fire` clock-row before the reply.

**Loop** — `/loop [interval] <prompt>` (a built-in skill) is a friendly front end: it parses an interval (e.g. `30m`, `2h`), maps it to a recurring cron job, and also runs the prompt once immediately. Manage loops with `/loops` (lists jobs; `/loops cancel <id>` stops one). Loops auto-stop after a keepalive budget of missed turns or a 7-day max age.

`/loop` (cadence) and `/goal` (stop condition) are complementary and independent: `/goal` decides *whether* an autonomous agent may stop; `/loop` decides *how often* it runs.

## Extending MiMoCode

To add tools, hooks, or skills, use the `evolve` skill — it covers writing `.mimocode/tools/*.ts`, `.mimocode/hooks/*.ts`, and `.mimocode/skills/*/SKILL.md`, all hot-reloaded on the next turn.
