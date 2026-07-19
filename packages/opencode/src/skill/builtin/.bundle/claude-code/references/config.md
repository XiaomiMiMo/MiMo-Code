# Configuration: Settings, Memory, Agents, Hooks, MCP, Plugins

## Settings Hierarchy (highest → lowest)

1. CLI flags
2. `.claude/settings.local.json` (personal, gitignored)
3. `.claude/settings.json` (team, git-tracked)
4. `~/.claude/settings.json` (global)

### Permissions in settings

```json
{
  "permissions": {
    "allow": ["Bash(npm run lint:*)", "WebSearch", "Read"],
    "ask": ["Write(*.ts)", "Bash(git push*)"],
    "deny": ["Read(.env)", "Bash(rm -rf *)"]
  }
}
```

## CLAUDE.md & Memory

Hierarchy: `~/.claude/CLAUDE.md` (global) → `./CLAUDE.md` (project, tracked) → `.claude/CLAUDE.local.md` (personal, gitignored). Auto-loaded from project root; survives `/compact`. Quick-add interactively with `#` prefix.

Be specific: "2-space indentation for YAML, 4-space for Python", "test files end in `.test.ts`" — not "write good code".

Example:
```markdown
# Project: My API
## Architecture
- FastAPI + SQLAlchemy, PostgreSQL, Redis cache; pytest, 90% coverage target
## Key Commands
- `make test` / `make lint` (ruff+mypy) / `make dev` (:8000)
## Code Standards
- Type hints on public functions; Google-style docstrings; no wildcard imports
```

### Rules directory (modular CLAUDE.md)
- Project: `.claude/rules/*.md` (team, tracked)
- User: `~/.claude/rules/*.md` (personal, global)

Each `.md` loads as additional context — cleaner than one giant CLAUDE.md.

### Auto-memory
Claude stores learned context in `~/.claude/projects/<project>/memory/` (25KB / 200 lines per project). Separate from CLAUDE.md. Wipe with `claude project purge`.

## Custom Slash Commands & Skills

Slash command: `.claude/commands/<name>.md` (project) or `~/.claude/commands/<name>.md` (personal); `$ARGUMENTS` is replaced with user input. Invoked manually: `/deploy production`.

Skill: `.claude/skills/<name>.md` — invoked automatically by natural-language match, no manual trigger.

## Custom Subagents

Priority: `.claude/agents/` (project) → `--agents` CLI flag (session) → `~/.claude/agents/` (personal).

```markdown
# .claude/agents/security-reviewer.md
---
name: security-reviewer
description: Security-focused code review
model: opus
tools: [Read, Bash]
---
You are a senior security engineer. Review for injection, authz flaws, secrets, unsafe deserialization.
```

Invoke: `@security-reviewer review the auth module`. Orchestrate: "Use @db-expert to optimize queries, then @security to audit."

Dynamic via CLI:
```
claude --agents '{"reviewer": {"description": "Reviews code", "prompt": "You are a performance-focused reviewer"}}' -p 'Use @reviewer to check auth.py'
```

Shared instructions for all subagents: `claude --append-subagent-system-prompt "Never edit tests without asking." -p "task"`

## Hooks

Configure in `.claude/settings.json` or `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write(*.py)",
      "hooks": [{"type": "command", "command": "ruff check --fix $CLAUDE_FILE_PATHS"}]
    }],
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{"type": "command", "command": "if echo \"$CLAUDE_TOOL_INPUT\" | grep -qE 'rm -rf|git push.*--force'; then echo 'Blocked!' && exit 2; fi"}]
    }]
  }
}
```

| Hook | Fires | Use |
|---|---|---|
| `UserPromptSubmit` | Before processing a prompt | Validation, logging |
| `PreToolUse` | Before tool execution | Security gates (exit 2 = block) |
| `PostToolUse` | After tool finishes | Auto-format, lint |
| `Notification` | Permission requests / input waits | Alerts |
| `Stop` | Response finished | Completion logging |
| `SubagentStop` | Subagent completes | Orchestration |
| `PreCompact` | Before context compaction | Backup transcripts |
| `SessionStart` | Session begins | Load dev context |

Env vars in hooks: `CLAUDE_PROJECT_DIR`, `CLAUDE_FILE_PATHS`, `CLAUDE_TOOL_INPUT`.
Observe hooks while scripting: `--output-format stream-json --verbose --include-hook-events`.

## MCP

```bash
claude mcp add -s user github -- npx @modelcontextprotocol/server-github   # stdio
claude mcp add -e API_KEY=xxx my-server -- npx my-mcp-server               # stdio + env
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp          # HTTP
claude mcp add --transport http corridor https://app.corridor.dev/api/mcp --header 'Authorization: Bearer ...'
claude mcp add-json my-server '{"command":"node","args":["server.js"]}'
claude mcp add-from-claude-desktop            # import (macOS/WSL)
claude mcp list | get <name> | remove <name>
claude mcp login <name> | logout <name>       # OAuth (v2.1.186+)
claude mcp reset-project-choices              # reset per-project .mcp.json approvals
claude mcp serve                              # expose Claude Code itself as an MCP server
```

Scopes: `-s user` (global, `~/.claude.json`) · `-s local` (project personal, `settings.local.json`) · `-s project` (team, `settings.json`).

CI/print: `claude --bare -p 'Query database' --mcp-config mcp-servers.json --strict-mcp-config`

In chat, reference resources: `@github:issue://123`

Limits: tool descriptions capped 2KB/server; result size capped by default (`maxResultSizeChars` annotation allows up to 500K chars); cap output with `MAX_MCP_OUTPUT_TOKENS`. Transports: `stdio`, `http`, `sse`.

## Plugins

`claude plugin` (alias `plugins`):

| Subcommand | Purpose |
|---|---|
| `install\|i <plugin>` | Install (`plugin@marketplace` to pin) |
| `uninstall\|remove` / `enable` / `disable` / `update` | Lifecycle (update needs restart) |
| `list` / `details <name>` | Inventory + projected token cost |
| `marketplace` | Add/list/remove marketplaces |
| `prune` / `autoremove` | Remove orphaned auto-installed deps |
| `validate <path>` / `tag [path]` | Validate manifest / create `{name}--v{version}` git tag |

Session-only (no install): `claude --plugin-dir ./my-plugin --plugin-dir B.zip` or `--plugin-url https://example.com/plugin.zip`

## Project State Purge

Wipes transcripts, task lists, debug logs, file-edit history, prompt history, and the `~/.claude.json` entry. **Irreversible — always `--dry-run` first.**

```bash
claude project purge /path/to/project --dry-run
claude project purge /path/to/project -y      # non-interactive
claude project purge /path/to/project -i      # per-item confirm
claude project purge --all -y                 # everything (dangerous)
```

Use before publishing repros, when disk grows, or to force fresh auto-memory.
