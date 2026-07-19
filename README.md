<h1 align="center">MiMoCode</h1>

<p align="center">
  <img src="assets/readme/mimocode-banner.png" alt="MiMoCode" width="700">
</p>

<p align="center"><strong>MiMo Code: Where Models and Agents Co-Evolve</strong></p>

<p align="center">
  <a href="README.zh.md">中文</a> | English
</p>

<p align="center">
  <a href="https://mimo.xiaomi.com/coder">Website</a> | <a href="https://mimo.xiaomi.com/en/blog/mimo-code-long-horizon">Blog</a>
</p>

---

MiMoCode is a terminal-native AI coding assistant. It can read and write code, run commands, manage Git, and use a persistent memory system to keep a deep understanding of your project across sessions while continuously improving itself.

MiMo Auto is built in as a free-for-limited-time channel, so you can start with zero configuration. MiMoCode also supports connecting to any mainstream LLM provider API.

---

## Quick Start

```bash
# One-line install (macOS / Linux)
curl -fsSL https://mimo.xiaomi.com/install | bash

# One-line install (Windows PowerShell)
powershell -ep Bypass -c "irm https://mimo.xiaomi.com/install.ps1 | iex"

# Or install via npm (all platforms)
npm install -g @mimo-ai/cli

# Run
mimo
```

The first launch guides you through configuration automatically. Supported options:
- **MiMo Auto (free for a limited time)** — anonymous channel, zero configuration
- **Xiaomi MiMo Platform** — OAuth login
- **Import from Claude Code** — migrate existing authentication in one step
- **Custom Provider** — add any OpenAI-compatible API in the TUI

<details>
<summary><strong>WSL: clipboard issues</strong></summary>

If you encounter garbled text when copying on WSL, install `xsel`:
```bash
sudo apt install xsel
```
</details>

<details>
<summary><strong>Windows: garbled CJK (Chinese/Japanese/Korean) output in the shell</strong></summary>

On Windows with a non-UTF-8 system locale (e.g. zh-CN, whose active code page is 936/GBK),
command output containing CJK characters may appear garbled (mojibake). MiMoCode forces
UTF-8 output for spawned PowerShell/cmd subprocesses. If you still encounter garbled output
in cases this does not yet cover, enable Windows' system-wide UTF-8 support:

**Settings → Time & language → Language & region → Administrative language settings →
Change system locale → check "Beta: Use Unicode UTF-8 for worldwide language support" →
reboot.**

This switches the active code page (ACP) to UTF-8 (65001) for all programs, so subprocesses
no longer inherit the legacy code page. Note it is a system-wide Beta toggle and may cause
some older non-Unicode programs to display incorrectly, so treat it as a workaround.
</details>

---

## MiMo Ecosystem

Beyond MiMoCode, Xiaomi MiMo models also work in other agents and coding tools like Cursor, Cline, and Zed.

