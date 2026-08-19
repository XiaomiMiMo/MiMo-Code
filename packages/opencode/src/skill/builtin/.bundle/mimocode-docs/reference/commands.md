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
| `mimo llm-server issue`/`list`/`revoke` | Mint and manage tokens that let a task reach this instance's models over `/v1`; it starts nothing — see @capability-api.md |
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

Notable TUI flags: `--continue`/`-c` (resume last session), `--session`/`-s`, `--model`/`-m`, `--agent`, `--never-ask`, `--trust`, and `--dangerously-skip-permissions`/`--yolo` (auto-approve everything not explicitly denied; prompts once for confirmation — see permissions.md).

For terminal compatibility, TUI rendering or lag, and local rendering over SSH with `mimo serve` + `mimo attach`, see @guide.md.

## Slash commands (inside the TUI)

Type `/` to see the commands available in the current context. You can also ask in chat, for example, “Which slash commands can I use?” or “How do I switch models?” MiMoCode will explain the relevant command without requiring you to remember its name.

Most client commands run only when the whole input is the command. `/btw <question>` and prompt commands that accept arguments are the exceptions.

### Application commands

| Command | Aliases | Purpose / availability |
|---------|---------|------------------------|
| `/sessions` | `/resume`, `/continue` | List and continue previous sessions |
| `/workflows` | — | Open the workflow list; shown when the workflow experiment is enabled |
| `/new` | `/clear` | Start a new session |
| `/models` | — | Switch models |
| `/agents` | — | Switch agents |
| `/modalities` | — | Configure a custom model's input modalities (image/audio/video/PDF) |
| `/never-ask` | — | Toggle never-ask permission mode |
| `/skip-permissions` | — | Toggle runtime auto-allow for permission asks; explicit denies still block |
| `/mcps` | — | Show MCP server status |
| `/variants` | — | Switch model variants; shown only when variants are available |
| `/login` | — | Sign in to Xiaomi MiMo |
| `/connect` | — | Connect or sign in to a model provider |
| `/logout` | — | Sign out of Xiaomi MiMo |
| `/org` | `/orgs`, `/switch-org` | Switch organizations; shown when more than one organization is available |
| `/status` | — | Show system and session status |
| `/worktree` | `/wt` | List and switch worktrees |
| `/themes` | — | Choose a color theme |
| `/background` | — | Choose the home-screen background |
| `/logo` | — | Choose the home-screen logo style |
| `/vivid` | — | Toggle Vivid and Minimal visuals |
| `/dark` | — | Switch to dark mode |
| `/light` | — | Switch to light mode |
| `/help` | — | Open command help |
| `/doc` | `/docs` | Open the user documentation |
| `/exit` | `/quit`, `/q` | Exit MiMoCode |
| `/language` | `/lang` | Switch the TUI language |

### Prompt commands

| Command | Purpose |
|---------|---------|
| `/editor` | Edit the current prompt in an external editor |
| `/skills` | Browse and select available skills |
| `/revoke-consent` | Revoke consent for the free service |
| `/voice` | Toggle streaming voice input (requires `sox` and a MiMo login) |
| `/voice-send` | Toggle sending transcribed voice input automatically |
| `/voice-control` | Toggle voice control |

### Session commands

These commands are available while viewing a session. Some appear only when their action is possible.

| Command | Aliases | Purpose / availability |
|---------|---------|------------------------|
| `/share` | — | Share the session; unavailable when sharing is disabled |
| `/rename` | — | Rename the session |
| `/timeline` | — | Open the message timeline |
| `/fork` | — | Fork the session from an earlier message |
| `/compact` | `/summarize` | Summarize a long session to free context |
| `/btw <question>` | — | Ask a side question without adding it to the main conversation context |
| `/unshare` | — | Stop sharing; shown only for a shared session |
| `/undo` | — | Undo the latest message and its file changes |
| `/redo` | — | Restore an undone message and its file changes |
| `/timestamps` | `/toggle-timestamps` | Toggle message timestamps |
| `/thinking` | `/toggle-thinking` | Toggle thinking-block visibility |
| `/copy` | — | Copy the session transcript |
| `/export` | — | Export the session transcript |

### Built-in prompt commands

These commands submit a predefined prompt to the agent and may accept trailing arguments.

| Command | Purpose |
|---------|---------|
| `/init` | Generate or update project `AGENTS.md` guidance from the codebase |
| `/review [target]` | Review a commit, branch, or pull request; defaults to uncommitted changes |
| `/goal <condition>` | Set a judge-verified stop condition; `/goal clear` aborts it |
| `/dream [focus]` | Consolidate durable knowledge from recent work into project memory |
| `/distill [focus]` | Package repeated workflows into skills, subagents, or commands |
| `/rebuild` | Rebuild conversation context from the latest checkpoint while keeping recent messages verbatim |
| `/context-limit` | Pick where the current model compacts (`200K`/`300K`/`500K`/`1M`/custom, or the model default); persists per model as `compaction.max_context`. Refuses while a session is running, because the config write reloads the instance |
| `/deep-research <question>` | Run deep multi-source research; the prompt-command implementation requires the workflow experiment |
| `/loops [cancel <id>]` | List or cancel scheduled jobs; requires the cron experiment |

### Skills and other dynamic commands

The slash menu also includes commands discovered at runtime:

- `/<skill-name>` invokes an available skill; `/loop [interval] <prompt>` schedules a repeating prompt, and `/compose-next` starts the recommended spec-to-ship workflow.
- Project and global Markdown commands from `command/**/*.md` and `commands/**/*.md` use their relative filename as the slash name.
- MCP prompts become slash commands and are marked `:mcp` in autocomplete.
- A custom command or MCP prompt with the same name overrides a built-in prompt command. Skills do not override an existing command.
- Mentioning two or more skills in one chat message can auto-load up to three skills with an orchestration plan.

## Keybindings

- `Tab` — cycle primary agents (build → plan → compose). After the first message the mode locks: Build and Plan can still switch between each other, but Compose is isolated — it can't be entered mid-session, and a session started in Compose stays there. (Many models ignore tools injected mid-conversation; a fixed skill/tool set from session start improves tool-call reliability.)
- Entering plan mode is a user gesture: `Tab` (or the agent dialog) — there is no `plan_enter` tool, so the agent cannot put you in plan mode and will not offer to unless you raise it. Leaving works either way: `Tab` back, or the agent calls `plan_exit` to ask you to approve the finished plan and return to build.
- Other keybinds are configurable; the keybinds config module governs them.

## Notes

- The web command is currently disabled; TUI is the supported interface.
- Voice ASR (`mimo-v2.5-asr`) is MiMo-platform only; voice control (`mimo-v2.5`) also runs on OpenRouter and compatible relays via the `voice` config (see config.md and the README voice section).
