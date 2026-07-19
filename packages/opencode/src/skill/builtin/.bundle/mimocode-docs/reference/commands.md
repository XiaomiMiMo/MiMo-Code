# MiMoCode Commands Reference

## CLI (`mimo <command>`)

Invoked from the shell. `mimo` with no command opens the TUI.

| Command | Purpose |
|---------|---------|
| `mimo` | Launch the interactive TUI |
| `mimo run` | Headless, non-interactive run (scripting/eval) |
| `mimo mcp` | Manage / inspect MCP servers |
| `mimo agent` | Manage agents |
| `mimo models` | List available models |
| `mimo providers` | List / manage providers |
| `mimo account` (console) | Account / login console |
| `mimo upgrade` | Update to the latest version |
| `mimo uninstall` | Uninstall MiMoCode |
| `mimo serve` | Run the server |
| `mimo stats` | Usage statistics |
| `mimo export` / `mimo import` | Export / import sessions |
| `mimo session` | Manage sessions |
| `mimo github` / `mimo pr` | GitHub / pull-request integration |
| `mimo generate` | Code generation entry |
| `mimo plugin` (plug) | Manage plugins |
| `mimo db` | Database utilities |
| `mimo acp` / `mimo attach` | ACP / attach to a running session |
| `mimo debug` | Debug utilities |
| `mimo completion` | Generate shell completion script |

Run `mimo <command> --help` for flags on any command.

Notable TUI flags: `--continue`/`-c` (resume last session), `--session`/`-s`, `--model`/`-m`, `--agent`, `--never-ask`, `--trust`, and `--dangerously-skip-permissions` (auto-approve everything not explicitly denied; prompts once for confirmation — see permissions.md).

## Slash commands (inside the TUI)

| Command | Purpose |
|---------|---------|
| `/goal` | Set a stop condition; a judge model verifies it's truly met before the agent halts (prevents premature stops in autonomous work) |
| `/dream` | Scan recent traces, extract durable knowledge into project memory, prune stale entries |
| `/distill` | Detect repeated manual workflows and package high-confidence ones into skills/subagents/commands |
| `/voice` | Toggle streaming voice input (needs `sox`; MiMo-logged-in users) |
| `/loop` | `[interval] <prompt>` — schedule a repeating prompt (also runs once now); maps the interval to a cron job |
| `/loops` | List scheduled cron/loop jobs; `/loops cancel <id>` stops one |
| `/rebuild` | Rebuild the conversation context now from the latest checkpoint — frees context on demand instead of waiting for the automatic overflow trigger. Keeps recent messages verbatim; earlier context collapses to the checkpoint summary. Waits (bounded) for an in-flight checkpoint writer first |
| `/connect` | Sign in to a provider (e.g. OpenRouter) |
| `/<skill-name>` | Invoke any available skill directly by name |

## Keybindings

- `Tab` — cycle primary agents (build → plan → compose).
- Other keybinds are configurable; the keybinds config module governs them.

## Notes

- The web command is currently disabled; TUI is the supported interface.
- Voice ASR (`mimo-v2.5-asr`) is MiMo-platform only; voice control (`mimo-v2.5`) also runs on OpenRouter and compatible relays via the `voice` config (see config.md and the README voice section).
