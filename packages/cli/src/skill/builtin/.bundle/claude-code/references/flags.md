# CLI Reference (v2.1.140+)

Note: `--help` is incomplete — some flags exist without appearing there.

## Auth & Install

| Command | Purpose |
|---|---|
| `claude auth login` | Sign in (default `--claudeai`; also `--console`, `--sso`, `--email you@x.com`) |
| `claude auth logout` / `auth status [--text]` | Log out / status (JSON default) |
| `claude setup-token` | Long-lived OAuth token for CI (subscription-only) |
| `claude doctor` | Read-only install/auto-updater diagnostics |
| `claude --version` / `update` / `upgrade` | Version / update |
| `claude install [stable\|latest\|<ver>] [--force]` | Install native build |

## Subcommands

| Subcommand | Purpose |
|---|---|
| `claude` / `claude "query"` | Interactive REPL (optionally with initial prompt) |
| `claude -p "query"` | Print mode (one-shot, exits) |
| `cat file \| claude -p "q"` | Pipe stdin as context |
| `claude -c` / `claude -r "id"` | Continue latest in cwd / resume by ID or name |
| `claude --bg "task"` | Supervised background session (not with `-p`, v2.1.198+) |
| `claude attach/logs/stop/kill/respawn/rm <id>` | Manage background sessions; `respawn --all` after CLI upgrade |
| `claude agents [--json --all] [--cwd] [--permission-mode]` | List/manage background + configured agents |
| `claude ultrareview [target] [--json] [--timeout <min>]` | Cloud multi-agent review of branch/PR; exit 0/1; default 30 min |
| `claude mcp ...` | MCP management → `config.md` |
| `claude plugin` / `plugins` | Plugin management → `config.md` |
| `claude project purge [path]` | Delete local project state → `config.md` |
| `claude auto-mode` | Auto-mode classifier: `config`, `defaults`, `critique` |
| `claude daemon` | Supervisor diagnostics: `status`, `stop --any --keep-workers` |
| `claude gateway` | Self-hosted apps gateway for SSO/policy (v2.1.195+) |

## Session & Environment Flags

| Flag | Effect |
|---|---|
| `-p, --print` | One-shot non-interactive; skips trust dialog |
| `-c, --continue` | Resume most recent conversation in cwd |
| `-r, --resume [value]` | Resume by ID/name (picker if omitted) |
| `--fork-session` | New session ID on resume, keeps history |
| `--session-id <uuid>` | Pin a specific UUID |
| `--no-session-persistence` | Don't save to disk (print only) |
| `-n, --name <name>` | Display name (prompt box, `/resume`, terminal title) |
| `--add-dir <paths...>` | Extra working dirs (loads their CLAUDE.md) |
| `-w, --worktree [name]` | Isolated git worktree at `.claude/worktrees/<name>` |
| `--tmux [=classic]` | tmux session for worktree (requires `--worktree`) |
| `--ide` | Auto-connect to IDE |
| `--chrome` / `--no-chrome` | Chrome integration for web testing |
| `--from-pr [value]` | Resume session linked to a GitHub/GitLab/Bitbucket PR |
| `--file <id:path...>` | Download file resources at startup |
| `--bg "task"` / `--exec "cmd"` | Background session / supervised PTY background job |
| `--cloud "task"` / `--teleport` | Create web session on claude.ai / resume it locally |
| `--remote-control [name]` | Remote Control from claude.ai/mobile (`--remote-control-session-name-prefix <p>`) |

## Model & Performance

| Flag | Effect |
|---|---|
| `--model <alias>` | `sonnet`, `opus`, `haiku`, or full name |
| `--effort <level>` | `low`/`medium`/`high`/`xhigh`/`max`/`ultracode` (v2.1.203+) |
| `--max-turns <n>` | Cap agentic loops (print only) |
| `--max-budget-usd <n>` | Spend cap (print only; min ~$0.05) |
| `--fallback-model <m>` | Fallback on overload (print only) |
| `--advisor <model>` | Server-side advisor: `opus`/`sonnet`/`fable` (v2.1.170+) |
| `--betas <...>` | Beta API headers (API-key users only) |

