<h1 align="center">Devora</h1>

<p align="center">
  <img src="assets/readme/devora-banner.png" alt="Devora" width="700">
</p>

<p align="center"><strong>Sheri Akhtamov's open-source AI coding agent with cross-session memory.</strong></p>

<p align="center">
  <a href="README.zh.md">中文</a> | English
</p>

<p align="center">
  <a href="https://github.com/SheriAkhtamov/Devora">Repository</a> | <a href="https://github.com/SheriAkhtamov/Devora/releases">Releases</a>
</p>

---

Devora is a terminal-native AI coding assistant maintained by Sheri Akhtamov. It can read and write code, run commands, manage Git, and use a persistent memory system to keep a deep understanding of your project across sessions while continuously improving itself.

Devora Auto is built in as a free-for-limited-time channel, so you can start with zero configuration. Devora also supports connecting to any mainstream LLM provider API.

---

## Quick Start

```bash
# One-line install
curl -fsSL https://raw.githubusercontent.com/SheriAkhtamov/Devora/main/install | bash

# Or install via npm
npm install -g @devora-ai/cli
```

The first launch guides you through configuration automatically. Supported options:
- **Devora Auto (free for a limited time)** — anonymous channel, zero configuration
- **Devora Platform** — OAuth login
- **Import from Claude Code** — migrate existing authentication in one step
- **Custom Provider** — add any OpenAI-compatible API in the TUI

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

Real-time streaming voice input powered by TenVAD and Devora ASR. Activate with `/voice`, then speak — audio is segmented by pauses and transcribed incrementally into the input. Available for Devora logged-in users.

### Dream & Distill

- **`/dream`** — scans recent session traces, extracts persistent knowledge into project memory, and removes outdated entries
- **`/distill`** — discovers repeated manual workflows in recent work and packages high-confidence candidates into reusable skills, subagents, or commands

---

## Configuration

Devora is configured via `.devora/devora.jsonc` in the project directory (or `~/.config/devora/devora.jsonc` globally). Key options include:

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

## Project

Devora is maintained by Sheri Akhtamov in [SheriAkhtamov/Devora](https://github.com/SheriAkhtamov/Devora). This repository contains the CLI, desktop app, web UI, SDK, plugin system, release scripts, and update configuration for the Devora distribution.

---

## Community

Scan the QR code to subscribe to the author’s channel:

<p align="center">
  <img src="assets/readme/community-qrcode-1.jpg" alt="Community group chat QR code 1" width="240">
</p>

---

## License

Source code is licensed under the [MIT License](./LICENSE).

Use of Devora is also subject to the [Use Restrictions](./USE_RESTRICTIONS.md).
Provider-hosted services are subject to the terms of the provider you configure.
The Devora name, logo, and distribution branding are maintained by Sheri Akhtamov.
