---
feature: plan-enter-removal
status: delivered
updated: 2026-08-03
branch: plan-enter-removal
commits: ce124cbd..e28331185884
---

# Remove the plan_enter tool

## Report

**What was built** — `plan_enter` is gone: tool, description file, registry wiring,
tool-script exclusion, the three permission rules, the headless deny rule, the TUI
`plan_enter → plan` switch mapping, and the `tui.question.plan_enter.*` block in
all seven locales. `plan_exit` and everything else about plan mode are untouched,
so `build` and `plan` now expose exactly the same mode tool and Tab still
round-trips between them. The system prompt lost its plan-mode advocacy paragraph
and gained no replacement instruction; the user-facing answer to "how do I enter
plan mode" moved to `mimocode-docs`, which loads only when someone asks how
MiMoCode works.

**Verification** — from `packages/opencode`: `bun typecheck` PASS.
`bun test test/tool test/cli/tui test/agent test/permission` — 1274 pass / 1 fail
/ 11 skip, where the single failure is `test/tool/registry.test.ts > loads tools
from .mimocode/tool (singular)` timing out at 5000ms under parallel load;
PRE-EXISTING flake, 5 pass / 0 fail when the file runs alone.
`bun test test/skill` — 79 pass / 0 fail. `bunx prettier --check` on the touched
files — clean (`i18n/*.ts`, `registry.ts`, `agent.ts` are nonconformant at base
`ce124cbd` too, verified by stashing). `git diff --check` PASS. Root
`bun run lint` — 0 errors, ~4040 PRE-EXISTING warnings. Independent reviewer:
spec compliance met after two fixes (see log), no correctness bugs, style
consistent.

**Journey log**

1. First attempt gated `plan_enter` behind a default-deny permission rule, then
   behind a registration flag. Both work mechanically; neither was the question.
   The question was whether anything justifies keeping the surface at all, and
   nothing did — the deciding evidence was the entrance table in S2, not any
   property of the gating mechanism.
2. The first prompt rewrite replaced the advocacy paragraph with instructions on
   how to *talk about* plan mode. That is the same interruption in a new costume:
   a model told how to discuss plan mode will discuss it. The fix was deletion,
   moving the user-facing answer to an on-demand skill.
3. `mimocode-docs` routing keys off the frontmatter `description` (BM25 over name
   + aliases + description, `skill/search.ts:98`). The body can hold a perfect
   answer and still never load; the mode/keybinding vocabulary had to go into the
   description.
4. `rg -rn <pattern>` silently means `--replace n`, printing `n` where matches
   were. Two searches during this change reported false clean states. Use
   `rg -n`.
5. No locale key-parity test exists in this package, and `test/cli/tui/i18n` is
   not a real path — a verification band naming it exercises nothing. Question
   i18n is fail-soft anyway (`routes/session/question.tsx:24` falls back to the
   DB-stored text), so deleted keys cannot break historical replay.

## [S1] Problem

Users report that plan mode behaves badly with frontier models, and that the
model keeps putting itself into plan mode unasked.

Plan mode's workflow was designed for weaker models: a five-phase curriculum
(parallel `explore` subagents → a `general` design subagent → review → write the
plan file → `plan_exit`) injected as a ~90-line system-reminder on every entry
(`packages/opencode/src/session/prompt.ts:991-1073`). Frontier models do not fit
that shape — they research and weigh alternatives before acting anyway, so the
phase scaffolding mostly buys tokens and extra turns. A large share of users have
responded by staying in Build for everything.

For a build-only user, every model-initiated switch into plan mode is pure
interruption: a Yes/No card they did not ask for, leading either to a mode they
did not want or to a "No" that the model may still misread. Cutting that
interruption is the point of this change.

Both complaints share one cause: `plan_enter` exists as a model-callable tool.

Nothing in a system prompt is needed to trigger it. The tool's own description
is a standing invitation (`packages/opencode/src/tool/plan-enter.txt:5`):

> If the user explicitly mentions wanting to create a plan, ALWAYS call this
> tool first.