## Permission & Safety

| Flag | Effect |
|---|---|
| `--dangerously-skip-permissions` | Auto-approve ALL tool use |
| `--allow-dangerously-skip-permissions` | Enable bypass as an option, not default |
| `--permission-mode <m>` | `default`, `manual` (v2.1.200+ alias), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` |
| `--allowedTools` / `--disallowedTools <tools...>` | Whitelist / blacklist |
| `--tools <tools...>` | Override built-in tool set (`""`=none, `"default"`=all) |
| `--safe-mode` | Disable all customizations (v2.1.169+) |

### Tool name syntax
```
Read | Edit | Write | Bash | WebSearch | WebFetch
Bash(git *) | Bash(git commit *) | Bash(npm run lint:*)
mcp__<server>__<tool>
```

## Output & Input

| Flag | Effect |
|---|---|
| `--output-format` | `text` (default) / `json` / `stream-json` |
| `--input-format` | `text` / `stream-json` (print only) |
| `--json-schema <schema>` | Validated structured output |
| `--verbose` | Full turn-by-turn |
| `--include-partial-messages` | Partial chunks (stream-json + print) |
| `--include-hook-events` | Hook lifecycle events (stream-json only) |
| `--replay-user-messages` | Re-emit user messages on stdout |
| `--ax-screen-reader` | Screen-reader-friendly output (v2.1.181+) |

## System Prompt & Context

| Flag | Effect |
|---|---|
| `--append-system-prompt <t>` | Add to default system prompt (usually preferred) |
| `--system-prompt <t>` | Replace entire system prompt |
| `--append-subagent-system-prompt <t>` | Append to every subagent's system prompt (v2.1.205+) |
| `--exclude-dynamic-system-prompt-sections` | Per-machine sections → first user message (cache reuse) |
| `--bare` | Minimal mode → `print-mode.md` |
| `--agent <name>` / `--agents '<json>'` | Agent override / dynamic subagent definitions |
| `--mcp-config <...>` / `--strict-mcp-config` | Load MCP servers / ignore all others |
| `--settings <file-or-json>` | Extra settings |
| `--setting-sources <s>` | Comma-separated: `user`, `project`, `local` |
| `--plugin-dir <p>` / `--plugin-url <u>` | Session-only plugins (repeatable) |
| `--disable-slash-commands` | Disable all skills/slash commands |
| `--channels <...>` | MCP channel notifications (research preview) |

## Debugging & Teams

| Flag | Effect |
|---|---|
| `-d, --debug [filter]` | Debug logging (e.g. `"api,hooks"`, `"!1p,!file"`); `--mcp-debug` deprecated → `--debug mcp` |
| `--debug-file <path>` | Debug log to file |
| `--teammate-mode <m>` | Team display: `auto`/`in-process`/`tmux`/`iterm2` (v2.1.186+) |
| `--brief` | Enable `SendUserMessage` agent-to-user tool |

## Environment Variables

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | API-key auth (alternative to OAuth) |
| `CLAUDE_CODE_EFFORT_LEVEL` | Default effort level |
| `CLAUDE_CODE_SIMPLE=1` | Minimal mode (set by `--bare`) |
| `MAX_THINKING_TOKENS` | Cap thinking (`0` disables) |
| `MAX_MCP_OUTPUT_TOKENS` | Cap MCP output (e.g. `50000`) |
| `MCP_TIMEOUT` | MCP startup timeout ms; `--permission-prompt-tool` waits up to this (v2.1.206+) |
| `CLAUDE_CODE_NO_FLICKER=1` | Alt-screen rendering, no flicker |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | Strip credentials from subprocesses |
