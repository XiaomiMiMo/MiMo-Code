# Grok Build CLI Reference

Use this index for command selection. Run `grok --help` or `grok <subcommand> --help` for the complete options supported by the installed version.

Official source: <https://docs.x.ai/build/cli/reference>

## Subcommands

| Command | Purpose |
| --- | --- |
| `grok login` | Sign in; add `--device-auth` for headless or remote device-code authentication. |
| `grok logout` | Sign out and clear cached credentials. |
| `grok inspect [--json]` | Show discovered rules, skills, plugins, hooks, and MCP servers. |
| `grok models` | List available models. |
| `grok mcp <list\|add\|remove\|doctor>` | Manage and diagnose MCP servers. |
| `grok plugin <list\|install\|uninstall\|update\|enable\|disable\|details\|validate>` | Manage plugins. |
| `grok plugin marketplace <list\|add\|remove\|update>` | Manage plugin marketplace sources. |
| `grok sessions <list\|search\|delete>` | List, search, or permanently delete sessions. |
| `grok export <session-id> [output]` | Export a session transcript as Markdown. |
| `grok import [targets...]` | Import sessions from Claude Code. |
| `grok memory clear [--workspace\|--global\|--all]` | Clear cross-session memory files. |
| `grok worktree <list\|show\|rm\|gc>` | Manage session worktrees. |
| `grok dashboard` | Open the Agent Dashboard. |
| `grok agent stdio` | Run as an ACP agent over stdin/stdout. |
| `grok wrap <command...>` | Run a local PTY command that forwards OSC 52 clipboard writes. |
| `grok update` | Check for or install updates; inspect `--check`, `--version`, `--alpha`, and `--stable`. |
| `grok version` | Print version information. |
| `grok completions <shell>` | Generate shell completions. |
| `grok setup` | Fetch and install managed configuration. |

Treat `sessions delete`, `memory clear`, `worktree rm`, MCP removal, plugin uninstall, and marketplace removal as destructive or externally visible operations.

## Common Flags

| Flag | Purpose |
| --- | --- |
| `--cwd <PATH>` | Set the working directory. |
| `-r, --resume [<ID>]` | Resume a session by ID, or the most recent when omitted. |
| `-c, --continue` | Continue the most recent session for the current directory. |
| `-s, --session-id <UUID>` | Assign a UUID to a new session. |
| `--fork-session` | Fork a resumed session into a new session ID. |
| `-w, --worktree [<NAME>]` | Start in a new git worktree. |
| `--ref <REF>` | Select the branch, tag, or commit used as the worktree base. |
| `-m, --model <MODEL>` | Select a model ID. |
| `--effort <LEVEL>` | Set reasoning effort. |
| `--always-approve`, `--yolo` | Auto-approve tool execution; deny rules and hooks still apply. |
| `--allow <RULE>`, `--deny <RULE>` | Add per-run permission rules. |
| `--sandbox <PROFILE>` | Select a sandbox profile. |
| `--rules <TEXT>` | Append rules to the system prompt. |
| `--system-prompt-override <TEXT>` | Replace the system prompt. |
| `--tools <LIST>` | Allow selected built-in tools. |
| `--disallowed-tools <LIST>` | Remove selected built-in tools. |
| `--max-turns <N>` | Limit agent turns. |
| `--no-plan` | Disable plan mode. |
| `--no-subagents` | Disable subagents. |
| `--no-memory` | Disable cross-session memory for the run. |
| `--disable-web-search` | Disable web search and web fetch. |
| `--experimental-memory` | Enable cross-session memory. |
| `--oauth` | Use OAuth when welcome-screen authentication begins. |

Overlapping Claude Code compatibility aliases include `--allowedTools`, `--disallowedTools`, `--append-system-prompt`, `--system-prompt`, and `--dangerously-skip-permissions`. Prefer the native Grok flag names in new workflows.

## Headless Flags

Official source: <https://docs.x.ai/build/cli/headless-scripting>

| Flag | Purpose |
| --- | --- |
| `-p, --single <PROMPT>` | Send one prompt, print the response, and exit. |
| `--output-format plain` | Emit human-readable output. |
| `--output-format json` | Emit one final JSON object. |
| `--output-format streaming-json` | Emit newline-delimited incremental events. |
| `--no-alt-screen` | Run inline without taking over the alternate screen. |
| `--no-auto-update` | Suppress background update checks in scripts and CI. |

The installed CLI may expose additional flags, such as structured-output schema options. Verify them with local help before relying on them.
