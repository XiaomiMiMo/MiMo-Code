---
name: claude-code
description: "Delegate coding tasks to Claude Code CLI (v2.1+) via the terminal. Use this skill whenever the task involves writing/fixing/refactoring code, reviewing diffs or PRs, running tests, git workflows, or any multi-step change to a codebase — even if the user doesn't say 'Claude Code'. Covers print mode (-p), interactive tmux sessions, and background (--bg) orchestration."
version: 2.0.0
license: MIT
platforms: [linux, macos, windows]
---

# Claude Code Delegation

Delegate coding work to Claude Code, Anthropic's autonomous coding agent CLI.

**Setup (once):** `npm install -g @anthropic-ai/claude-code && claude auth login` · verify with `claude auth status` / `claude doctor`. CI token: `claude setup-token`. Full auth/install variants → `references/flags.md`.

**Platform check (before running anything):** detect the OS first. All shell examples in this skill are POSIX (bash). Linux/macOS run them as-is. On **Windows**, run Claude Code natively in PowerShell/Git Bash for print and background modes, but interactive tmux orchestration requires **WSL**. Shell-syntax translation table (quoting, env vars, piping, paths) → `references/platforms.md`.

## Mode Selection (decide FIRST)

| Task shape | Mode | Why |
|---|---|---|
| One-shot task: fix bug, add feature, review diff, extract data | **Print `-p`** ← default | No PTY, no dialogs, structured output |
| Multi-turn iterate: refactor → review → fix → test; needs slash commands | **Interactive tmux** → `references/interactive-tmux.md` | Full REPL, requires dialog handling |
| Long-running, shouldn't block; large fan-out supervision | **Background `--bg`** | Native supervision via `claude agents` |
| High-stakes PR review | **`claude ultrareview [pr#]`** | Cloud multi-agent, exit-code driven (uploads diff to cloud — never on branches with secrets) |

Do NOT hand-roll tmux fan-outs for parallel work — prefer `--bg` + `claude agents --json --all`.

## Print Mode (the 90% path)

```
terminal(command="claude -p 'Fix the auth bug in src/auth.py' \
  --allowedTools 'Read,Edit' --max-turns 10 --output-format json",
  workdir="/path/to/project", timeout=180)
```

**Always set:** `workdir` · `--max-turns` (5–10; print-mode only) · `--allowedTools` (least privilege: `Read,Edit,Write,Bash`, patterns like `Bash(git *)`).

**JSON result fields:** `result` (text) · `session_id` (for resume) · `subtype` (`success` | `error_max_turns` | `error_budget`) · `total_cost_usd` · `num_turns` · `structured_output` (with `--json-schema`).

**Common variants:**

```bash
git diff main... | claude -p 'Review for bugs' --max-turns 1     # pipe input, cheapest review
claude -p 'Continue: add pooling' --resume <session_id>          # resume; --continue = latest in cwd; --fork-session = branch
claude -p 'List functions' --output-format json --json-schema '<schema>' --max-turns 5   # structured extraction (needs turns to read files)
claude --bare -p 'task' --settings ci.json                       # CI: skips hooks/plugins/CLAUDE.md; auth = ANTHROPIC_API_KEY only
claude -p 'task' --max-budget-usd 0.50 --fallback-model haiku    # cost cap (min ~$0.05) + overload fallback
```

Streaming, stream-json events, bidirectional input, cache-reuse (`--exclude-dynamic-system-prompt-sections`) → `references/print-mode.md`.

## Background Mode

```bash
claude --bg 'investigate flaky test in tests/api.test.ts'   # NOT compatible with -p
claude agents --json --all                                   # list/inspect
claude attach <id> | logs <id> | stop <id> | respawn <id> | rm <id>
```

## Guardrails & Gotchas (violations break agents)

1. **`-p` auto-skips trust/permission dialogs** (any non-TTY does) — only run in trusted directories.
2. **Interactive mode = tmux required** (Windows: only inside WSL — never attempt tmux in PowerShell/cmd; fall back to `-p` or `--bg`); two startup dialogs, and the `--dangerously-skip-permissions` dialog defaults to **"No, exit"** (must send `Down` then `Enter`). Full patterns → `references/interactive-tmux.md`.
3. **Session resume is per-directory** — `--continue` only finds sessions from the same cwd.
4. **Slash commands don't work in `-p`** — describe the task in natural language instead.
5. **Context >70% degrades quality** — in interactive sessions monitor `/context`, use `/compact`.
6. **Clean up**: kill tmux sessions and `claude stop/rm` background sessions when done.
7. **Don't kill slow sessions** — capture progress first (`tmux capture-pane` / `claude logs`).
8. **Report back**: after completion, summarize what changed (use the JSON `result` + `git diff`).

## References (read on demand)

| File | Read when |
|---|---|
| `references/print-mode.md` | Streaming output, stream-json events, piping, schemas, session mgmt, cache reuse |
| `references/interactive-tmux.md` | Any tmux/PTY session: dialogs, send-keys, monitoring, slash commands, shortcuts |
| `references/flags.md` | Full CLI flag & subcommand tables, auth variants, env vars, model/effort selection |
| `references/config.md` | CLAUDE.md/memory, settings hierarchy, custom agents, hooks, MCP, plugins, project purge |
| `references/platforms.md` | Running on Windows (PowerShell/Git Bash/WSL) or macOS: shell translation, paths, per-OS gotchas |
