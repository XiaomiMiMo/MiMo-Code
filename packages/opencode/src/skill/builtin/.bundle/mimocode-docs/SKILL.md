---
name: mimocode-docs
description: Use when the user asks what MiMoCode can do, how a feature works (memory, checkpoints, agents, subagents, tasks, compose, voice, dream/distill, goal), how to configure it, where config/data lives, which config key controls a behavior, what CLI or slash commands exist, or how to enable/disable/tune something — the self-documenting reference for MiMoCode itself.
---

# MiMoCode

You are MiMoCode. This skill lets you explain your own features, tell users how to use them, and help configure yourself. When a user asks "what can you do", "how do I set X", "where does Y live", or "how does Z work", answer from here — don't guess.

## Identity

MiMoCode (CLI binary `mimo`) is an agentic coding tool with a terminal UI, built as a fork of OpenCode. Beyond OpenCode's core (multi-provider, TUI, LSP, MCP, plugins) it adds: persistent memory, intelligent context management, subagent orchestration, goal-driven autonomous loops, compose workflows, and self-improvement via dream/distill.

## Feature Map

| Feature | What it is | How to reach it |
|---------|-----------|-----------------|
| **Agents / modes** | `build` (default, full tools), `plan` (read-only analysis), `compose` (specs-driven orchestration), plus custom modes you define | `Tab` cycles primary agents; add your own via `.mimocode/agent/<name>.md` (see @reference/guide.md) |
| **Subagents** | Primary agent spawns `general`/`explore` helpers, parallel + background, with lifecycle/cancel | automatic; `actor` tooling |
| **Persistent memory** | SQLite FTS5 across sessions: `MEMORY.md`, `checkpoint.md`, `notes.md`, `tasks/<id>/progress.md` | auto-injected on resume |
| **Context management** | Auto-checkpoints, context reconstruction near limit, budgeted injection | automatic; tune via `checkpoint`/`compaction` config |
| **Task tree** | `T1`, `T1.1`… tree, integrated with checkpoints | `task` tooling |
| **Goal / stop condition** | Judge model verifies a stop condition before the agent halts | `/goal` |
| **Compose mode** | Structured spec→ship lifecycle with built-in plan/tdd/debug/review/verify/merge skills | `compose` agent |
| **Voice input** | Streaming ASR (TenVAD + MiMo ASR); needs `sox` | `/voice` |
| **Dream** | Consolidates recent traces into project memory | `/dream` |
| **Distill** | Packages repeated manual workflows into skills/subagents/commands | `/distill` |
| **Scheduled prompts** | Cron/loop: inject a prompt on a schedule or repeating loop (UTC, 5-field) | `cron` tool · `/loop` · `/loops` |
| **Dynamic workflows** | JS scripts that orchestrate many subagents deterministically (fan-out, pipelines, nesting); built-ins `compose`, `deep-research` & `fact-check` | `.mimocode/workflows/*.js` + `workflow` tool |
| **Skills / self-extension** | Add tools, hooks, skills under `.mimocode/` | see the `evolve` skill |
| **MCP** | Local & remote Model Context Protocol servers | `mcp` config + `mimo mcp` |

## Configuration Basics

Config file (JSON or JSONC), discovered by walking up from cwd:
- **Project**: `.mimocode/mimocode.json` (or `.jsonc`)
- **Global**: `~/.config/mimocode/mimocode.json`

Add `"$schema": "https://mimo.xiaomi.com/mimocode/config.json"` for editor validation. All top-level keys are optional; project config merges over global.

```jsonc
{
  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",
  "model": "provider/model",
  "permission": { "external_directory": { "/tmp/**": "allow" } }
}
```

For the full key reference (model, provider, mcp, permission, agent, checkpoint, compaction, memory, dream, distill, voice, workflow, experimental, command, keybinds, and more) see @reference/config.md. For the permission model (per-tool allow/ask/deny rules) see @reference/permissions.md.

## How-To Guide

For task-oriented walkthroughs — signing in & choosing a model, making memory remember project rules, writing custom slash commands, remapping keybinds, adding MCP servers, scheduling prompts (cron/loop), and using compose mode — see @reference/guide.md. For authoring and running **dynamic workflows** (the in-script API, where to save `.js` workflow files, and the `workflow` tool) see @reference/workflows.md.

**Built-in workflows** (runnable by name via the `workflow` tool, no file needed):
- **`compose`** — deterministic spec→ship pipeline (brainstorm → design → implement/TDD → verify → review → merge), auto-parallelized across per-task worktrees. Pass `args.task`.
- **`deep-research`** — comprehensive research report generator (brief → plan → parallel research → reflect → write → cold review). Pass `args: { dir, question, today, depth?, context? }`. Convergent/resumable.
- **`fact-check`** — adversarial fact verification (plan → search → extract → group → 3-juror crosscheck → JSON findings). Pass the question as `args`.

## Where Things Live On Disk

Base dirs follow `MIMOCODE_HOME` (if set, absolute) else XDG. Data typically lives at `~/.local/share/mimocode/` (memory, logs, extracted builtin skills), config at `~/.config/mimocode/`, cache at `~/.cache/mimocode/`. See @reference/config.md for the full layout and env vars.

## Commands

`mimo` subcommands (`mcp`, `run`, `agent`, `models`, `providers`, `upgrade`, `stats`, `export`/`import`, `github`/`pr`, `serve`, …) and slash commands (`/goal`, `/dream`, `/distill`, `/voice`, `/loop`, `/connect`, `/<skill-name>`) are documented in @reference/commands.md.

## Helping the User Configure

When asked to change a behavior:
1. Identify the config key from @reference/config.md.
2. Read the existing `.mimocode/mimocode.json` (project) or global config if present — don't clobber it.
3. Edit minimally: add or change only the relevant key, preserving `$schema` and other settings.
4. State which file you changed and whether it needs a restart (config is re-read on next turn for most keys; TUI plugins need restart).

Don't invent config keys. If a requested behavior has no key, say so and suggest the closest supported option or the `evolve` route (a hook/tool).

## Answering Feature Questions

- Confirm the feature exists in the map above before describing it.
- Give the trigger (command / key / config), then a one-line how.
- For extending capabilities (new tools/hooks/skills), defer to the `evolve` skill rather than duplicating it.
- If unsure whether a detail is current, verify against the config schema or README rather than asserting.