**[awesome-mimo-agent](https://github.com/XiaomiMiMo/awesome-mimo-agent)** collects setup guides for using MiMo in those tools — worth a look if you want to try MiMo elsewhere. Contributions welcome: open a PR to add your own setup.

---

## Core Features

### Multiple Agents

| Agent | Description |
|--------|------|
| **build** | Default. Full tool permissions for development |
| **plan** | Read-only analysis mode for code exploration and solution design |
| **compose** | Orchestration mode for specs-driven development and skill-driven workflows |

Press `Tab` to switch between primary agents. Subagents are created by the system as needed.

### Persistent Memory

Cross-session memory powered by SQLite FTS5 full-text search:

- **Project memory** (`MEMORY.md`) — persistent project knowledge, rules, and architecture decisions
- **Session checkpoint** (`checkpoint.md`) — structured state snapshots maintained automatically by the checkpoint-writer subagent
- **Scratch notes** (`notes.md`) — temporary note area for agents
- **Task progress** (`tasks/<id>/progress.md`) — per-task logs

Memory is injected automatically when a session resumes, so the agent does not need to relearn project context.

### Intelligent Context Management

- **Automatic checkpoints** — decides when to save session state based on the model context window
- **Context reconstruction** — when context approaches the limit, rebuilds it from the latest checkpoint, project memory, task progress, and retained recent messages so the agent can continue the current task
- **Budgeted injection** — uses a token budget to control how much checkpoint, memory, and notes content enters context, with importance ranking

### Task Tracking

A tree-shaped task system (`T1`, `T1.1`, `T1.2`, …) that integrates automatically with the checkpoint system, so task progress is preserved when sessions resume.

### Subagent System

The primary agent can create subagents on demand. Subagents share the current session context and can work in parallel, with lifecycle tracking, cancellation, and background execution.

### Goal / Stop Condition

The `/goal` command sets a stopping condition for a session. When the agent tries to stop, an independent judge model evaluates the conversation to decide whether the condition is truly satisfied — preventing premature "optimistic stops" during autonomous work.

### Compose Mode

Compose mode provides a structured workflow for specs-driven development. It includes built-in skills for planning, execution, code review, TDD, debugging, verification, and merging — orchestrating the full lifecycle from spec to shipped code.

### Workflows

Workflows are deterministic JavaScript scripts that orchestrate multiple agents in a sandboxed runtime. Unlike agent conversations, workflows encode fixed phase sequences with bounded retries and automatic parallelization — fire-and-forget execution with no user interaction required.

MiMoCode ships with three built-in workflows:

| Workflow | Phases | Description |
|----------|--------|-------------|
| `compose` | Brainstorm → Design → Implement → Verify → Review → Report → Merge | Full development pipeline. Auto-parallelizes independent tasks into isolated git worktrees, applies TDD per task, chains structured output between phases. Best for well-defined tasks that decompose into independent subtasks. |
| `deep-research` | Brief → Plan → Research → Reflect → Write → Review | Multi-source deep research report generator. Plans independent research angles, runs parallel sub-agents to collect cited findings, reflects on gaps, writes a single coherent Markdown report, then cold-reviews citations. Convergent: resumable via file checkpoints. |
| `fact-check` | Plan → Search → Extract → Group → Crosscheck → Report | Adversarial fact verification. Runs parallel web searches, extracts checkable facts, groups duplicates, then cross-checks each with a 3-juror adversarial vote. Best for precise claims ("Is X true?"). |

The compose workflow complements the compose agent: use the **workflow** when requirements are clear and tasks split cleanly (deterministic, parallel, non-interactive); use the **agent** when you need to redirect mid-flow or inject judgment between steps (conversational, interactive).

**Custom workflows:** Place a `.js` file in `.mimocode/workflows/` or `.claude/workflows/` to define your own, or override a built-in by using the same name (e.g. `.mimocode/workflows/compose.js`).

### Builtin Skills

Skills are reusable instruction sets that teach agents how to handle specific tasks (e.g. generating PDFs, writing academic papers, searching arXiv). MiMoCode ships with the following builtin skills:

| Skill | Description |
|-------|-------------|
| `arxiv` | Search, read, cite, and analyze arXiv papers |
| `docx-official` | Produce, read, and transform Word (.docx) files |
| `pdf-official` | Produce, read, fill, and transform PDF files |
| `pptx-official` | Author and manipulate PowerPoint (.pptx) decks |
| `xlsx-official` | Build, clean, and transform spreadsheets (.xlsx/.csv) |
| `design-blueprint` | Produce a design blueprint (DESIGN.md + Decision Trace) before mocking up visuals |
| `frontend-design` | Visual design guidance for UI work |
| `html-to-video-pipeline` | HTML-to-MP4 rendering via headless browser + ffmpeg |
| `research-paper-writing` | Write and polish academic papers (ML/CV/NLP style) |
| `skill-creator` | Interactive guide for creating and improving agent skills |
| `evolve` | Total self-modification — rewrite any layer of the agent: tools, behavior hooks, knowledge, workflows, even the UI |
| `loop` | Schedule recurring prompts on a fixed cadence |
| `mimocode` | Self-documenting reference for MiMoCode features and config |

**Overriding a builtin skill:** Create a skill with the same `name` in your project (`.mimocode/skills/<name>/SKILL.md`) or personal skill directory (`~/.claude/skills/`, `~/.opencode/skills/`, etc.). User skills discovered later in the scan order override builtins with the same name.

<details>
<summary><strong>Disabling builtin skills via environment variables</strong></summary>

| Variable | Effect |
|----------|--------|
| `MIMOCODE_DISABLE_BUILTIN_SKILLS=true` | Disable all builtin skills |
| `MIMOCODE_DISABLE_OFFICIAL_SKILLS=true` | Disable only the office/media skills: `docx-official`, `pdf-official`, `pptx-official`, `xlsx-official`, `html-to-video-pipeline` |

When disabled, the corresponding skills are removed from the agent's available skill list entirely — they will not appear in context and cannot be invoked.

</details>

### Voice Input

Real-time streaming voice input powered by TenVAD and MiMo ASR. Activate with `/voice`, then speak — audio is segmented by pauses and transcribed incrementally into the input. Available for MiMo logged-in users. Requires `sox` (`brew install sox` on macOS, other platforms similar).

<details>
<summary><strong>WSLg audio setup</strong></summary>

```bash
sudo apt install -y sox pulseaudio libasound2-plugins
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
```
</details>

<details>
<summary><strong>SSH remote audio (Mac → remote host)</strong></summary>

```bash
# Mac (local)
brew install pulseaudio
pulseaudio --load="module-native-protocol-tcp auth-ip-acl=127.0.0.1" --exit-idle-time=-1 --daemonize
# Add to ~/.ssh/config: RemoteForward 4713 127.0.0.1:4713

# Remote host
apt install -y pulseaudio pulseaudio-utils sox
export PULSE_SERVER=tcp:127.0.0.1:4713
# Verify: pactl info
```
</details>

<details>
<summary><strong>Non-MiMo voice providers (OpenRouter, internal API, etc.)</strong></summary>

Voice input can route through other OpenAI-compatible providers via the `voice` config field. The ASR model (`mimo-v2.5-asr`) is only available on MiMo's platform; voice control mode (`mimo-v2.5`) is available on OpenRouter and compatible relay platforms.

**OpenRouter (voice control only):**

Use `/connect` to sign in to OpenRouter, then add to your config:
```jsonc
{
  "voice": {
    "control_model": "openrouter/xiaomi/mimo-v2.5"
  }
}
```

**Internal / self-hosted relay (both ASR and voice control):**
```jsonc
{
  "provider": {
    "internal": {
      "options": {
        "baseURL": "https://your-api-gateway.example.com/v1",
        "apiKey": "sk-..."
      },
      "models": {
        "xiaomi/mimo-v2.5-asr": { "name": "MiMo-V2.5-ASR" },
        "xiaomi/mimo-v2.5": { "name": "MiMo-V2.5" }
      }
    }
  },
  "voice": {
    "asr_model": "internal/xiaomi/mimo-v2.5-asr",
    "control_model": "internal/xiaomi/mimo-v2.5"
  }
}
```

Custom providers must register at least one model in their `models` field to be recognized. The model names in `voice.*_model` are sent directly to the API — they don't need to match the registered model keys exactly.

> **Note:** Models registered under a custom provider will appear in the model selection list. Don't use ASR-only models (e.g. `mimo-v2.5-asr`) as your primary coding model.

</details>

### Dream & Distill

- **`/dream`** — scans recent session traces, extracts persistent knowledge into project memory, and removes outdated entries
- **`/distill`** — discovers repeated manual workflows in recent work and packages high-confidence candidates into reusable skills, subagents, or commands

---

## Configuration

MiMoCode uses JSON/JSONC config files with published JSON Schemas for autocompletion and validation.

### File Locations

| File | Project-level | Global |
|------|--------------|--------|
| Main config | `.mimocode/mimocode.jsonc` | `~/.config/mimocode/mimocode.json` |
| TUI config | `.mimocode/tui.json` | `~/.config/mimocode/tui.json` |
| Auth credentials | — | `~/.local/share/mimocode/auth.json` |

> On Windows, XDG paths fall under `%LOCALAPPDATA%\mimocode\`. You can override all paths with `MIMOCODE_HOME`.

### JSON Schemas

MiMoCode auto-injects a `$schema` field when it first loads your config, so your editor gets completions and validation out of the box:

| Config | Schema URL |
|--------|-----------|
| `mimocode.jsonc` / `mimocode.json` | `https://mimo.xiaomi.com/mimocode/config.json` |
| `tui.json` | `https://mimo.xiaomi.com/mimocode/tui.json` |

<details>
<summary><strong>VS Code / Cursor: trust the schema domain</strong></summary>

Add to your `settings.json` so the editor can download schemas for autocompletion:

```json
{
  "json.schemaDownload.trustedDomains": {
    "https://mimo.xiaomi.com/": true
  }
}
```

</details>

<details>
<summary><strong>Data directories</strong></summary>

Beyond config files, MiMoCode stores runtime data under XDG paths (or `$MIMOCODE_HOME`):

| Directory | Default (Linux) | Contents |
|-----------|----------------|----------|
| data | `~/.local/share/mimocode/` | SQLite database, auth credentials (`auth.json`), memory, logs |
| state | `~/.local/state/mimocode/` | TUI preferences (`kv.json`), recent models (`model.json`) |
| cache | `~/.cache/mimocode/` | Language servers, cached model catalog, skills |

To remove stored credentials, delete `auth.json` from the data directory. On macOS, XDG data defaults to `~/Library/Application Support/mimocode/`.

</details>

### Key Options

- Provider and model selection
- Agent permissions and custom agents
- Checkpoint and memory behavior
- MCP server connections
- Keybindings and theme

Max Mode (parallel best-of-N reasoning with judge selection) can be enabled via `experimental.maxMode` in the config.

<details>
<summary><strong>Allowing the system temp directory (<code>/tmp</code>)</strong></summary>

By default, reading or writing files outside the project working directory triggers an
`external_directory` permission prompt — including the system temp directory. This is
intentional: MiMoCode does not silently widen permissions, so you stay in control of what
the model can touch outside your project.

The temp directory comes up often because most models reach for it as scratch space (e.g.
a quick script, a throwaway data file). If you trust your environment and would rather not
be prompted each time, you can opt in by allowing it in your config:

```json title=".mimocode/mimocode.json"
{
  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",
  "permission": {
    "external_directory": {
      "/tmp/**": "allow"
    }
  }
}
```

**This setting has known risks — use it at your own risk.** The temp directory is
world-writable and shared with every other process and user on the machine. Auto-allowing
it means the model can read and write there without confirmation, which widens your exposure
to predictable temp-path / symlink tricks (e.g. another process pre-creating `/tmp/foo` as a
symlink to a sensitive file). For that reason it is only recommended for single-user,
controlled environments or inside a container. Keep the allowlist as narrow as possible.

</details>

<details>
<summary><strong>Skipping permission prompts (<code>--dangerously-skip-permissions</code>)</strong></summary>

For trusted, disposable environments (containers, sandboxes, CI) you can auto-approve
everything the agent does instead of confirming each action:

```bash
# TUI — prompts once for an explicit confirmation on startup
mimo --dangerously-skip-permissions

# Headless
mimo run --dangerously-skip-permissions "your prompt"

# Or via environment variable (any surface)
MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS=1 mimo
```

This injects an **allow-all base underneath your config**, so a tool with no rule
auto-approves — but any explicit rule you wrote still wins (the last matching rule wins,
and your rules sit after the injected `*`). A `deny` still blocks; note that a leftover
`ask` rule also still prompts, and a top-level `"*": "ask"` makes the flag a no-op. In the
TUI it shows a red warning and requires you to accept the risk before it takes effect (the
prompt is skipped when there is no TTY, so in CI it activates with no confirmation).

**This is dangerous.** With permissions bypassed, a malicious prompt, file, or plugin can
run arbitrary shell commands and read, modify, or exfiltrate your data without any
confirmation. Only use it where you fully trust the workspace.

</details>

---

## Development

```bash
bun ci                   # Install dependencies (= bun install --frozen-lockfile)
bun run dev              # Run in development mode
bun turbo typecheck      # Type check
```

---

## Relationship to OpenCode

MiMoCode is built as a fork of [OpenCode](https://github.com/anomalyco/opencode). It keeps all core OpenCode capabilities (multiple providers, TUI, LSP, MCP, plugins) and adds persistent memory, intelligent context management, subagent orchestration, goal-driven autonomous loops, compose workflows, and self-improvement via dream/distill.

---

## Community

Scan the QR code to join the community group chat:

<p align="center">
  <img src="assets/readme/community-qrcode-1.jpg" alt="Community group chat QR code 1" width="240">
  &nbsp;&nbsp;
  <img src="assets/readme/community-qrcode-2.jpg" alt="Community group chat QR code 2" width="240">
</p>

---

## License

Source code is licensed under the [MIT License](./LICENSE).

Use of MiMoCode is also subject to the [Use Restrictions](./USE_RESTRICTIONS.md).
Use of Xiaomi MiMo-hosted services is subject to the [MiMo Terms of Service](https://platform.xiaomimimo.com/docs/terms/user-agreement).
Use of the MiMo name, logo, and trademarks is subject to the MiMo Trademark Policy.
