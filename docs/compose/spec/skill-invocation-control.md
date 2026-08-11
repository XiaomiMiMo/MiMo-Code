---
feature: skill-invocation-control
status: delivered
updated: 2026-07-31
branch: feat/skill-invocation-control
commits: 6674db7a..6236515e
---

# Skill Invocation Control

## Report

**What was built** — Model reachability and authorization are now separate
axes. `permission.skill` means authorization only: a `deny` makes a skill
unusable by anyone, the user included. A new optional `disable-model-invocation`
boolean in SKILL.md frontmatter carries reachability: the skill is absent from
the system-prompt catalog, from the `skill` tool description, and from
`skill_search`, and the `skill` tool refuses to load it with an error that
points at the user's slash command instead of dead-ending. `/name` typed by the
user is untouched. The field name is kebab-case to match Claude Code and the
agentskills.io standard; internally it is `Info.disable_model_invocation`.

Mechanically this is one new registry accessor, `Skill.modelInvocable(agent?)`
= `available(agent)` minus the flag, feeding the three model-facing call sites,
while `available()` and `all()` stay as the user-facing sets. The dead
`Skill.Info.hidden` field, parsed but never read since PR #1725, is gone.
`compose-next` graduated onto the new field: its exact `deny` rule is deleted,
its SKILL.md sets the flag, and both its description and body now state that
the workflow starts only on explicit user invocation — belt and braces, so it
still behaves if the flag is ever removed. `skill-creator` and its frontmatter
reference document the field for skill authors; `mimocode-docs` records that
`/compose-next` is user-only, which is the channel through which a model learns
the skill exists at all.

**Verification** — all from `packages/opencode` unless noted:

- `bun typecheck` (packages/opencode) — PASS. `bun typecheck` (packages/sdk/js) — PASS.
- `bun test test/tool test/skill test/permission test/session/prompt-skill-command-multi.test.ts`
  — 1123 pass, 11 skip, 0 fail (after the review follow-ups).
- `bun test test/skill test/tool test/permission test/command` — 1123 pass, 11 skip, 0 fail.
- `bun test test/session` — 899 pass, 25 skip, 1 todo, 0 fail.
- The new test in `test/session/prompt-skill-command-multi.test.ts` was
  confirmed to FAIL on the base commit with the intended symptom: with `src/`
  stashed, the gated skill appeared in the model's catalog
  (`<name>skill-gated</name>` present in `available_skills`).
- `bun lint` (root oxlint) — 0 errors; 4043 warnings is the repo-wide baseline,
  and the seven changed source files carry 12, all pre-existing rule classes.
- `git diff --check` — clean.
- `./packages/sdk/js/script/build.ts` — FAIL, `PRE-EXISTING-SDK-CODEGEN`. See T8.
- Independent review by a fresh subagent: all eight acceptance criteria met; one
  critical finding (a stray `packages/sdk/js/openapi.json` build artifact
  committed by accident) and one correctness nit (the not-found hint duplicating
  the reachability predicate over `all()`), both fixed in `6236515e`.

**Journey log**

1. The bug was reproduced in the authoring session itself: `/compose-next`
   delivered no `<skill_content>` block and no error. `git log -L` on the
   mention scan pinned the regression to `4e2a3cb6`, which swapped `sys.all()`
   for `sys.available(runtimeAgent)` and deleted the comment recording why the
   bypass existed. A comment that explains a non-obvious choice is load-bearing;
   deleting it is how the choice gets undone.
2. The first design kept `deny` as the hiding mechanism and special-cased the
   user path. Rejected after reading Claude Code's frontmatter reference: the
   upstream standard already splits this into `disable-model-invocation` and
   `user-invocable`, which named the actual defect — one rule serving two
   questions — rather than patching its symptom.
3. `user-invocable: false` was deliberately dropped from the port. No in-repo
   skill needs a model-only skill, and shipping an unused second axis would
   reintroduce exactly the ambiguity being removed.
4. An earlier draft kept a `disable-model-invocation` skill listed in the
   catalog with an annotation, so the model could suggest `/compose-next`.
   Rejected: obra/superpowers#345 shows what an advertised-but-unloadable skill
   costs — the model retries the tool and then tells the user the skill does not
   exist. Documentation skills are the right channel for "this exists, you
   invoke it".
