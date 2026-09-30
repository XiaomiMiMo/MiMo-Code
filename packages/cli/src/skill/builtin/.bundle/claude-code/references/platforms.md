# Platform Guide: Windows, macOS, Linux

Detect the OS before issuing any command. Everything in this skill is written in POSIX (bash) syntax; use the translation table below for PowerShell.

## Capability Matrix

| Capability | Linux | macOS | Windows (native) | Windows (WSL) |
|---|---|---|---|---|
| Print mode `-p` | ✅ | ✅ | ✅ PowerShell / Git Bash | ✅ |
| Background `--bg` + `claude agents` | ✅ | ✅ | ✅ | ✅ |
| Interactive tmux orchestration | ✅ | ✅ | ❌ no tmux — use WSL | ✅ |
| `--worktree --tmux` | ✅ classic tmux | ✅ iTerm2 native panes (`--tmux=classic` for plain tmux) | ❌ | ✅ classic |
| `claude mcp add-from-claude-desktop` | ❌ | ✅ | ❌ | ✅ (documented for macOS/WSL) |
| Credential storage | keyring/plaintext config | Keychain | Credential Manager | keyring |

**Routing rule for agents:** on Windows, prefer `-p` and `--bg` (both dialog-free, shell-agnostic). Only fall back to interactive mode if WSL is available (`wsl --status` succeeds); run the entire tmux pattern from `interactive-tmux.md` inside `wsl bash -c '...'` or a WSL shell session.

## Install & Update per OS

```bash
# All platforms (needs Node 18+)
npm install -g @anthropic-ai/claude-code

# Native installer alternative
claude install stable        # after any existing install; --force to reinstall
```

- **Linux/macOS:** if `claude` isn't found after npm install, check `npm prefix -g`/`$PATH`.
- **Windows:** install via an elevated or user-scope npm; requires **Git for Windows** — Claude Code's Bash tool uses Git Bash under the hood on native Windows. Restart the terminal after install so PATH updates.
- **WSL:** install *inside* the WSL distro (Linux instructions), not on the Windows side, if you intend to orchestrate with tmux.

Verify on any OS: `claude --version && claude doctor`.

## Shell Translation Table (bash → PowerShell)

| Purpose | bash (Linux/macOS/WSL/Git Bash) | PowerShell |
|---|---|---|
| Env var (session) | `export ANTHROPIC_API_KEY=sk-...` | `$env:ANTHROPIC_API_KEY = "sk-..."` |
| Env var (persistent) | add to `~/.bashrc` / `~/.zshrc` | `setx ANTHROPIC_API_KEY "sk-..."` (new shells only) |
| Pipe file into `-p` | `cat src/auth.py \| claude -p 'Review'` | `Get-Content src/auth.py -Raw \| claude -p 'Review'` |
| Pipe many files | `cat src/*.py \| claude -p '...'` | `Get-Content src/*.py -Raw \| claude -p '...'` |
| Pipe git diff | `git diff main... \| claude -p 'Review'` | same — git works identically |
| Quoting a prompt | `claude -p 'Fix the "auth" bug'` | `claude -p 'Fix the "auth" bug'` (single quotes are literal in both) |
| Inline JSON args | `--json-schema '{"type":"object"}'` | `--json-schema '{\"type\":\"object\"}'` or here-string `@'...'@` — prefer writing schema/settings to a file and passing the path |
| Extract session_id | `jq -r .session_id out.json` | `(Get-Content out.json \| ConvertFrom-Json).session_id` |
| Redirect JSON result | `> /tmp/session.json` | `> $env:TEMP\session.json` |
| Sequencing | `cmd1 && cmd2` | `cmd1 && cmd2` (PS 7+) or `cmd1; if ($?) { cmd2 }` (PS 5.1) |
| Home dir | `~` or `$HOME` | `~` or `$env:USERPROFILE` |

**Rule of thumb:** complex nested quoting (inline JSON, jq filters) is fragile in PowerShell — write JSON to a temp file and pass the file path (`--settings file.json`, `--mcp-config file.json`, `--json-schema "$(cat schema.json)"` in bash / `--json-schema (Get-Content schema.json -Raw)` in PS).

## Paths & Config Locations

Same layout on every OS, rooted at the user home:

