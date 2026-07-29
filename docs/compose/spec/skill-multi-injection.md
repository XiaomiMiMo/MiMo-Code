---
feature: skill-multi-injection
status: delivered
updated: 2026-07-27
branch: fix/skill-multi-injection
commits: 014a2577..5e010a3c
---

# Skill Multi-Injection

## Report

**What was built** — The `cmd.source === "skill"` non-subtask branch of
`SessionPrompt.command` no longer emits a `<skill_content>` part. Skill bodies
now have exactly one injector: the mention scan in `insertReminders`, which
detects the invoked skill from the leading `/${input.command}` token of the
visible text part. `insertReminders` itself is unchanged — its `alreadyWrapped`
guard keeps its real job (stopping step 2+ from restacking step 1's blocks) and
loses only its obsolete job (avoiding a double wrap with the command path).

Because both sources of skills now flow into one `mentioned` list, the
`MAX_AUTOLOAD = 3` budget and the `mentioned.length >= 2` orchestration reminder
count them uniformly, with no reconciliation logic. `/a ... /b` injects both
bodies plus the orchestration reminder; four or more mentions overflow to the
Skill-tool hint as before.

Test hygiene was fixed alongside: five skill-related test files were writing
`MIMOCODE_DISABLE_*_SKILLS` at module scope, leaking into every file scheduled
later in the same `bun test` process. They now share a `withEnv` helper
(`test/lib/env.ts`) that applies flags in `beforeAll` and restores them in
`afterAll`.

**Verification** — all from `packages/opencode`:

- `bun typecheck` — PASS (clean).
- `bun test test/session/prompt-skill-command-multi.test.ts` — 2 pass. Confirmed
  failing before the source change, with the intended symptom: only
  `skill-alpha` injected, no `skill-beta` block, no orchestration reminder.
- `bun test test/skill test/tool/skill-search.test.ts test/tool/skill.test.ts
  test/session/prompt-skill-command-multi.test.ts
  test/session/prompt-skill-mention.test.ts test/command` — 95 pass, 4 skip,
  0 fail.
- `bun test test/session test/tool` — 1536 pass, 22 skip, 1 fail.
  `SessionCheckpoint.insertRebuildBoundary … when rebuild context is empty` is
  `PRE-EXISTING`: the same suite on base `014a2577` fails it too, plus an extra
  `snapshot race` flake. Both pass in isolation, so they are suite-order flakes
  unrelated to skills.
- Independent review by a fresh subagent: no critical findings; spec compliance,
  correctness and consistency all cleared.

The change is delivered on `fix/skill-multi-injection` as `5e010a3c`; this
document is committed separately, outside the reviewed range.

**Journey log**

1. The bug was reproduced live in the authoring session itself: a message of the
   form `/compose-next … /mimocode-docs …` delivered only the first skill's body.
   The agent's own context was the evidence.
2. The first design considered turning `alreadyWrapped` into a per-name set so
   both injectors could coexist. Rejected: it keeps two injectors in sync by
   hand, and the `MAX_AUTOLOAD` budget plus the orchestration-reminder count both
   have to be reconciled manually — exactly the drift that caused the bug.
3. What made the smaller fix safe was `prompt.ts:4182-4183`: skills already skip
   the `$1..$N` / `$ARGUMENTS` template machinery, and the command path wrapped
   the raw `templateCommand`, byte-identical to the `info.content` the scan
   injects. Deleting the wrap therefore loses nothing. Zero of the 22 bundled
   skills use `$ARGUMENTS` or `` !`bash` ``.
4. Do not delete the whole branch: the `visibleText` part must stay, because the
   scan's only handle on the invoked skill is its leading `/name` token.
5. Injection correctness now depends on a regex over rendered text rather than a
   registry lookup, so non-slug skill names (`skill/index.ts:30` accepts any
   string) silently inject nothing. Accepted by explicit user decision — skills
   are expected to use standard slugs.

## [S1] Problem

When a user message begins with a skill slash-invocation and mentions a second
skill later in the same message, only the first skill's body is injected. The
second one survives as literal text and the model never sees its `SKILL.md`.

Reproduction: send `/compose-next 分析一下 ... /mimocode-docs 例如 ...`. The
model receives one `<skill_content name="compose-next">` block, no
`<skill_content name="mimocode-docs">` block, and no multi-skill orchestration
reminder.

Root cause is two independent injection points:

1. **Command path.** `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:1169-1177`
   routes any input starting with `/` by resolving only the first token of the
   first line as a command name. Skills are registered as commands
   (`packages/opencode/src/command/index.ts:264-276`, `source: "skill"`), so
   `/compose-next` matches and everything after it — including
   `/mimocode-docs` — becomes `arguments`. Server-side,
   `packages/opencode/src/session/prompt.ts:4259-4269` emits a visible text part
   plus one `<skill_content>` part for `input.command` only.

2. **Free-text scan.** `packages/opencode/src/session/prompt.ts:727-796` scans
   the message body for all skill mentions and handles multiple skills
   correctly (global regex at `prompt.ts:739`, dedupe, `MAX_AUTOLOAD` cap,
   orchestration reminder at `prompt.ts:766`).

The scan is gated by `alreadyWrapped` (`prompt.ts:724-727`), a message-level
boolean that is true as soon as any part starts with `<skill_content name="`.
The command path already pushed such a part, so the entire scan is skipped.
The guard's granularity is the whole message, not the individual skill.

The two paths inject equivalent content, so the split serves no purpose:
`prompt.ts:4182-4183` makes skills skip the `$1..$N` / `$ARGUMENTS` template
machinery entirely (`template = input.arguments`), and `prompt.ts:4265` wraps
the raw `templateCommand`, which is `item.content`
(`command/index.ts:271-273`) — byte-identical to the `info.content` the scan
injects at `prompt.ts:760`.

## [S2] Design

Give skill-body injection a single owner: the free-text scan in
`insertReminders`. The command path keeps alias resolution, argument expansion,
attachment resolution, and the visible text, but stops injecting the body.

**Command path contract** — `prompt.ts:4259-4269`, non-subtask
`cmd.source === "skill"` branch:

- Emit `parts = [visibleText, ...attachments, ...input.parts]`. Drop the
  `skillPart`.
- `visibleText` keeps its current form and must keep `/${input.command}` as the
  leading token. This token is the detection signal for the scan.
  `input.command` is the canonical skill name — the TUI resolves localized
  slash aliases to it client-side via `resolveSkillSlash`
  (`cli/cmd/tui/i18n/skill.ts:19-27`, used at `index.tsx:1174`) — so a
  localized invocation such as `/深度研究` arrives as `/deep-research` and
  matches the scan regex.
- The subtask branch (`prompt.ts:4245-4258`) is unchanged. It inlines skill
  content into a subtask prompt and never had the multi-skill defect.
- `templateCommand` (`prompt.ts:4179`) stays — the subtask branch still reads
  it at `prompt.ts:4247`.

**Scan contract** — `prompt.ts:720-797` requires no change:

- `alreadyWrapped` loses its stated purpose (the command path no longer wraps)
  but retains its actual load-bearing role: cross-step idempotency.
  `insertReminders` runs on every step (`prompt.ts:3387`) and `updatePart`
  persists, so the parts injected at step 1 make the guard true at step 2+ and
  prevent restacking. This is the same mechanism documented at
  `prompt.ts:819`.
- The command-invoked skill and any text-mentioned skills now enter one
  `mentioned` list, so `MAX_AUTOLOAD` and the `mentioned.length >= 2`
  orchestration reminder count them uniformly. No separate reconciliation
  logic is needed.

**Accepted behavior changes:**

- The command-invoked skill counts against `MAX_AUTOLOAD = 3`
  (`prompt.ts:749`). It appears first in the message text and the scan
  preserves text order, so it is never the one dropped; a fourth mention
  overflows to the Skill-tool hint instead.
- `/a ... /b` now injects the orchestration reminder
  (`prompt.ts:778-790`), which it previously suppressed.
- Skill bodies move from "immediately after the visible text, before
  attachments" to "appended to `userMessage.parts` during `insertReminders`",
  and are created during the prompt loop rather than at message construction.
- Injection becomes turn-scoped rather than persisted at message construction.
  If a turn dies between persisting the user message and the first
  `insertReminders` pass (cancel, agent-resolution failure), the message keeps
  its `/skill-a` text with no body, and no later turn will backfill it —
  `insertReminders` only ever targets the last user message (`prompt.ts:656`).
- The `command.execute.before` plugin hook (`prompt.ts:4275-4279`) no longer sees
  a `<skill_content>` part in `parts` for skill invocations, only the visible
  text and attachments. No in-repo plugin reads it; external plugins that did
  will observe the change.

**Test isolation:** Bun runs every file of a `bun test` invocation in one
process, so a module-level `process.env` write leaks into files scheduled later.
Skill tests that force `MIMOCODE_DISABLE_*_SKILLS` must set the flag in
`beforeAll` and restore it in `afterAll` — the flags are lazy getters
(`flag/flag.ts:279-287`), so scoping them this way works.

**Skill naming assumption:** skill names are standard slugs matching the scan
regex `[A-Za-z][A-Za-z0-9_:-]*`. Colon-namespaced names such as `compose:ask`
are covered.

**Set equivalence:** the command registry enumerates via `Skill.all()`
(`skill/index.ts:298-301`) and the scan via the same `all()`, neither applying
`hidden` or permission filtering (that is `available()`,
`skill/index.ts:307-314`). Every command-invokable skill is therefore
scan-resolvable.

## [S3] Out of Scope

- Validating or normalizing skill names. `skill/index.ts:30` accepts any
  string; enforcing slugs is a separate change. Non-slug names (CJK, digit-led)
  are not supported by this design.
- Changing the mention regex at `prompt.ts:739`.
- Tuning `MAX_AUTOLOAD`.
- The TUI leading-slash routing at `index.tsx:1169-1177` and the ACP equivalent
  at `acp/agent.ts:1372-1383`. Both are unchanged and inherit the fix, since it
  is server-side.
- Skill invocation dispatched as a subtask.

## Tasks

- [x] T1: Add a failing end-to-end regression test that invokes a skill via
      `SessionPrompt.command` with a second skill mentioned in the arguments,
      following the real-layer harness in
      `packages/opencode/test/session/plan-reminder-dedup.test.ts` (live
      `SessionPrompt` + `Session` layers, tmpdir fixture, stubbed SSE stream) —
      acceptance: the test runs and fails against the base commit because the
      user message carries only `<skill_content name="skill-a">`, with no
      `skill-b` block and no orchestration reminder (covers: S2)
- [x] T2: Drop the `skillPart` from the non-subtask `cmd.source === "skill"`
      branch in `packages/opencode/src/session/prompt.ts:4259-4269`, keeping the
      visible text and attachments — acceptance: T1 passes; a lone `/skill-a`
      still yields exactly one `<skill_content name="skill-a">` part; `/skill-a
      args` still carries the argument text and any resolved attachment
      (covers: S2; depends: T1)
- [x] T3: Fix the stale source reference in
      `packages/opencode/test/session/prompt-skill-mention.test.ts:3`, which
      cites `src/session/prompt.ts:684` for a regex that has since moved —
      acceptance: the comment points at the `mentionRe` symbol rather than a
      line number, so it cannot rot again, and the existing regex tests still
      pass (covers: S2)
- [x] T4: Scope the `MIMOCODE_DISABLE_*_SKILLS` env writes in the skill tests so
      they no longer leak across files in a shared `bun test` process, via a
      single `withEnv` helper — acceptance: `test/skill/skill.test.ts`,
      `test/skill/loop.test.ts`, `test/skill/bundle-discovery.test.ts`,
      `test/tool/skill-search.test.ts` and the new multi-injection test all set
      their flags through `withEnv` and restore the prior values, and
      `bun test test/session test/tool` plus `bun test test/skill` show no new
      failures (covers: S2)