5. `git add -A` after a failed SDK generation committed a 16,934-line scratch
   file. `git status` before staging would have caught it; the reviewer did.
   It is now gitignored.

## [S1] Problem

A user typing `/compose-next` gets nothing. The visible text `/compose-next …`
reaches the model, no `<skill_content name="compose-next">` block is ever
injected, and no error is shown. A model calling `skill(name="compose-next")`
is hard-rejected instead of loading it.

Both symptoms come from one cause: **"hide from the model" and "forbid
invocation" are expressed by the same permission rule.** `compose-next` is
hidden from model auto-discovery by an exact `skill: { "compose-next": "deny" }`
rule on the default agent (`agent/agent.ts:111`). That rule is then consulted by
four independent surfaces:

| Surface | Code | Effect of `deny` | Intended |
| --- | --- | --- | --- |
| System-prompt catalog | `session/system.ts:181` → `Skill.available` | hidden | yes |
| `skill_search` BM25 | `tool/skill-search.ts:37` | not searchable | yes |
| `skill` tool description | `tool/registry.ts:328` `describeSkill` | hidden | yes |
| `skill` tool execution | `tool/skill.ts:42-47` `ctx.ask` | hard refusal | **no** — `compose-next.md` S2 states execution "stays permissive" |
| User slash body injection | `session/prompt.ts:864` → `Skill.available` | silent no-op | **no** — user explicitly asked for it |

