---
feature: skill-external-root-defaults
status: designed
updated: 2026-09-20
branch: feat/skill-external-root-defaults
commits: c17d021c..c17d021c # filled at delivery
---

# Skill External Root Defaults

## Report

## [S1] Problem

External skill discovery treats every `SKILL.md` under a brand root as a user
skill. Codex Desktop/CLI installs **SYSTEM** skills into
`$CODEX_HOME/skills/.system/` (marker: `.codex-system-skills.marker`). Those
bodies are Codex-private (imagegen CLI, OpenAI docs self-knowledge, Codex
plugin/skill installers). MiMoCode scans `~/.codex` with
`skills/**/SKILL.md` and `dot: true`, so `.system/*/SKILL.md` enters the
catalog whenever Codex compatibility is on.

Harm: polluted `available_skills`, name collisions with bundled skills
(`imagegen`, `skill-creator`), and instructions that point at Codex-only tools.

Two structural defects behind that:

1. **`dot: true` on external scans** — any dotted segment under `skills/`
   (`.system`, `.trash`, `.hidden`) is treated as a skill container.
2. **All brand roots default-on** — `.claude` / `.codex` / `.opencode` are
   scanned unless an env kill-switch is set. OpenCode's fork-era
   `*_DISABLE_CLAUDE_CODE*` / `MIMOCODE_MIMO_ONLY` gates are a blunt Claude
   inheritance switch, not a skill-root policy. Desktop already defaults to
   open-standard `agents` only via `skillPathCompat`, but the engine default
   does not match, and enabling a brand root still pulls that brand's private
   namespaces.

Claude Code has the same class of reserved locations under `.claude/skills/`
(`synced/`, `.trash/`). Out of scope here except that `dot: false` also stops
`.trash` from being loaded.

## [S2] Design

### S2.1 External scan never matches dotted path segments

Keep `EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"` (nested skills stay
discoverable). Drop `dot: true` from the two external `scan` call sites in
`packages/opencode/src/skill/index.ts` (global home roots and project `up()`
roots). Native patterns (`MIMOCODE_SKILL_PATTERN`, `SKILL_PATTERN`,
`BUILTIN_SKILL_PATTERN`) already omit `dot` and stay unchanged.

Effect: `~/.codex/skills/.system/**` and `~/.claude/skills/.trash/**` never
match. Claude's reserved name `synced` is **not** special-cased (accepted
leak; non-dotted).

### S2.2 Default root set = mimocode + agents; brand roots are opt-in

| Root | Default | Control |
| --- | --- | --- |
| `.mimocode/skill(s)`, config `skills.paths` / `skills.urls`, builtin & compose bundles | on | existing dedicated flags only |
| `.agents/skills` (home + project up) | **on** | `MIMOCODE_DISABLE_AGENTS_SKILLS` |
| `.claude/skills` | **off** | `MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS` |
| `.codex/skills` | **off** | `MIMOCODE_ENABLE_CODEX_SKILLS` |
| `.opencode/skills` | **off** | `MIMOCODE_ENABLE_OPENCODE_SKILLS` |

Enabling Codex compatibility loads user skills under `~/.codex/skills/<name>/`
only; `.system` remains invisible because of S2.1.

### S2.3 Env contract (Active vs Deprecated)

**Active** — the only user-facing external-root controls:

| Env | Default | Meaning |
| --- | --- | --- |
| `MIMOCODE_DISABLE_AGENTS_SKILLS` | unset = agents on | Turn off the open-standard `.agents` root |
| `MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS` | unset = off | Opt in `.claude/skills` |
| `MIMOCODE_ENABLE_CODEX_SKILLS` | unset = off | Opt in `.codex/skills` |
| `MIMOCODE_ENABLE_OPENCODE_SKILLS` | unset = off | Opt in `.opencode/skills` |

**Deprecated** — ignored for skill-root selection (may `log.warn` once):

| Env | Former meaning | Replacement |
| --- | --- | --- |
| `MIMOCODE_DISABLE_EXTERNAL_SKILLS` | master gate on all external roots | none (no master gate); use `MIMOCODE_DISABLE_AGENTS_SKILLS` to drop the only default-on external root |
| `MIMOCODE_DISABLE_CLAUDE_CODE_SKILLS` | force-off `.claude` | leave `MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS` unset |
| `MIMOCODE_DISABLE_CODEX_SKILLS` | force-off `.codex` | leave `MIMOCODE_ENABLE_CODEX_SKILLS` unset |
| `MIMOCODE_DISABLE_OPENCODE_SKILLS` | force-off `.opencode` | leave `MIMOCODE_ENABLE_OPENCODE_SKILLS` unset |

**Not skill-root controls** (fork-era OpenCode Claude-compat / MiMo-only shell;
skill selection must not read them):

- `MIMOCODE_DISABLE_CLAUDE_CODE` / `MIMOCODE_MIMO_ONLY`
- `MIMOCODE_DISABLE_CLAUDE_CODE_PROMPT` / `_MCP` / `_COMMANDS`
- `MIMOCODE_DISABLE_PROVIDER_ENV` (still coupled to `MIMO_ONLY` outside this feature)

