---
feature: compose-next
status: delivered
updated: 2026-07-22
branch: compose-next
commits: 8e2817cfddb35ba19fcea221b6567966890dfc87..42613223d00eec340651b632aacfcac01677f795
predecessor: compose-slim (draft PR #1850)
---

# Compose Next

## Report

**What was built** - One self-contained builtin skill `compose-next` (grill → spec → workspace → implement → verify → review → finalize → finish), invoked from Build as `/compose-next`. Hidden from model auto-discovery via an exact `"compose-next": "deny"` default-agent skill permission plus `skill_search` sourcing from `Skill.available(agent)`; still present in `Skill.all()` so slash autocomplete works. Legacy Compose is untouched functionally and marked deprecated through three additive touchpoints: agent description line, `Compose (legacy)` input-bar label, and a compose-only home-tip display override. Side fix: tips now render for first-time users (first-session gate removed).

**Verification** - From `packages/opencode`: `bun test test/skill test/permission test/tool/skill-search.test.ts` — 230 pass / 0 fail / 555 assertions. `bun typecheck` — PASS. `git diff --check` — PASS. CI (lint, typecheck, unit shards 1-4) — all green on PR #1861.

**Journey log**

1. CI shard 4 failed from cross-file env pollution: `skill.test.ts` sets `MIMOCODE_DISABLE_BUILTIN_SKILLS` at module top-level and never restores; the Flag getter reads env lazily. Fixed with the save/clear/restore pattern from #1850's `available-permission.test.ts`. Lesson: any test needing builtin-bundle extraction must defensively clear that flag.
2. The skill originally referenced `<compose_docs_dir>` — a prompt block only injected for the Compose agent and `compose.js`, never in Build sessions. Dead reference removed; path hardcoded to `docs/compose/spec/`. Lesson: a skill assembled from another agent's bundle inherits that agent's prompt-injection assumptions; audit them.
3. Workspace was dropped from the pipeline declaration during the three-skill hand-merge, letting the mechanical-change branch land on `main` by omission. Merge artifacts hide in transition sentences, not section bodies.
4. Review-loop needed a stop gate but a hardcoded round count was rejected in favor of judgment-based non-convergence signals (repeated findings on the same area; fixes introducing new criticals).
5. The finalize commit necessarily sits outside the recorded reviewed range; without saying so, a literal reader loops finalize → re-review → finalize. The skill now states CI re-running on it is expected.

## [S1] Problem

Legacy Compose bundles three concerns into one agent mode: permission policy (what tools may be used), workflow curriculum (fourteen internal skills orchestrating brainstorm, plan, tdd, review, merge, ...), and UI state (Tab-cycle entry, status bar, dialog filtering). The curriculum was necessary for weaker models; stronger Fable/Sol-class models internalize most of it and benefit more from one compact executable contract than from fourteen orchestrated skills.

Draft PR #1850 (`compose-slim`) validated this experimentally by consolidating fourteen skills into three (`compose-grill`, `compose-spec`, `compose-dev`), reducing `compose.txt`, and introducing a structured `scope` field with `Permission.evaluateSkill`. The experiment worked, but it replaces too much of Legacy Compose at once and cannot ship as-is: existing users depend on the current Compose agent, and rewriting the workflow while migrating discovery mechanism in the same PR is an unnecessarily large blast radius.

Compose Next is the compatibility-first successor. It carries only the additive product surface (one new user-selectable skill) and the minimum discovery adjustment required to make it user-visible while keeping it out of routine model auto-discovery. Everything else — including the eventual removal of `compose:*` name-prefix filtering — is deferred to the Legacy-Compose-removal PR.

## [S2] Design

### One self-contained builtin skill

Add one skill file:

```text
packages/opencode/src/skill/builtin/.bundle/compose-next/SKILL.md
```

Canonical name: `compose-next`. Bundle root: builtin. Not prefixed with `compose:`; not scoped to the Compose agent. It is a normal builtin capability whose consumer is any primary agent (in practice, Build) that explicitly loads it.

The skill body is a single executable contract, in this order:

1. **Grill** - resolve genuine user decisions (question tool with concrete options); apply Never-Ask to a single decision only; do not batch later decisions under one grant.
2. **Spec** - create or amend a feature document at `docs/compose/spec/<feature>.md` when the work warrants one; keep design, tasks, and delivery report in that one document. The path is fixed in the skill text; no `<compose_docs_dir>` prompt injection is involved (that block only exists for the Compose agent and `compose.js`, neither of which is in the `/compose-next` path).
3. **Workspace** - own a worktree before implementation on every path (linked worktree under `.worktrees/` by default); never start on `main`/`master` without explicit consent.
4. **Implement** - proceed in dependency order; use test-first where applicable; do not spawn parallel edits into the same worktree.
5. **Verify** - run verification and produce a compact PASS/FAIL/PRE-EXISTING summary; verification must complete before review is dispatched.
6. **Review** - dispatch one fresh reviewer with spec path, worktree path, base/head SHAs, diff coordinates, and the compact verification summary; the reviewer reuses that summary rather than duplicating heavy E2E commands without cause.
7. **Finalize** - update the feature document (report, journey log, verification evidence) before branch completion.
8. **Finish** - explicit merge / PR / keep-branch / discard, with worktree ownership stated; destructive actions never auto-approve.

The three slim experimental skills are source material for this document; they are not carried into the production bundle.

### User-visible, model-undiscovered

Discovery uses the existing `Skill.all()` versus `Skill.available(agent)` split; no new mechanism is added.

- `Skill.all()` includes `compose-next`. Command registration and the app skills endpoint already resolve from `all()`, so `/compose-next` slash autocomplete and explicit invocation work in Build without further wiring.
- Default agent skill permission adds an exact `compose-next: deny` rule at `packages/opencode/src/agent/agent.ts` alongside the existing `"compose:*": "deny"`. `Skill.available(agent)` therefore omits `compose-next` from `available_skills` and from the skill tool description surface.
- `packages/opencode/src/tool/skill-search.ts` currently reads `Skill.all()`; it must switch to `Skill.available(agent)` so `compose-next` (and any future permission-hidden skill) is not returned by BM25 search or auto-load. This is a general correctness fix that PR #1850 already documented as independent of the scope refactor.
- `SkillTool.execute()` (via `Skill.get()`) stays permissive. If a model guesses the exact name `compose-next` it may invoke it; this is behavior guidance, not a security boundary. Do not add activation state, invoke-time refusal, model allowlists, or new visibility schema.

Because the new skill is not named `compose:*` and lives in the builtin bundle, none of the six existing `startsWith("compose:")` sites accidentally hide it:

- `skill/search.ts:65` (name-prefix filter) — no match; unaffected.
- `skill/localized-alias.ts:8` (alias suppression) — no match; `compose-next` produces localized aliases like any other builtin.
- `cli/.../dialog-skill.tsx:29` (skill dialog filter) — no match; appears in the dialog.
- `cli/.../autocomplete.tsx:388` (slash autocomplete filter outside Compose) — no match; `/compose-next` shows in Build autocomplete.
- `agent/agent.ts:110` default agent `"compose:*": "deny"` — no match; a separate exact `compose-next: deny` rule handles model discovery.
- `agent/agent.ts:219` compose agent `"compose:*": "allow"` — no match; Compose agent does not auto-allow `compose-next`, which is intended (Compose Next is not a Compose-mode internal).

### Legacy Compose deprecation surface

Compose agent stays enabled, keeps its private skills, its prompt injection, and `compose.js`. It is not removed from the Tab-cycle in this PR; the dual-path release window requires it to remain reachable exactly the way users know it today.

Three additive deprecation touchpoints:

1. **Agent description only** — single deprecation line appended to the `agent.ts` compose block `description`. The Compose system prompt (`packages/opencode/src/session/prompt/compose.txt`) is deliberately **not** touched: any byte change to a model-facing system prompt invalidates prefix cache for every existing Compose session. The description gives the TUI its deprecation copy; the input-bar `Compose (legacy)` label gives users a direct visual cue. That is enough.

2. **Home tips — compose-only display override** — one new tip `tui.tips.compose_next` recommending Build + `/compose-next` is added to the i18n dictionaries but **not** to `TIP_KEYS` / `PRIORITY_WEIGHTS` (`packages/opencode/src/cli/cmd/tui/feature-plugins/home/tips-view.tsx`). The rotation runs exactly as on `main` and cycles the normal weighted pool; a `displayKey` memo overrides the rendered key to `tui.tips.compose_next` while `local.agent.current()?.name === "compose"`. Entering Compose visibly swaps to the deprecation tip; leaving Compose reveals whatever key the rotation currently holds — no artificial mid-cycle swap, and no impact on switches that do not involve the Compose agent. The Tips component only renders on home, so session-view Tab switching does not affect this.

3. **Agent label suffix "(legacy)"** — the input-bar agent label at `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` (currently renders `Locale.titlecase(agent.name)`) shows `Compose (legacy)` when the current agent is `compose`. This is a pure display concern; agent identity and routing remain `compose`. The suffix is intentionally not localized — "legacy" reads the same across the locales this project supports, and adding an i18n key just for a single-word technical suffix costs more than it earns.

This is guidance text, not runtime model detection. No hard model-ID list. Users choose either path.

### i18n coverage

All user-facing strings introduced by this PR ship translations for every locale under `packages/opencode/src/cli/cmd/tui/i18n/` (`en`, `es`, `fr`, `ja`, `ru`, `zh`, `zht`). Missing a locale is a review-blocking gap.

Keys added:

- `tui.tips.compose_next` — home tip body recommending Build + `/compose-next`.
- `tui.skill.compose-next.description` — description shown in skill dialog / autocomplete / command palette. Naming follows the existing `tui.skill.<name>.description` convention.

The Compose agent description line appended in `agent.ts` is inline English today and stays inline English in this PR — the localized surface for users is the tip and the skill description, both keyed above.

### Why no scope mechanism in this PR

On `main` today, `compose:` is not a runtime namespace — it is literally the leading segment of each Legacy Compose skill's frontmatter `name` (`compose:brainstorm`, `compose:tdd`, ...). The six `startsWith("compose:")` sites are therefore self-consistent with the legacy bundle content, and they will disappear in one PR when the bundle is deleted.

Adding `Skill.Info.scope` + `evaluateSkill` + `ScanMeta` now would introduce a general mechanism whose only consumer is a subsystem scheduled for removal. It also enlarges this PR's blast radius (schema, scanner, permission evaluator, six migration sites, tests) without user-visible benefit. Compose Next needs exactly one thing beyond `main`: a way to keep the new skill out of default-agent discovery. Exact-name permission handles that in one line.

If a future skill genuinely needs namespace-level gating, the scope refactor can be revisited then, informed by an actual second use case.

## [S3] Implementation

### Files

Add:

- `packages/opencode/src/skill/builtin/.bundle/compose-next/SKILL.md`
- `packages/opencode/test/permission/compose-next-discovery.test.ts`

Modify:

- `packages/opencode/src/agent/agent.ts` — add exact `"compose-next": "deny"` to the default agent's `skill` permission ruleset (adjacent to the existing `"compose:*": "deny"`). Append the deprecation line to the Compose agent block's `description`. Do not add any skill rule to the Compose agent.
- `packages/opencode/src/tool/skill-search.ts` — resolve current agent from context and source the searchable list from `Skill.available(agent)` instead of `Skill.all()`. Update the tool description string accordingly if needed.
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` — the input-bar agent label render (currently `Locale.titlecase(agent().name)`) shows `Compose (legacy)` when `agent.name === "compose"`. Pure display change; identity, routing, tab-cycle and everything else remain the same.
- `packages/opencode/src/cli/cmd/tui/feature-plugins/home/tips-view.tsx` — leave the rotation exactly as on `main` (do NOT add `tui.tips.compose_next` to `TIP_KEYS`/`PRIORITY_WEIGHTS`). Add a `displayKey` memo that overrides the rendered key to `tui.tips.compose_next` while the current agent is `compose`, otherwise returns the rotation's current key. Non-compose agent switches must not trigger any rotation change.
- `packages/opencode/src/cli/cmd/tui/feature-plugins/home/tips.tsx` — remove the `first = session.count() === 0` gate so tips render on a fresh project too. Original behavior hid tips from first-time users, which is the population that most needs the guidance.
- `packages/opencode/test/skill/search.test.ts` — extend with two assertions: `compose-next` is NOT excluded by the `startsWith("compose:")` filter (name has a dash, not a colon), and callers that pass a list not containing `compose-next` see no `compose-next` in results (mirrors production `available(defaultAgent)`).
- All seven i18n locale files under `packages/opencode/src/cli/cmd/tui/i18n/` (`en.ts`, `es.ts`, `fr.ts`, `ja.ts`, `ru.ts`, `zh.ts`, `zht.ts`) — add two keys each: `tui.tips.compose_next`, `tui.skill.compose-next.description`.

Do not touch:

- `packages/opencode/src/session/prompt/compose.txt` — model-facing system prompt; any byte change invalidates every existing Compose session's prefix cache.
- `packages/opencode/src/skill/index.ts` scanner or `Info` schema.
- `packages/opencode/src/skill/search.ts` `startsWith("compose:")` filter.
- `packages/opencode/src/permission/evaluate.ts` (no `evaluateSkill`).
- `packages/opencode/src/skill/compose/**` bundle contents.
- `packages/opencode/src/workflow/builtin/compose.js`.
- `packages/opencode/src/skill/localized-alias.ts`, `dialog-skill.tsx`, `autocomplete.tsx` legacy filters.
- Tab-cycle order in `local.agent.move` / `app.tsx` agent registration order.

### Skill content composition

Source material comes from the compact contracts on `compose-slim`:

- `compose-slim:packages/opencode/src/skill/compose/.bundle/compose-grill/SKILL.md` → sections on question-tool shapes and Never-Ask scope.
- `compose-slim:packages/opencode/src/skill/compose/.bundle/compose-spec/SKILL.md` → single-document `<feature>.md` invariant.
- `compose-slim:packages/opencode/src/skill/compose/.bundle/compose-dev/SKILL.md` → worktree, verification-before-review, review coordinate, finish rules.

These are copied via `git checkout origin/compose-slim -- <path>` into a scratch location, then hand-merged into one SKILL.md preserving executable contract text (tool shapes, ordering constraints, review coordinates) and dropping cross-skill coordination language ("this skill hands off to the next"). Rationale prose that does not carry executable content is dropped.

### Tests

- Discovery: `Permission.evaluate("skill", "compose-next", defaultAgentRules)` returns `deny`; the compose agent inherits the same deny (Compose Next is not a Compose-mode internal); ordinary skills return `allow`; `compose:*` legacy pattern still denied on default and allowed on compose.
- Search input filter: `compose-next` is NOT dropped by the `startsWith("compose:")` filter in `skill/search.ts` (its name has a dash, not a colon); callers that pass a list not containing `compose-next` (mirroring `Skill.available(defaultAgent)`) get no `compose-next` in results.
- Legacy invariants preserved: existing `compose:*` filter tests remain green unchanged.
- i18n: the existing `skill-description.test.ts` completeness check exercises the two new `tui.skill.compose-next.*` keys; the `tui.tips.compose_next` key is loaded by `Tips()` when the compose agent is active.
- Tip override: on the home view with `agent.name === "compose"`, the rendered tip is `tui.tips.compose_next`; leaving Compose reveals the rotation's current key with no forced swap; switches between non-compose agents do not affect the tip.
- Agent label suffix: the input-bar label reads `Compose (legacy)` when the current agent is `compose`, and `Build` / `Plan` unchanged for those agents.

### Verification

From `packages/opencode`:

- `bun test test/permission/compose-next-discovery.test.ts test/skill/search.test.ts test/tool/skill-search.test.ts` (new/extended).
- `bun test test/agent test/skill test/permission test/tool` (regression band relevant to the touched files).
- `bun typecheck` (workspace-level from package dir).
- `git diff --check`.

Draft PR opens in Ready state (not Draft) since this is the successor implementation, not a further experiment.

## [S4] Migration and PR sequencing

1. **This PR (P1)** - Compose Next additive; Legacy Compose deprecated but functional.
2. **Draft PR #1850 closure** - After this PR opens, update PR #1850 body with this PR's URL and close #1850 as superseded by the compatibility route. The experiment graduated; it did not fail.
3. **Dual-path release window** - Observe: task completion rate, user intervention rate, skipped spec/report/review, duplicate heavy verification, context/token cost, fallback-to-Legacy rate, third-party model behavior near Fable/Sol capability.
4. **Legacy Compose removal PR (later)** - Remove `compose` agent, `compose:*` bundle, `compose.txt`, all six `startsWith("compose:")` sites, and add `/compose` as an alias of `compose-next`. Only proceed after Fable/Sol-class capability is broadly available and the dual path has been observed without material regression.
5. **Separate later work** - Plan-mode dissolution and Tab permission presets are independent roadmap items with their own specs.

## [S5] Out of scope

- Deleting or renaming any `compose:*` skill.
- Any change to `compose.js` or `compose.txt` content, or to the Compose agent's permission set. `compose.txt` in particular is a model-facing system prompt and any byte change invalidates prefix cache for every existing Compose session.
- Introducing `Skill.Info.scope`, `Permission.evaluateSkill`, or `ScanMeta` scanning.
- Hard model-ID gating for `/compose-next`.
- Treating model-undiscoverability as a security boundary.
- Removing Legacy Compose in this PR.
- Removing Legacy Compose from the Tab-cycle in this PR.
- Any deprecation toast (design chose an ambient in-place `(legacy)` label instead).
- Locking the tip anywhere except on home (session views do not render Tips).
- Persistent "user has seen this deprecation" state.
- Localizing the `(legacy)` label — it is a bare technical suffix and reads the same in every supported locale.
- i18n-keying the Compose agent description text; that path is broader than this PR.
- Migrating existing Compose feature documents.
- Plan-mode dissolution and Tab permission-preset changes.

## Tasks

- [x] T1: author `packages/opencode/src/skill/builtin/.bundle/compose-next/SKILL.md` by hand-merging compact contracts from `origin/compose-slim` three slim skills — acceptance: skill validator reports 0 errors, 0 warnings; single-file self-contained load; executable contracts for grill / spec / worktree / verify / review / finalize / finish present (covers: S2)
- [x] T2: add exact `"compose-next": "deny"` to default agent skill permission — acceptance: `Skill.available(defaultAgent)` omits `compose-next`; `Skill.all()` includes it; test asserts both (covers: S2, S3)
- [x] T3: switch `tool/skill-search.ts` to `Skill.available(agent)` — acceptance: search over a query matching `compose-next` under the default agent returns no result; existing search tests remain green (covers: S2, S3)
- [x] T4: append deprecation line to Compose agent `description` in `agent.ts` — acceptance: single-line addition; Compose agent behavior otherwise unchanged; `compose.txt` untouched (prefix-cache stability); existing Compose tests green (covers: S2)
- [x] T5: surface `tui.tips.compose_next` as a compose-only display override in `tips-view.tsx` (leave rotation identical to main; excluded from `TIP_KEYS`/`PRIORITY_WEIGHTS`; a `displayKey` memo overrides while agent is `compose`); remove the first-session gate in `tips.tsx` so tips also render on a fresh project; add key to all seven locale files — acceptance: rendered tip is compose_next iff current agent is `compose`; non-compose agent switches do not trigger tip changes; leaving compose reveals the rotation's current key; on a fresh project the tips row renders; all seven locales carry the key (covers: S2)
- [x] T6: show `Compose (legacy)` in the input-bar agent label when the current agent is `compose` — acceptance: agent identity, routing, and Tab-cycle unchanged; only the rendered label carries the suffix; label for `build`/`plan` unchanged (covers: S2)
- [x] T7: add `tui.skill.compose-next.description` to all seven locales — acceptance: skill dialog / autocomplete render the localized description (covers: S2)
- [x] T8: verification band pass — acceptance: relevant `bun test` bands and `bun typecheck` and `git diff --check` all pass from `packages/opencode` (covers: S3)
- [x] T9: open the PR (Ready, not Draft); update PR #1850 body with its URL and close #1850 as superseded — acceptance: successor URL recorded on #1850; closure message frames the experiment as graduated (covers: S4)