The slash surface regressed at `4e2a3cb6` ("fix(session): send skill
instructions as user reminders", 2026-07-30), which changed the mention scan
from `sys.all()` to `sys.available(runtimeAgent)` and deleted the comment that
recorded why: *"Use all() to bypass per-agent permission filtering — respect the
user's explicit /mention action"* (established by PR #1716). Since
`4e2a3cb6` there has been no way to express "invisible to the model, still
usable by the user": the only mechanism that hides a skill also disables it.

The registry already carries a field for the visibility half — `Skill.Info.hidden`
(`skill/index.ts:35`, parsed at `:102`, assigned at `:129`) — but **no code reads
it**, and no bundled `SKILL.md` sets it. It has been dead since PR #1725.

Separately, `compose-next` has now been through its trial period and should
graduate: it is no longer an experiment to be kept out of the way, it is the
recommended entry point for multi-step feature work. What it still must not do
is start itself.

## [S2] Design

Split the two axes. Permission keeps exactly one meaning; a new frontmatter
field carries the other.

- **`permission.skill` = authorization.** `deny` means unusable, by anyone,
  through any surface — model *and* user. Nothing bypasses it.
- **`disable-model-invocation` = model reachability.** The model cannot see or
  invoke the skill. A user slash invocation is unaffected.

### Field

`disable-model-invocation`, boolean, optional, default `false`. Kebab-case in
YAML frontmatter, matching Claude Code and the
[agentskills.io](https://agentskills.io) open standard so a skill folder is
portable in both directions. Internally it is `Info.disable_model_invocation`
(repo snake_case convention); `add()` in `skill/index.ts` maps the kebab
frontmatter key onto it.

`Skill.Info.hidden` is removed in the same change. It is dead, unset by every
bundled skill, and keeping a second half-named visibility flag beside the new
field is the exact ambiguity this feature removes.

The counterpart field in the upstream standard, `user-invocable: false` ("only
the model may invoke"), is deliberately **not** implemented — see S3.

### Semantics

Behaviour matrix for one skill, given a default-agent `skill: "*": "allow"`:

| frontmatter | model sees it | model may invoke | user `/name` works |
| --- | --- | --- | --- |
| (default) | yes | yes | yes |
| `disable-model-invocation: true` | **no** | **no** | **yes** |
| any value + `permission.skill` `deny` | no | no | **no** |

"Model sees it" covers every list the model reads: the system-prompt catalog,
the `skill` tool description, and `skill_search` results. A
`disable-model-invocation` skill appears in none of them, so the model does not
learn the name from the harness at all — it learns that `/compose-next` exists
from documentation skills such as `mimocode-docs`, which also state that the
model must not start the workflow itself.

### Registry contract

`skill/index.ts` gains one accessor beside the existing `all` / `available`:

- `all()` — unchanged. No filtering. Feeds the command registry
  (`command/index.ts:264`), the app skills endpoint, and `/skill` autocomplete,
  so a `disable-model-invocation` skill still autocompletes and still has a
  slash command.
- `available(agent?)` — unchanged. Authorization filter only
  (`Permission.evaluate("skill", name, agent.permission) !== "deny"`). This is
  the **user** surface: the mention scan in `insertReminders` keeps using it, so
  a user slash invocation is blocked by `deny` and by nothing else.
- `modelInvocable(agent?)` — new. `available(agent)` minus
  `disable_model_invocation`. This is the **model** surface.

Three call sites move from `available` to `modelInvocable`:
`session/system.ts:181` (catalog), `tool/registry.ts:328` (`describeSkill`),
`tool/skill-search.ts:37`. `session/system.ts:206` (`SystemPrompt.available`,
consumed only by the mention scan at `prompt.ts:864`) keeps `available`.

### Skill tool

`tool/skill.ts` refuses a `disable_model_invocation` skill before `ctx.ask`,
with an error that redirects rather than dead-ends: the model is told the user
must type `/name` and that retrying the tool will not help. This mirrors Claude
Code's `cannot be used with Skill tool due to disable-model-invocation`, whose
bare form is a known dead-end (obra/superpowers#345 — the model retried and then
gave up instead of telling the user).

The not-found branch's "Available skills: …" hint (`tool/skill.ts:37-39`) is
filtered by the same predicate, so a typo near a hidden skill's name does not
leak it back to the model.

### compose-next graduation

- Delete `"compose-next": "deny"` from the default agent's `skill` ruleset
  (`agent/agent.ts:111`). Permission stops carrying visibility for it. The
  legacy `"compose:*": "deny"` rule stays exactly as is: those skills are
  denied on the default agent and allowed on the Compose agent, which is an
  agent-scoped decision that frontmatter cannot express.
- Set `disable-model-invocation: true` in
  `skill/builtin/.bundle/compose-next/SKILL.md`.
- Add the behavioural rule in two places, so it survives a future flag flip:
  in `description`, that the model must not use the skill unless the user
  invoked it or asked for it by name; in the body, that it must not enter the
  compose workflow without an explicit user request or invocation.
- Drop `compose-next` from `isComposeSkill` in `skill/search.ts:20-22`. Its
  exclusion from search is now carried by the field at the caller, and the
  helper goes back to meaning only `startsWith("compose:")`.
- `mimocode-docs` records that `/compose-next` is user-invocable only and that
  the model must not start it — this is the intended channel through which the
  model learns the skill exists.

### Accepted behaviour changes

- A `deny`'d skill can no longer be loaded by an explicit user slash
  invocation. Before `4e2a3cb6` it could (PR #1716); since `4e2a3cb6` it cannot.
  This design keeps the current behaviour and makes it the documented rule:
  `deny` means unusable. Concretely, `/compose:brainstorm` from Build stays
  inert; it works from the Compose agent, which allows `compose:*`.
- The model can no longer invoke `compose-next` by guessing its name.
  `compose-next.md` S2 previously accepted guessed invocation; this feature
  makes it a real gate, which is the whole point of the field.

## [S3] Out of Scope

- `user-invocable: false` (model-only skills, hidden from the `/` menu). No
  in-repo skill needs it, and adding an unused axis reintroduces the ambiguity
  this change removes. `Skill.all()` therefore remains the single user-facing
  set.
- Settings-level overrides equivalent to Claude Code's `skillOverrides`
  (`on` / `name-only` / `user-invocable-only` / `off`). Per-agent
  `permission.skill` remains the only config-side control.
- Migrating `compose:*` off `permission.skill`. Its deny is agent-scoped and
  disappears with legacy Compose removal.
- Other frontmatter fields from the upstream standard (`allowed-tools`,
  `context: fork`, `argument-hint`, `paths`, `model`).
- The `MAX_AUTOLOAD = 3` budget, the mention regex, and the TUI/ACP
  leading-slash routing.

### Known gaps left open (surfaced by review, deliberately not fixed here)

- `matchDocumentSkills` (`session/prompt.ts:843`, table at
  `skill/builtin/extract.ts:75`) recommends document skills to the model from a
  hardcoded list, consulting neither `available` nor `modelInvocable`. No entry
  in that table is gated today, so this is latent, not live; it becomes a real
  leak the day someone sets the flag on a document skill.
- The entire `tool.skill_search` describe block in
  `test/tool/skill-search.test.ts` is `it.live.skip`ped on `main`, so the
  compose-next invisibility assertions there — updated to the new contract in
  this change — do not run. The mechanism itself is covered by running tests
  over fixture skills; only the shipped-builtin wiring is inert. Un-skipping
  that block needs the builtin bundle extracted in the test environment, which
  is its own change.
- `./packages/sdk/js/script/build.ts` remains broken (see T8). Fixing the
  `__schema0` hoisting for `ToolStateCompleted.providerOutput` is a separate
  change; until then the generated SDK drifts from the API on every schema
  edit, and `providerOutput` itself is still missing from `types.gen.ts`.

## Tasks

- [x] T1: Replace the dead `hidden` field on `Skill.Info` with
      `disable_model_invocation`, parsed from the kebab-case
      `disable-model-invocation` frontmatter key in `skill/index.ts` — acceptance:
      a SKILL.md with `disable-model-invocation: true` loads with
      `disable_model_invocation === true`; one without it loads `undefined`; no
      reference to `Info.hidden` remains in `src` (covers: S2)
- [x] T2: Add `Skill.modelInvocable(agent?)` and move the three model-facing
      call sites (`session/system.ts:181`, `tool/registry.ts:328`,
      `tool/skill-search.ts:37`) onto it, leaving `SystemPrompt.available` and
      the `prompt.ts:864` mention scan on `available` — acceptance: a
      `disable-model-invocation` skill is absent from the system-prompt catalog,
      the `skill` tool description, and `skill_search` results, while
      `Skill.available` and `Skill.all` still return it (covers: S2; depends: T1)
- [x] T3: Refuse `disable_model_invocation` skills in `tool/skill.ts` before
      `ctx.ask`, and filter the not-found "Available skills" hint by the same
      predicate — acceptance: `skill({name})` on such a skill throws an error
      naming `disable-model-invocation` and directing the model to have the user
      type `/name`; the name does not appear in the not-found hint for a
      mistyped query (covers: S2; depends: T1)
- [x] T4: Graduate `compose-next`: delete `"compose-next": "deny"` from
      `agent/agent.ts`, set `disable-model-invocation: true` in its SKILL.md,
      add the "only on explicit user invocation" rule to both its `description`
      and body, and drop `compose-next` from `isComposeSkill` in
      `skill/search.ts` — acceptance: `Permission.evaluate("skill",
      "compose-next", defaultAgentRules)` is `allow`; `compose:*` still `deny` on
      the default agent and `allow` on Compose; `searchSkills` no longer
      special-cases the name (covers: S2; depends: T1)
- [x] T5: Add a regression test that a user slash invocation of a
      `disable-model-invocation` skill injects its body, following the real-layer
      harness in `test/session/prompt-skill-command-multi.test.ts` — acceptance:
      the test fails on the base commit (no `<skill_content>` part for the
      invoked skill) and passes after T1-T4 (covers: S1, S2; depends: T2)
- [x] T6: Update the tests that encode the old deny-as-visibility contract
      (`test/permission/compose-next-discovery.test.ts`,
      `test/skill/search.test.ts:101-115`, `test/tool/skill-search.test.ts:196+`)
      and add coverage for frontmatter parsing plus `modelInvocable` filtering —
      acceptance: `bun test test/skill test/tool test/permission test/session`
      shows no failures attributable to this change (covers: S2; depends: T4)
- [x] T7: Record in `mimocode-docs` that `/compose-next` is user-invocable only
      and the model must not start it — acceptance: the skill states both facts
      where it already documents `/compose-next` (covers: S2)
- [x] T8: Bring the published `AppSkillsResponses` type in
      `packages/sdk/js/src/v2/gen/types.gen.ts` in line with the new
      `Skill.Info` shape — acceptance: the skills response type carries
      `disable_model_invocation?: boolean` and no `hidden?: boolean`.
      `./packages/sdk/js/script/build.ts` cannot be used: it has failed since
      `fc74c539` (2026-07-26) because `ToolStateCompleted.providerOutput`
      serializes to a dangling `$ref: #/components/schemas/__schema0`, and the
      committed types.gen.ts still has no `providerOutput`, confirming the file
      predates that commit. Record the field-level hand edit and leave the
      generator defect to its own change (covers: S2; depends: T1)
