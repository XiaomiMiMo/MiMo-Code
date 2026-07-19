# Interactive Sessions via tmux

Claude Code is a full TUI app — interactive orchestration requires tmux (`capture-pane` for monitoring, `send-keys` for input).

**Platforms:** Linux/macOS run these patterns directly (macOS: `--worktree --tmux` prefers iTerm2 panes; force `--tmux=classic` when parsing capture-pane output). **Windows has no native tmux** — run every pattern in this file inside WSL (`wsl bash -c '...'`), or use print/background mode instead. See `references/platforms.md`.

## Base Pattern

```
terminal(command="tmux new-session -d -s claude-work -x 140 -y 40")
terminal(command="tmux send-keys -t claude-work 'cd /path/to/project && claude' Enter")
terminal(command="sleep 5 && tmux send-keys -t claude-work 'Refactor the auth module to use JWT tokens' Enter")
terminal(command="sleep 15 && tmux capture-pane -t claude-work -p -S -50")   # monitor
terminal(command="tmux send-keys -t claude-work 'Now add unit tests for the new JWT code' Enter")
terminal(command="tmux send-keys -t claude-work '/exit' Enter")
```

Always `tmux kill-session -t <name>` when done — background sessions persist.

## Startup Dialogs (MUST handle)

### Dialog 1: Workspace trust (first visit to a directory only, then cached)
```
❯ 1. Yes, I trust this folder    ← DEFAULT
  2. No, exit
```
Handling: `tmux send-keys -t <session> Enter` (default is correct).

### Dialog 2: Bypass-permissions warning (every `--dangerously-skip-permissions` run)
```
❯ 1. No, exit                    ← DEFAULT (WRONG choice!)
  2. Yes, I accept
```
Handling: `tmux send-keys -t <session> Down && sleep 0.3 && tmux send-keys -t <session> Enter`

### Robust launch sequence
```
terminal(command="tmux send-keys -t claude-work 'claude --dangerously-skip-permissions \"your task\"' Enter")
terminal(command="sleep 4 && tmux send-keys -t claude-work Enter")                                    # trust
terminal(command="sleep 3 && tmux send-keys -t claude-work Down && sleep 0.3 && tmux send-keys -t claude-work Enter")  # bypass
terminal(command="sleep 15 && tmux capture-pane -t claude-work -p -S -60")
```

In `-p` / non-TTY mode both dialogs are auto-skipped.

## Monitoring the TUI

```
tmux capture-pane -t dev -p -S -10
```

Indicators:
- `❯` at bottom = waiting for input (done or asking a question)
- `●` lines = actively using tools
- `⏵⏵ bypass permissions on` = permissions mode in status bar
- `◐ medium · /effort` = current effort level
- `ctrl+o to expand` = truncated tool output

Don't kill slow sessions — check progress instead; Claude may be mid multi-step work.

### Context health (`/context`)
- < 70%: normal
- 70–85%: precision dropping → `/compact`
- > 85%: hallucination risk spikes → `/compact` or `/clear`

## Worktrees & PR Review

```
claude -w feature-x --tmux         # isolated git worktree at .claude/worktrees/feature-x + tmux session
                                   # iTerm2 native panes when available; --tmux=classic for traditional tmux
claude -p 'Review this PR thoroughly' --from-pr 42 --max-turns 10
claude ultrareview [pr#] [--json] [--timeout <min>]   # cloud multi-agent review; exit 0/1; default 30 min
```

Deep interactive review:
```
terminal(command="tmux new-session -d -s review -x 140 -y 40")
terminal(command="tmux send-keys -t review 'cd /repo && claude -w pr-review' Enter")
terminal(command="sleep 5 && tmux send-keys -t review Enter")   # trust dialog
terminal(command="sleep 2 && tmux send-keys -t review 'Review all changes vs main: bugs, security, race conditions, missing tests.' Enter")
terminal(command="sleep 30 && tmux capture-pane -t review -p -S -60")
```

## Slash Commands

### Session & context
| Command | Purpose |
|---|---|
| `/help` | All commands (incl. custom + MCP) |
| `/compact [focus]` | Compress context; CLAUDE.md survives |
| `/clear` | Wipe history |
| `/context` | Context usage grid + tips |
| `/cost` | Token usage, per-model + cache-hit breakdown |
| `/resume` | Switch/resume sessions |
| `/rewind` | Revert to a checkpoint (conversation or code) |
| `/btw <q>` | Side question without context cost |
| `/status` | Version/connectivity/session info |
| `/todos` | Tracked action items |
| `/exit` / `Ctrl+D` | End session |

### Development
| Command | Purpose |
|---|---|
| `/review` | Code review of current changes |
| `/security-review` | Security analysis |
| `/plan [desc]` | Plan mode with auto-start |
| `/loop [interval]` | Recurring tasks in-session |
| `/batch` | Auto-create worktrees for large parallel changes (5–30) |

### Config & tools
| Command | Purpose |
|---|---|
| `/model` · `/effort` | Switch model / effort (`low`→`ultracode`) |
| `/init` · `/memory` | Create / edit CLAUDE.md |
| `/config` · `/permissions` · `/agents` · `/mcp` · `/add-dir` | Interactive config UIs |
| `/usage` | Plan limits & rate-limit status |
| `/voice` | Push-to-talk voice mode |
| `/release-notes` | Version notes picker |

Slash commands only work interactively — in `-p` mode describe the task in natural language.

## Keyboard Shortcuts & Prefixes

| Key | Action |
|---|---|
| `Ctrl+C` / `Ctrl+D` | Cancel / exit |
| `Ctrl+R` | Reverse-search history |
| `Ctrl+B` | Background a running task |
| `Ctrl+V` | Paste image |
| `Ctrl+O` | Transcript mode (thinking) |
| `Ctrl+G` / `Ctrl+X Ctrl+E` | External editor |
| `Esc Esc` | Rewind / summarize |
| `Shift+Tab` | Cycle permission modes |
| `Alt+P` / `Alt+T` / `Alt+O` | Model / thinking / Fast Mode toggles |
| `\`+`Enter`, `Shift+Enter`, `Ctrl+J` | Newline |

| Prefix | Action |
|---|---|
| `!` | Direct bash, bypass AI (`!` alone toggles shell mode) |
| `@` | File/dir reference with autocomplete; also `@agent-name`, `@github:issue://123` |
| `#` | Quick-add to CLAUDE.md memory |
| `/` | Slash commands |

Keyword **"ultrathink"** in a prompt = maximum reasoning effort for that turn, regardless of `/effort`.

## Parallel Instances

Hand-rolled tmux fan-out (small scale only):

```
tmux new-session -d -s task1 -x 140 -y 40 && tmux send-keys -t task1 'cd ~/project && claude -p "Fix auth bug" --allowedTools "Read,Edit" --max-turns 10' Enter
# ... task2, task3 ...
for s in task1 task2 task3; do echo "=== $s ==="; tmux capture-pane -t $s -p -S -5; done
```

For large fan-outs prefer `--bg` + `claude agents --json --all` (native supervision).
