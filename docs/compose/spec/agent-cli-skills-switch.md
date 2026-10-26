---
feature: agent-cli-skills-switch
status: delivered
updated: 2026-03-14
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2715
---

# Agent CLI Skills Switch

## Report

**What was built** — Agent-CLI skills (`claude-code`, `codex`, `grok-build`) extract only when `MIMOCODE_ENABLE_AGENT_CLI_SKILLS=true` (default off). Binary `which` gating is gone, so the extract set is a pure function of env. All three SKILL.md descriptions share one invocation contract (explicit user authorization, confirm the CLI binary before running, no general coding). Host-only `agents/openai.yaml` is removed from the bundle. Docs no longer claim binary-gated discovery.

**Verification** — From `packages/cli`: `bun typecheck` PASS; `bun test test/skill` 67 pass / 0 fail; `bun test test/tool/skill.test.ts test/tool/skill-search.test.ts` 4 pass / 3 skip (PRE-EXISTING skip) / 0 fail. External brand-root suites in `test/skill/skill-external-roots.test.ts` still pass.

## [S1] Problem

Bundled skills that operate other agent CLIs (`claude-code`, `codex`,
`grok-build`) have unstable discovery:

- `claude-code` and `codex` are extracted only when `which` finds `claude` /
  `codex`, so the skill surface flips with PATH (nvm, GUI vs shell, WSL).
- `grok-build` has no binary gate and is always present — inconsistent.
- Descriptions disagree on implicit invocation (`codex` reads like a general
  automation doc).
- `agents/openai.yaml` ships in two of the three packages; MiMoCode never reads
  it and it confuses the preinstalled skill surface.

## [S2] Design

### S2.1 One env switch, default off

`MIMOCODE_ENABLE_AGENT_CLI_SKILLS` (default false). When true, the three agent
CLI skills extract and load like ordinary builtins. When false, they are not
extracted and do not appear in any surface.

Mapping is env → extract set. The same env value always yields the same skill
set; binary presence is not consulted.

### S2.2 Drop binary gating

Remove `REQUIRED_COMMANDS` and `isBuiltinSkillInstalled` from
`skill/builtin/extract.ts`. Extraction filters on `AGENT_CLI_SKILL_NAMES` and
`Flag.MIMOCODE_ENABLE_AGENT_CLI_SKILLS` the same way `OFFICIAL_SKILL_NAMES` and
`MIMOCODE_DISABLE_OFFICIAL_SKILLS` already work (opt-in vs opt-out).

### S2.3 Unified invocation contract

All three `SKILL.md` descriptions state the same rules:

- Load only when the user explicitly authorizes this skill / names the CLI.
- Before running anything, confirm the matching binary exists; if not, stop and
  give install/auth guidance.

### S2.4 Drop host-only yaml

Remove `agents/openai.yaml` from `codex` and `grok-build` packages so the
preinstalled bundle only carries MiMoCode-facing skill content.

### S2.5 Docs

`mimocode-docs` no longer claims these skills appear only when the CLI is
installed. README lists `MIMOCODE_ENABLE_AGENT_CLI_SKILLS` as default-off.

## [S3] Out of Scope

- External brand roots (`.claude` / `.codex` / `.opencode` / `.agents`) and
  their `MIMOCODE_ENABLE_*_SKILLS` / `MIMOCODE_DISABLE_AGENTS_SKILLS` switches.
- Reworking extract/marker layout or moving `OFFICIAL_SKILL_NAMES` filtering to
  scan-only.
- `permission.skill`, `disable-model-invocation`, `MIMOCODE_DISABLE_SLASH_SKILLS`.

## Tasks

- [x] T1: Add `MIMOCODE_ENABLE_AGENT_CLI_SKILLS` (default false) and
      `AGENT_CLI_SKILL_NAMES`; delete `REQUIRED_COMMANDS` /
      `isBuiltinSkillInstalled` — acceptance: extract omits the three skills
      unless the flag is set; unrelated builtins are unchanged; no `which`
      dependency remains in extract (covers: S2.1, S2.2)
- [x] T2: Unify the three SKILL.md descriptions and drop `agents/openai.yaml`
      — acceptance: all three mention explicit user authorization and binary
      availability; no `agents/openai.yaml` remains under those three packages
      (covers: S2.3, S2.4)
- [x] T3: Update tests and docs — acceptance: `bun test test/skill` covers flag
      on/off and the unified contract; README and `mimocode-docs` no longer
      mention binary-gated discovery (covers: S2.5)

## Journey log
