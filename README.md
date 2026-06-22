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
# One-line install
curl -fsSL https://mimo.xiaomi.com/install | bash

# Or install via npm
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

MiMoCode is configured via `.mimocode/mimocode.json` in the project directory (or `~/.config/mimocode/mimocode.json` globally). Key options include:

- Provider and model selection
- Agent permissions and custom agents
- Checkpoint and memory behavior
- MCP server connections
- Keybindings and theme

Max Mode (parallel best-of-N reasoning with judge selection) can be enabled via `experimental.maxMode` in the config.

---

## Development

```bash
bun install              # Install dependencies
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
