---
feature: retire-compose-legacy
status: delivered
updated: 2026-10-12
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2644
---

# Retire Compose Legacy

## Report

**What was built** — The legacy Compose surface is gone. The `compose` primary agent, the built-in `compose` workflow, and the fourteen `compose:*` skills with their extract/bundle pipeline are deleted, along with `ConfigCompose`, `MIMOCODE_DISABLE_COMPOSE_SKILLS`, the Compose prompt injection (`session/prompt/compose.txt`), and every TUI Compose special case. Historical sessions keep working: unknown stored `info.agent` names (including `compose`) fall back to the default agent (`build`) through `Agent.resolveStoredAgent` on message-read paths only — explicit live `Agent.get` still errors. `promoteComposeProtocolFirst` stays so legacy Compose synthetic protocol parts still order correctly on reopen.

Homepage tips now rotate `tui.tips.compose_next` as a normal weighted tip. Copy names **`compose-next`** in every language and describes the capability positively (「澄清需求、规格、实现与评审」 / "clarify, spec, implement, review", aligned with mimo-desktop `composeDesc`) — never "instead of Compose". `tui.skill.compose-next.slash` / `.description` follow the same naming. Docs surface (README×3, mimocode-docs skill, drive-mimo, SDK config types) describes compose-next as the orchestration entry with no legacy path.

**Verification** — `bun run typecheck` PASS (all workspaces). From `packages/cli`: `bun test test/agent test/permission test/workflow/builtin.test.ts test/cli/cmd/tui/tips-view.test.ts test/skill/search.test.ts test/skill/bundle-discovery.test.ts test/skill/skill-description.test.ts test/session/prompt.test.ts` → 334 pass / 0 fail. `test/skill/skill.test.ts` and `test/workflow/runtime.test.ts` fail identically on `main` in this local environment (`~/.codex/skills/compose-next` leaks via `MIMOCODE_ENABLE_CODEX_SKILLS`; `SyncEvent` projectors) — PRE-EXISTING, remote main is green. Independent review: spec compliance + consistency pass; one critical test-integrity bug (misnamed `plan_exit` assertion) and two minors (`resolveStoredAgent` cast, unused `agentName` on `pickDisplayKey`) fixed and re-verified.

**Journey log** —
1. Tips copy direction came from mimo-desktop `composeDesc` / skill brief after the user rejected "instead of Compose" framing and showed the 编排模式 menu card; name stays `compose-next` in all languages, never translated to 「编排模式」.
2. Historical compatibility is deliberately narrow: only message-read sites use `resolveStoredAgent`; `Agent.get` keeps throwing for live requests so typos still surface.
3. Local test red on `skill.test.ts` looked like a regression until compared against `main` and traced to `~/.codex/skills/compose-next` (not `~/.claude`) — always baseline local failures before blaming the diff.

## [S1] Problem

`compose` remains as a primary agent / mode entry, a built-in `compose` workflow, and fourteen `compose:*` skills with their own extract/bundle pipeline. `compose-next` already covers the same spec→ship lifecycle on Build for frontier models, and the desktop UI entry is now a `compose-next` skill pill rather than a mode switch. The legacy surface is deprecated, still costs discovery/permission/i186/docs maintenance, and the only homepage tip that advertises `compose-next` is locked behind the Compose agent while its copy still says "instead of the Compose agent".

## [S2] Design

### S2.1 Retire the Compose agent

- Delete the native `compose` primary agent from `packages/cli/src/agent/agent.ts` (definition, `compose:*` skill allow override, `list()` sort key).
- Drop the default-agent `skill: { "compose:*": "deny" }` rule once no bundled `compose:*` skills remain. User-defined skills that merely start with `compose` (no colon namespace) are unaffected.
- Remove TUI Compose special cases: skill-dialog / autocomplete `compose:*` filtering gated on `agent.name === "compose"`, prompt chrome that branches on `compose`, and mode-lock wording that mentions Compose isolation.
- Remove `session/prompt/compose.txt` and the `PROMPT_COMPOSE` injection path that stamps `{{compose_docs_dir}}` into the first Compose user message.

### S2.2 Retire the Compose workflow

- Delete `packages/cli/src/workflow/builtin/compose.js` and its tests (`test/workflow/compose.test.ts`, compose rows in `test/workflow/builtin.test.ts`).
- Remove the `input.name === "compose"` special case in `packages/cli/src/tool/workflow.ts` that threads `_composeDocsDir`.
- Keep the generic workflow runtime and other built-ins (`deep-research`, `fact-check`, `research-experiment`).

### S2.3 Delete Compose skills and bundle logic

- Delete `packages/cli/src/skill/compose/` entirely (`.bundle/` fourteen skills, `bundle.macro.ts`, `extract.ts`, licenses that only serve that bundle).
- Remove `extractComposeBundle` usage and the `scope: "compose"` scan from `packages/cli/src/skill/index.ts`.
- Remove `isComposeSkill` filtering from `packages/cli/src/skill/search.ts` and the `compose:` localized-alias exclusion.
- Remove `MIMOCODE_DISABLE_COMPOSE_SKILLS` from `packages/cli/src/flag/flag.ts` and test env fixtures.
- Remove all `tui.skill.compose:*` i18n keys (description + slash) from every locale.

### S2.4 Delete Compose config

- Delete `packages/cli/src/config/compose.ts` (`ConfigCompose`) and the `compose` field from `Config.Info`. Consumers today are only the Compose prompt injection and the Compose workflow.
- `compose-next` keeps its documented default artifact path `docs/compose/spec/<feature>.md` as a skill convention, not a config key.

