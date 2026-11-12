---
feature: unify-default-harness
status: in-progress
updated: 2026-11-12
source: feat/unify-default-harness
---

# Unify Default Harness

## Report
[Not finalized yet]

## [S1] Problem
The harness still carries mid-2026 per-vendor fitting: the system prompt is
chosen by model id (anthropic, beast, gemini, kimi, deepseek, glm, minimax,
trinity, default), Claude models get a separate git-status environment block,
the vision-capability notice is masked for gpt/claude/gemini ids, and any model
whose id contains `gpt` is forced into Codex mode (`exec`-only toolset plus the
`gpt.txt` prompt) unless `MIMOCODE_CODEX_MODE=false`. Strong models now
generalize, so the harness should have one default shape for every model.

## [S2] Design

### S2.1 Codex mode is opt-in only
Codex mode (`gpt.txt` system prompt, `exec` top-level toolset, `bash.gpt.txt`,
`apply_patch`/`view_image`, forced MCP deferral, `generate-gpt.txt` for agent
generation) is kept as a feature. Resolution, first match wins:
1. `MIMOCODE_CODEX_MODE=false` → off.
2. session harness `"codex"` → on; `"default"` → off.
3. otherwise (`"auto"` or absent) → on only when `MIMOCODE_CODEX_MODE=true`.

With the flag unset, `"auto"` and `"default"` both mean the default harness for
every model. Model identity
no longer participates; `isGPTModel` is removed. The `harness` field, its enum
and persistence are unchanged; only the `.describe()` text is updated.

### S2.2 One default system prompt
Outside Codex mode, every model receives `default.txt`. The per-vendor prompt
files and the already-unreferenced `default.old.txt` / `copilot-gpt-5.txt` are
deleted. Their content is not merged; future polishing of `default.txt` may
consult git history.

### S2.3 One environment block
The Claude-only environment block (git branch/status/user/commits and its
cache) is removed; every model gets the generic `<env>` block. The
vision-capability notice depends only on `model.capabilities.input.image`.

### S2.4 Dead helpers
`SessionRetry.isGptModel` (no callers) is removed.

### S2.5 Compatibility
No schema, migration or SDK type change. Existing TUI/CLI sessions on GPT
models without the flag switch from Codex to the default toolset once, with a
one-time prompt-cache miss (accepted). Desktop already sends `harness:"default"`
with `MIMOCODE_CODEX_MODE=false` and overrides the system prompt, so it is
unaffected.

## [S3] Out of Scope
- Rewriting or improving `default.txt` content.
- Turning Codex mode into a general profile system or adding a CLI/TUI entry.
- Transport/API-compat model branches (`provider/transform.ts`, OAuth
  instructions routing, `classify.ts` reasoning-only rule, retry overload
  detection).
- Removing exec / apply_patch / view_image or their renderers.

## Tasks
- [ ] T1: Make Codex mode opt-in in `tool/gpt.ts` and its callers (registry, prompt, system, agent generate) — acceptance: GPT model ids with flag unset and harness auto/default get the default toolset and prompt; `harness:"codex"` or flag `true` enable Codex mode; flag `false` wins (covers: S2.1)
- [ ] T2: Collapse `SystemPrompt.provider` to default/gpt and delete vendor prompt files — acceptance: every non-Codex model returns `default.txt`; deleted files unreferenced (covers: S2.2)
- [ ] T3: Remove Claude env block and vision id mask — acceptance: Claude gets the generic env block; vision notice keyed on capability only (covers: S2.3)
- [ ] T4: Remove `SessionRetry.isGptModel` — acceptance: no references remain (covers: S2.4)
- [ ] T5: Update tests and regenerate SDK description text — acceptance: typecheck and affected test suites pass (depends: T1, T2, T3, T4)

## Journey log
None