Predicate (sole source of truth for `EXTERNAL_DIRS` filtering):

```text
scan .agents    ⇔  ¬ DISABLE_AGENTS_SKILLS
scan .claude    ⇔  ENABLE_CLAUDE_CODE_SKILLS
scan .codex     ⇔  ENABLE_CODEX_SKILLS
scan .opencode  ⇔  ENABLE_OPENCODE_SKILLS
```

Implementation note: `Flag` may expose derived booleans for
`skill/index.ts` call sites; those derived keys are **not** documented envs.
Remove the outer `if (!Flag.MIMOCODE_DISABLE_EXTERNAL_SKILLS)` guard around
external discovery.

### S2.4 Desktop alignment (`mimo-desktop`)

`SkillPathCompat` default is already
`{ agents: true, claude: false, codex: false, opencode: false }` — identical
to the new engine default. `engineSkillScanEnvFromCompat` injects only deltas
from that default and stops emitting deprecated keys:

```ts
const env: Record<string, string> = {}
if (!compat.agents) env.MIMOCODE_DISABLE_AGENTS_SKILLS = "true"
if (compat.claude) env.MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS = "true"
if (compat.codex) env.MIMOCODE_ENABLE_CODEX_SKILLS = "true"
if (compat.opencode) env.MIMOCODE_ENABLE_OPENCODE_SKILLS = "true"
return env
```

| Desktop prefs | Injected env | Engine scan set |
| --- | --- | --- |
| default | `{}` | mimocode + agents |
| all off | `{ MIMOCODE_DISABLE_AGENTS_SKILLS: "true" }` | mimocode/config/bundle only |
| agents + codex | `{ MIMOCODE_ENABLE_CODEX_SKILLS: "true" }` | + `.codex` user skills (no `.system`) |

Desktop enumeration / import / same-name checks keep reading the same
`skillPathCompat` prefs. Any Desktop-side filesystem scan of brand roots must
also use non-dot matching so lists and engine agree.

Write authority stays the mimocode skills root; brand roots remain read-only
compatibility (existing skill-path-compat contract).

### S2.5 Docs

- `README*.md` env tables: Active table only; Deprecated table listed as
  ignored.
- `mimocode-docs` `reference/config.md`: same split; state that `.mimocode`
  and `agents` are the default load surface and brand roots are opt-in.
- Note migration for TUI/CLI users who relied on unset-env scanning of
  `~/.claude` or `~/.codex`.

## [S3] Out of Scope

- Claude reserved name `synced` (any capitalization).
- Codex `.codex-system-skills.marker` special-case (covered by `dot: false`).
- Deleting `MIMOCODE_MIMO_ONLY` / `MIMOCODE_DISABLE_CLAUDE_CODE*` from
  prompt / MCP / commands / provider-env surfaces (separate feature if wanted).
- `.skillignore` / config exclusion lists.
- Changing `skills/**` to single-level `skills/*`.
- Writing into or relocating Codex's `.system` cache.
- OpenCode upstream changes.

## Tasks

- [ ] T1: External skill scans use non-dot glob matching — acceptance: with a
  fixture `~/.codex/skills/.system/x/SKILL.md` and
  `~/.codex/skills/user-skill/SKILL.md` plus
  `MIMOCODE_ENABLE_CODEX_SKILLS=true`, discovery lists only `user-skill`;
  `~/.claude/skills/.trash/y/SKILL.md` is likewise invisible when claude is
  enabled. (covers: S2.1)
- [ ] T2: Flip engine external-root defaults and replace env gates —
  acceptance: default discovery includes `.agents` and excludes
  `.claude`/`.codex`/`.opencode`; each `MIMOCODE_ENABLE_*_SKILLS` opts in only
  its root; `MIMOCODE_DISABLE_AGENTS_SKILLS` drops agents; setting
  `MIMOCODE_DISABLE_EXTERNAL_SKILLS` or brand `MIMOCODE_DISABLE_*_SKILLS`
  does not change the predicate; `MIMOCODE_MIMO_ONLY` /
  `MIMOCODE_DISABLE_CLAUDE_CODE` do not affect skill roots. (covers: S2.2;
  S2.3; depends: T1)
- [ ] T3: Update engine skill tests and env hygiene — acceptance:
  `test/skill` covers default surface, each opt-in, agents disable, dotted-dir
  negative, deprecated-env no-op, and existing brand-discovery cases pass with
  `ENABLE_*` set where they expect brand roots. (covers: S2.1; S2.2; S2.3;
  depends: T2)
- [ ] T4: Align Desktop `engineSkillScanEnvFromCompat` and related unit tests —
  acceptance: default prefs inject `{}`; open brand injects only its
  `MIMOCODE_ENABLE_*_SKILLS`; all-off injects only
  `MIMOCODE_DISABLE_AGENTS_SKILLS`; no injected env is a Deprecated key; unit
  matrix matches S2.4. (covers: S2.4; depends: T2)
- [ ] T5: Document Active/Deprecated env split and migration — acceptance:
  README and mimocode-docs list only the four Active keys as controls, mark
  the Deprecated set ignored, and state default load surface = mimocode +
  agents with brand roots opt-in. (covers: S2.5; depends: T2)