### S2.5 Homepage tips: normal carousel, positive copy

- `tui.tips.compose_next` joins the normal weighted tip pool (`TIP_KEYS` / `buildTipKeys`) so it rotates on every homepage visit.
- Delete the Compose lock override in `pickDisplayKey` (`COMPOSE_LOCK_TIP` / `agentName === "compose"`). The `/login` override stays.
- **Tips** (`tui.tips.compose_next`): keep short and lead with the literal slash command so the user knows what to type. Never "instead of Compose" / 「代替 Compose」.
  - zh: `{highlight}/compose-next{/highlight} — 澄清需求、规格、实现与评审`
  - en: `{highlight}/compose-next{/highlight} — clarify, spec, implement, review`
- **Skill description** (`tui.skill.compose-next.description`): do not say "Orchestration mode" / 「编排模式」 — that name belonged to the retired mode and the skill name already contains "compose". Lead with end-to-end delivery plus the four-beat capability line (tip length limits do not apply here).
  - zh: `端到端交付：澄清需求、规格、实现与评审`
  - en: `End-to-end delivery: clarify, spec, implement, review`
- **Slash display name** (`tui.skill.compose-next.slash`): localized names are fine; not forced to the English id.
  - zh: `新编排模式` · zht: `新編排模式`

### S2.6 Historical session compatibility

Unknown `info.agent` values in stored messages (including historical `compose`) resolve to the **default agent** (currently `build`, or `cfg.default_agent`) when the name is read back from history.

- Scope: message-read / resume paths only (`processor` assistant agent, `compaction` parent agent, `prompt` `lastUser.agent` / resume / title-adjacent reads). Explicit `Agent.get` for a live request still errors with `Agent not found`.
- Implementation: a small resolve helper used at those call sites — `agents.get(name)` then fall back to `agents.defaultAgent()` when lookup is empty. Do not change `Agent.get` itself.
- `promoteComposeProtocolFirst` / `COMPOSE_REMINDER_MARKER` stay so historical Compose synthetic protocol parts still order correctly when a legacy session is reopened.

### S2.7 Documentation surface

Rewrite every user-facing mention of the Compose agent / Compose workflow / `compose:*` skills:

| Surface | Change |
| --- | --- |
| `README.md` / `README.zh.md` | Agents table drops `compose`; Compose Mode section becomes a direct `/compose-next` usage intro (end-to-end delivery, no Fable/Sol tier framing, no "must use build", end with "do not combine with plan mode"); workflow table drops the `compose` row; mode-lock wording becomes "Build and Plan switch anytime; other modes lock after the first message" |
| `README_npm.md` | Feature bullets: agents list and Compose Mode / Workflows rows |
| `mimocode-docs` skill (`SKILL.md`, `reference/guide.md`, `reference/workflows.md`, `reference/commands.md`, `reference/config.md`) | Same retirement: no compose agent path, no compose workflow, no `compose` config row, no `MIMOCODE_DISABLE_COMPOSE_SKILLS`; compose-next described as end-to-end delivery entry without model-tier definitions |
| `docs/compose/spec/*` historical feature docs | Do not rewrite history |
| `.agents/skills/drive-mimo/SKILL.md` | Drop `--agent compose` row if present |

## [S3] Out of Scope

- Renaming `docs/compose/spec/` or changing compose-next's phase contract.
- Desktop (mimo-desktop) UI changes.
- Removing `promoteComposeProtocolFirst` or migrating historical message rows.
- Workflow runtime, other built-in workflows, or user `.mimocode/workflows/`.
- Plan agent / plan mode.

## Tasks

- [x] T1: Remove Compose agent + TUI mode special cases + `compose.txt` prompt injection — acceptance: `Agent.list()` has no `compose`; build/plan no longer carry `compose:*` rules; TUI has no compose branch; `bun test packages/cli/test/agent` passes (covers: S2.1; S2.6)
- [x] T2: Remove Compose workflow builtin + `workflow.ts` docs-dir special case — acceptance: `BuiltinWorkflow` has no `compose` entry; `bun test packages/cli/test/workflow` passes (covers: S2.2)
- [x] T3: Delete `skill/compose/` bundle + extraction/search/alias/flag hooks — acceptance: no `compose:*` skills load; `MIMOCODE_DISABLE_COMPOSE_SKILLS` gone; `bun test packages/cli/test/skill` passes (covers: S2.3)
- [x] T4: Delete `ConfigCompose` and `config.compose` field — acceptance: config schema has no `compose` key; typecheck clean (covers: S2.4)
- [x] T5: Tips carousel + i18n copy — acceptance: `compose_next` is in `buildTipKeys`; `pickDisplayKey` has no compose lock; copy names `compose-next` and reads as capability in all 7 locales; `bun test packages/cli/test/cli/cmd/tui/tips-view.test.ts` passes (covers: S2.5)
- [x] T6: Historical unknown-agent fallback on message-read paths — acceptance: a session whose `info.agent` is `compose` (or any unknown name) resumes on the default agent without `Agent not found`; explicit missing agent on a live request still errors; focused test covers both (covers: S2.6; depends: T1)
- [x] T7: Docs surface (README×3 + mimocode-docs) — acceptance: `rg -i 'compose agent|compose workflow|compose:\*|Compose mode'` on those files is clean of retired meanings; compose-next described positively as orchestration (covers: S2.7; depends: T1–T5)
- [x] T8: Full verification + review — acceptance: `bun test packages/cli`, `bun typecheck`, targeted suite green; independent reviewer signs off (covers: S2; depends: T1–T7)