A tool description is part of every request's schema, so any model that reads
"the user said plan" reaches for it. When it fires, the tool writes a synthetic
user message carrying `agent: "plan"` (`src/tool/plan.ts:80-96`), which discards
the mode the user selected and swaps in a read-only agent plus a ~90-line
workflow system-reminder (`src/session/prompt.ts:991-1073`). The user gets a
Yes/No card, but the decision was framed by the model, not requested by the
user.

The value the tool delivers is small, because it is not how anyone actually
enters plan mode.

## [S2] Design

Delete `plan_enter` outright. Keep `plan_exit`. Keep the `plan` agent, its
`hardPermission` write-block, the plan file, and the plan workflow prompt
exactly as they are.

### Why deletion, not a flag

**1. It is not a user-facing entry point.** Plan mode has five other entrances,
none of which this change touches:

| Entrance | Site | Affected |
| --- | --- | --- |
| Tab / shift+tab agent cycle | `config/keybinds.ts:64-65` → `cli/cmd/tui/context/local.tsx:113` | no |
| Agent dialog | `cli/cmd/tui/component/dialog-agent.tsx:30` | no |
| Startup `--agent plan` | `cli/cmd/tui/thread.ts` | no |
| Input-bar / voice switch | `cli/cmd/tui/component/prompt/index.tsx:202` | no |
| Model calls `plan_enter` | `tool/plan.ts:21` | **removed** |

`plan_enter` has no slash command and no keybinding — a user cannot invoke it
even deliberately. Removing it removes a model capability, not a user gesture.
`build`/`plan` remain the free-switch group (`local.tsx:50`), so Tab still
round-trips between them mid-session.

**2. It is already dead outside the TUI.** `mimo run` denies both plan tools
unconditionally (`cli/cmd/run.ts:350-365`), so headless sessions have never had
it. Removal aligns the TUI with the surface that already ships without it.

**3. A registration flag would work but earns nothing.** Gating the tool's
registration on a config flag (the `experimental.maxMode` / orchestrator pattern)
is a perfectly serviceable way to default it off. It just buys nothing here: it
keeps the description, the i18n strings, the TUI switch mapping and the tests in
the tree to serve a default-off path with no evidence of demand, and it leaves a
second knob for a decision nobody has asked to reverse. The repository's stance is
to delete unused code rather than keep a shim. If demand appears, restoring one
tool from git history is cheap — and restoring it behind a flag then is no harder
than adding the flag now.