| Item | Linux/macOS | Windows |
|---|---|---|
| Global settings | `~/.claude/settings.json` | `%USERPROFILE%\.claude\settings.json` |
| Global CLAUDE.md / rules / agents / commands | `~/.claude/...` | `%USERPROFILE%\.claude\...` |
| MCP user scope | `~/.claude.json` | `%USERPROFILE%\.claude.json` |
| Auto-memory | `~/.claude/projects/<project>/memory/` | `%USERPROFILE%\.claude\projects\<project>\memory\` |
| Project files | `./CLAUDE.md`, `.claude/` | same (relative) |

Forward slashes work in most Claude Code path arguments on Windows; prefer them in scripts to avoid backslash-escaping bugs.

**WSL path warning:** WSL sees Windows drives at `/mnt/c/...`, but a project's Claude state is keyed by path — a repo opened from `/mnt/c/repo` (WSL) and `C:\repo` (native) are *different projects* with separate sessions, trust decisions, and auto-memory. Also, running Claude Code from WSL against `/mnt/c/...` incurs slow cross-filesystem I/O; keep WSL-orchestrated repos inside the WSL filesystem when possible.

## Per-OS Gotchas

### Windows (native)
1. No tmux → interactive orchestration impossible; use `-p` / `--bg`, or WSL.
2. `python` vs `python3`: Windows typically has `python` (or the `py` launcher) but *not* `python3` — the inverse of the Linux quirk. Claude self-corrects, costing a turn.
3. `setx` truncates values >1024 chars and only affects *new* shells; use `$env:` for the current session.
4. Antivirus/Defender can slow `npm install -g` and first launch; exclude the npm global dir if launches hang.
5. Line endings: set `git config core.autocrlf input` in repos Claude edits from both Windows and WSL, or diffs fill with CRLF noise.
6. Long-path errors on deep node_modules: enable `git config --system core.longpaths true` and Windows long-path support.

### Windows (WSL)
1. Detect with `wsl --status` from PowerShell; enter via `wsl` or run one-shots as `wsl bash -c 'cd /path && claude -p "task" --max-turns 5'`.
2. Auth/config live inside the distro — logging in on native Windows does not authenticate WSL, and vice versa.
3. tmux patterns from `interactive-tmux.md` work unmodified inside WSL.

### macOS
1. First-run Gatekeeper/keychain prompts may appear when Claude Code accesses the Keychain for OAuth tokens — approve once; in headless CI contexts prefer `--bare` + `ANTHROPIC_API_KEY` to avoid keychain reads entirely.
2. `--worktree --tmux` uses iTerm2 native panes when iTerm2 is present; force plain tmux with `--tmux=classic` when your orchestrator parses `tmux capture-pane` output.
3. Default shell is zsh — irrelevant for `-p` calls, but source `~/.zshrc` (not `.bashrc`) when persisting env vars.
4. `claude mcp add-from-claude-desktop` works here (and WSL) to import Claude Desktop's MCP servers.

### Linux
1. `python` symlink often missing (only `python3`) — Claude's first `python` call fails, then self-corrects.
2. Headless servers: no keychain → OAuth tokens stored in config; for CI prefer `--bare` + `ANTHROPIC_API_KEY` or `claude setup-token`.
3. tmux availability is assumed by this skill — `apt-get install -y tmux` (or distro equivalent) before interactive orchestration.

## Cross-Platform Recipes

```bash
# OS detection (bash)
case "$(uname -s)" in Linux*) os=linux;; Darwin*) os=mac;; MINGW*|MSYS*|CYGWIN*) os=win-gitbash;; esac
```

```powershell
# OS/WSL detection (PowerShell)
$IsWinNative = $env:OS -eq 'Windows_NT'
$HasWSL = (wsl --status 2>$null); if ($LASTEXITCODE -eq 0) { "WSL available" }
```

```powershell
# Windows-native print-mode run with structured output
claude -p 'Fix the auth bug in src/auth.py' --allowedTools 'Read,Edit' --max-turns 10 --output-format json |
  Out-File -Encoding utf8 $env:TEMP\result.json
$r = Get-Content $env:TEMP\result.json | ConvertFrom-Json
$r.subtype; $r.session_id; $r.total_cost_usd
```

```powershell
# Windows: interactive work via WSL tmux from PowerShell
wsl bash -c "tmux new-session -d -s claude-work -x 140 -y 40"
wsl bash -c "tmux send-keys -t claude-work 'cd /home/user/project && claude' Enter"
wsl bash -c "sleep 5 && tmux capture-pane -t claude-work -p -S -50"
```
