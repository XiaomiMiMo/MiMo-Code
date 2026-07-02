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

## Extending MiMoCode

To add tools, hooks, or skills, use the `self-extend` skill — it covers writing `.mimocode/tools/*.ts`, `.mimocode/hooks/*.ts`, and `.mimocode/skills/*/SKILL.md`, all hot-reloaded on the next turn.