**4. `plan_exit` is not symmetric and stays.** It cannot solicit itself: it
no-ops unless the session is already in plan mode (`tool/plan.ts:120`), which
only a user gesture can establish. It is also the approval handshake the plan
workflow terminates on (`session/prompt.ts:1066-1070`). After this change both
`build` and `plan` expose exactly `plan_exit`, so switching modes still does not
mutate the tool list (the invariant from PR #1207).

### Accepted consequences

- **Natural-language planning no longer flips the mode.** "帮我先做个计划" in
  build now yields planning in the reply, not a read-only agent, and the
  `hardPermission` write-block does not engage. `prompt/default.txt` is
  corrected so the model recommends the Tab switch instead of silently losing
  the affordance (see below). This is the intended trade: the user owns the
  mode.
- **One-time prefix-cache invalidation.** `build`'s tool schema loses an entry,
  so the first request of every pre-existing session after upgrade recomputes
  its prefix. This is a version-upgrade-level cost, unavoidable for any tool
  removal, and it does not recur.

### Prompt correction

`prompt/default.txt` is the fallback system prompt (`session/system.ts:49`) —
i.e. the one MiMo's own models get; `anthropic.txt` / `gpt.txt` / `codex.txt` /
`gemini.txt` / `beast.txt` / `deepseek.txt` / `glm.txt` / `minimax.txt` /
`trinity.txt` contain no plan-mode instructions at all, and `kimi.txt:17` only
mentions plan mode as an example of a system-reminder. So exactly one prompt
needs editing:

- `default.txt:87` — drop `plan-enter` from the "Mode / safety" tool list.
- `default.txt:132` (item 5 of "Plan mode in detail") — absorb the entry rule into
  the existing exit rule: the user switches in and out themselves (`Tab` or the
  agent dialog); the model cannot enter plan mode; **and the model must not tell
  the user they could switch manually unless the user raises plan mode first**.
  The model's one mode tool remains `plan_exit`, which requests approval of a
  finished plan and the switch back to build.
- `default.txt:134` — delete the "Enter plan mode for non-trivial implementation
  work…" paragraph outright. Do not replace it with a paragraph about what to do
  instead: an instruction that discusses plan mode is itself a prompt to bring
  plan mode up. Frontier models should just do the work.

The net effect on the prompt is one shortened line and one deleted paragraph — no
new behavioural instruction, no standing invitation.

`session/prompt/compose.txt` also names `plan_enter` (line 20) but is
deliberately left byte-identical: it is a model-facing system prompt for the
deprecated Compose agent, and any change invalidates prefix cache for every
existing Compose session (constraint carried from `compose-next.md` S5). A stale
"do not use a tool that no longer exists" sentence is harmless.

### Documentation surfaces

Two audiences need different treatment, and conflating them is what made the
first draft of the prompt edit wrong.

**The model, always:** nothing. Removing the advocacy paragraph is the whole
change. It carries no guidance about recommending plan mode, because a model that
has been told how to talk about plan mode will talk about plan mode.

**The user, on demand:** one genuine question survives — "how do I get into plan
mode?" / "why don't you switch to plan any more?" That answer belongs in
`mimocode-docs`, which is loaded exactly when a user asks how MiMoCode itself
works (`skill_search` BM25 over name + description, or explicit `/mimocode-docs`),
and costs nothing on every other turn. Users also learn the `Tab` gesture from
the home tips, so this is a fallback for the confused case, not the primary
teaching surface.

- `mimocode-docs/SKILL.md` frontmatter `description` — add mode / keybinding
  vocabulary ("agent modes (build / plan / compose) and how to switch between
  them", "how to enter or leave plan mode") so the routing actually fires on that
  question. Without it the skill's description never mentions modes and BM25 has
  nothing to match.
- `mimocode-docs/SKILL.md:18` — the Agents / modes row states that only the user
  enters a mode, that no tool switches into plan, and that `plan_exit` is the
  agent's one move from inside plan.
- `mimocode-docs/reference/commands.md:130` — under Keybindings, the concrete
  answer: `Tab` or the agent dialog to enter; `Tab` or `plan_exit` to leave; and
  that the agent will not offer plan mode unasked (so the user reads the silence
  as intended behaviour, not a regression).

`mimocode-docs/reference/guide.md:114` and `config.md:92` mention plan only as a
Compose-legacy skill name and an agent-config key; both stay accurate and are
left alone. The localized `tui.skill.mimocode-docs.description` strings are the
dialog copy, not the routing input, so they are untouched.

## [S3] Implementation

Delete:

- `packages/opencode/src/tool/plan-enter.txt`
- `PlanEnterTool` in `packages/opencode/src/tool/plan.ts` (keep `getLastModel`
  and `PlanExitTool`)
- `packages/opencode/src/tool/registry.ts` — the `plan_enter` import, its
  `Tool.init` entry, and `tool.planenter` in `builtin`
- `packages/opencode/src/tool/tool-script-ref.ts:29` — `"plan_enter"` exclusion
- `packages/opencode/src/agent/agent.ts` — the `plan_enter` rules at `:113`
  (defaults deny), `:141` (build allow), `:181` (plan allow)
- `packages/opencode/src/cli/cmd/run.ts:356-360` — the `plan_enter` deny rule
- `packages/opencode/src/cli/cmd/tui/routes/session/plan-switch.ts:7` — the
  `plan_enter → "plan"` mapping
- the `tui.question.plan_enter.*` block (6 keys plus its comment header) from all
  seven locale files under `packages/opencode/src/cli/cmd/tui/i18n/`. There is no
  locale key-parity test in this package, so removal is verified by grep for
  residual keys rather than by a suite. Deleting them cannot break historical
  replay either way: `routes/session/question.tsx:24` falls back to the
  DB-stored question text when a `tui.question.<key>.*` lookup misses.

Modify:

- `packages/opencode/src/session/prompt/default.txt` — lines 87 and 134 per S2.
- `packages/opencode/src/skill/builtin/.bundle/mimocode-docs/SKILL.md` and
  `reference/commands.md` — per S2 Documentation surfaces.

Tests:

- `test/tool/plan.test.ts` — drop the `plan_enter` "No" case; `plan_exit` cases
  unchanged.
- `test/cli/tui/plan-switch.test.ts` — drop the `plan_enter → "plan"` cases and
  keep one inverted assertion: a completed `plan_enter` part must now map to
  `undefined`. Resumed sessions still hold historical `plan_enter` parts in the
  DB, and replaying them must not switch the mode.
- `test/agent/agent.test.ts:160,177` — assert on `plan_exit` only.
- `test/permission/disabled.test.ts:53-65` — these exercise `Permission.disabled`
  semantics using tool names as data; rename the subjects to `plan_exit` /
  `question` so no test references a deleted tool.
- `test/tool/tool-script.test.ts:557` — drop `plan_enter` from the exclusion-set
  assertion.
- New: `test/tool/plan-enter-absent.test.ts` — `registry.ids()` does not contain
  `plan_enter`, and does contain `plan_exit`. This is the regression guard
  against a re-add.

Verification, from `packages/opencode`: `bun test test/tool test/cli/tui test/skill
test/agent test/permission`, `bun typecheck`, `git diff --check`, and
`bunx prettier --check` on the touched files. Two baseline caveats: root
`bun run lint` reports ~4040 pre-existing warnings (0 errors), and
`src/cli/cmd/tui/i18n/*.ts`, `src/tool/registry.ts` and `src/agent/agent.ts` are
already prettier-nonconformant on `main`, so those files must be compared against
their own baseline rather than to a clean `prettier --check`.

Do not touch: `session/prompt/compose.txt`, `Session.plan()`, the `plan` agent's
`hardPermission`, the plan workflow reminder in `session/prompt.ts`, the
`build`/`plan` free-switch group, or the delivered reports and specs that describe
past state (`docs/compose/reports/sticky-agent-mode.md`,
`docs/compose/spec/plan-no-continue.md`) — they document the state at their own
delivery and stay as written.

## [S4] Roadmap — deliberately not in this change

`compose-next.md` S4.5 already parked "plan-mode dissolution and Tab permission
presets" as independent work. This section records the intended direction so the
present change is legible as a first step toward it, and fixes what must not be
done yet. **None of it is in scope here, and none of it is committed to.**

**Direction: plan mode goes away.** The current lean is to stop shipping plan as
an agent at all and split it along its two real concerns:

1. **Permission handled by another mechanism** — the only part of plan mode
   carrying durable value is the `hardPermission` write-block. As a permission
   preset (read-only / ask / accept-edits / bypass) switchable mid-session, it
   applies to whatever agent the user is already in instead of forcing them into
   a different one, and it composes with the existing ruleset machinery
   (`permission/index.ts`) with no new name-branching. Claude Code's shift+tab
   cycle is the reference shape. One constraint that design must respect:
   `Permission.evaluate` is `findLast` over the flattened rulesets with no
   specificity scoring (`permission/evaluate.ts:9-15`), and
   `--dangerously-skip-permissions` merges `{"*": "allow"}` into the last `user`
   layer (`config/config.ts:953`) — so a read-only preset expressed as an ordinary
   ruleset deny would be silently defeated by allow-all. Today's plan mode dodges
   this via `hardPermission` being re-appended after the user merge; a preset needs
   an equivalent last-layer story.
2. **A plan skill** — the ~90-line workflow injected as a system-reminder
   (`session/prompt.ts:991-1073`) is curriculum, not policy, and per S1 it is
   curriculum aimed at weaker models. `compose-next` already established the
   migration pattern: collapse the curriculum into one compact executable
   contract, loaded on demand by explicit invocation, instead of taxing every
   plan turn's prompt.

**Ordering constraint.** The permission mechanism must ship before `plan` leaves
the Tab cycle. Plan mode is today the only read-only backstop in the TUI;
removing it first would leave users with no way to get one.

**Keybinding.** shift+tab is `agent_cycle_reverse` today
(`config/keybinds.ts:65`). It frees up naturally: once `plan` and `compose` exit
the primary cycle, the cycle holds one or two entries and Tab alone covers it.
Do not reassign shift+tab before that happens.

**Do not mark Plan "(legacy)" yet.** Compose could carry the label
(`compose-next.md` S2) because its successor had already shipped and users had
somewhere to go. Plan has no successor in the tree: no permission preset, no plan
skill. Labelling it now would announce the mode is going away while it is still
the only way to get a write-block, which is worse than saying nothing. The label
belongs in the PR that lands the permission mechanism.

## [S5] Out of scope

- Removing the `plan` agent, its `hardPermission`, `plan_exit`, the plan file,
  or the plan workflow prompt.
- Any keybinding change, including reassigning shift+tab.
- Introducing permission presets or a plan skill (S4 direction only).
- Marking Plan deprecated in any UI surface.
- Any byte change to `session/prompt/compose.txt`.
- Rewriting the plan workflow reminder's content (only `plan_exit` survives in
  it, and that reference stays valid).
- Hardening `bash` against writes in plan mode (existing "trust the model,
  permission is a backstop" stance).
- `packages/web/src/content/docs/**` — the upstream opencode website, carried in
  ~12 locales. Per `AGENTS.md` the TUI is the supported surface; syncing that
  corpus is its own change.

## Tasks

- [x] T1: delete `PlanEnterTool`, `plan-enter.txt`, and its registry / tool-script-ref wiring — acceptance: `registry.ids()` omits `plan_enter` and still contains `plan_exit`; `bun typecheck` clean (covers: S2, S3)
- [x] T2: remove the three `plan_enter` permission rules in `agent/agent.ts` and the deny rule in `cli/cmd/run.ts` — acceptance: no `plan_enter` string remains in `src/agent` or `src/cli/cmd/run.ts`; build and plan agents both expose exactly `plan_exit` (covers: S2, S3; depends: T1)
- [x] T3: remove the `plan_enter` branch in `plan-switch.ts` and the `tui.question.plan_enter.*` block from all seven locales — acceptance: `rg "plan_enter" src/cli/cmd/tui` returns nothing; no locale file is left with a dangling comment header or a double blank line; `plan_exit` switch mapping still returns `"build"` (covers: S3; depends: T1)
- [x] T4: correct `prompt/default.txt` — acceptance: no `plan-enter` in the tool list; item 5 of "Plan mode in detail" states the user switches modes, forbids unprompted suggestions to switch, and keeps `plan_exit` as the model's request path; the "Enter plan mode for non-trivial implementation work" paragraph is gone with no behavioural replacement (covers: S2)
- [x] T5: make `mimocode-docs` answer "how do I enter/leave plan mode" — acceptance: the frontmatter description carries mode/keybinding vocabulary so the question routes to the skill; `SKILL.md` and `reference/commands.md` both state that entering is a user gesture (`Tab` / agent dialog), that no tool enters plan, that `plan_exit` is the agent's only move, and that the agent will not raise plan mode unasked (covers: S2, S3)
- [x] T6: update the five affected test files and add `test/tool/plan-enter-absent.test.ts` — acceptance: no test asserts a deleted tool is available; the historical-part guard in `plan-switch.test.ts` proves a replayed `plan_enter` part no longer switches modes; the new test fails if `plan_enter` is re-registered (covers: S3; depends: T1, T2, T3)
- [x] T7: verification band — acceptance: the S3 test bands, `bun typecheck`, and `git diff --check` all pass from `packages/opencode` (covers: S3; depends: T1-T6)
