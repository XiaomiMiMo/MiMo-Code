---
feature: subagent-no-nesting
status: delivered
updated: 2026-06-18
branch: subagent-no-nesting
commits: dd1a5c53..7b5f766d
---

# Subagent nesting off by default

## Report

**What was built** — A subagent no longer sees the `actor` tool, so delegation is one level deep by default. A single pass at the end of `Agent.state` (`src/agent/agent.ts`) appends `actor: "deny"` to every agent with `mode === "subagent"`, unless that agent's ruleset already carries an explicit `actor` rule. Because the rule's pattern is `"*"`, `Permission.disabled` drops `actor` from the agent's LLM-visible tool schema in `llm.ts` `resolveTools`, which also makes its `ctx.ask({ permission: "actor" })` unreachable. `general`'s system prompt no longer invites delegation, and the per-turn recall reminder no longer names `actor` to an agent that cannot see it.

The opt-back-in is an explicit `actor` rule — `agent.<name>.permission.actor: "allow"` or a global `permission.actor` — mirroring the neighbouring `external_directory` pass's "unless explicitly configured" contract. Any explicit `actor` rule counts, including `"ask"`, which is accepted: a user who configures the permission by name has stated an intent about it. A blanket `"*": "allow"` deliberately does not re-enable nesting.

Programmatic spawn paths are untouched by design, because none of them reads the subagent's tool schema: `bypassAgentCheck` (`@agent` mentions), the workflow runtime's `spawnRef` spawns, `checkpoint-writer` forks, and orchestrator peers via the `session` tool. `exec`/tool-script cannot re-expose it either — `actor` is in `TOOL_SCRIPT_EXCLUDED`. Permission rules gate the LLM's tool schema, not the spawn API.

**Verification**

- `bun typecheck` (packages/opencode) — PASS, run again after the review fixes
- `bun lint` (oxlint, repo root) — 0 errors, 4092 warnings PRE-EXISTING
- `bun test test/agent/ test/tool/actor.test.ts test/tool/actor-recover.test.ts test/actor/` — 233 pass / 9 fail; the identical 9 failures reproduce on clean `main` → PRE-EXISTING (this machine's global config sets `edit: "ask"`, which un-denies edit-family tools for read-only agents). `main` additionally flaked `runLoop emits a per-step turn heartbeat`.
- `bun test test/session/prompt-effect.test.ts test/session/recall-reminder.test.ts test/tool/actor.test.ts` — 74 pass, 0 fail
- New tests (5) all PASS: subagent-wide `actor` deny with primaries as the negative control, config opt-back-in, `checkpoint-writer` fork parity, absence of the old prompt invitation, recall hint omission.
- Live `bun dev debug agent` — before: `general actor=true`; after: `build actor=true`, `general actor=false`, `explore actor=false`.

**Journey log**

- The obvious placement was wrong. Merging `actor: "deny"` *before* the agent's own ruleset — intended to let user config win by `findLast` — left `general` with `actor` still visible, because `defaults` carries `"*": "allow"` and the wildcard rule matches every tool name. The rule must be appended last, with an explicit-rule skip guard as the escape hatch. Live `debug agent` caught this immediately; the reasoning alone had not.
- `agent.prompt` replaces the base system prompt entirely (`System.agent`, `session/system.ts:52`), so `default.txt`'s "spawn Agent with subagent_type=Explore" guidance never reaches `general`. Only per-agent prompts needed editing.
- Removing a tool from an agent leaves *prose* references behind. `recallHintLines` was advertising `actor({operation:"status"})` into any session with memory or tasks, ungated by agent mode — found by review, not by tests. When a change hides a tool, grep the synthetic reminders too. Related tone lesson: the first rewrite of the prompt bullet *explained* that delegation was unavailable, which both plants the concept and addresses a human reader; deleting it outright was the right move.
- Baselining on the untouched `main` worktree before judging failures was essential here: 9 of the failing tests in scope fail identically on `main` because of this machine's global permission config.
- The review's two CRITICAL findings were both against this document, not the code: a stale `[S2]` mechanism (the pre-fix merge order) and unrecorded verification. Commit `7b5f766d` fixes the MEDIUM findings it raised and was verified afterwards, but landed after the reviewed head `3c2527bf`.

## [S1] Problem

A `general` subagent can spawn further subagents, with no depth limit.

- `agent.ts` gives `general` `Permission.merge(defaults, user)`, and `defaults` carries `"*": "allow"`; it declares no `toolAllowlist`.
- `Permission.disabled` (permission/index.ts:669) only drops a tool when the last matching rule has `pattern === "*"` and `action === "deny"`, so nothing removed `actor` from `general`'s schema.
- `tool/actor.ts` passes `tools: "INHERIT"` for an agent without a `toolAllowlist`, and `prompt.ts:1276` turns `INHERIT` into "no runtime whitelist".
- `Actor.spawn` records only `parentActorID`; there is no depth field and no ancestry check anywhere on the spawn path.
- `prompt/general.txt` actively invited it: "You may delegate genuinely independent, bounded subtasks when that improves throughput".

Verified before the change: `bun dev debug agent general` reported `"actor": true`; `explore` reported `"actor": false` only because of its own blanket `"*": "deny"`, not by design.

Consequences: unbounded fan-out of agent trees, cost and concurrency that no single cap governs (`workflow/runtime.ts:34`'s lifecycle cap only bounds `workflow()`'s own `spawnRef` spawns), and a parent that cannot account for work done two levels down.

## [S2] Design

Make one level of delegation the default: a subagent does not see the `actor` tool at all.

**Mechanism.** In `agent.ts`, after the config merge loop and next to the existing `whitelistedDirs` normalization pass, append `actor: "deny"` for every agent with `mode === "subagent"` — skipping any agent whose ruleset already contains an explicit `actor` rule.

```ts
for (const name in agents) {
  const agent = agents[name]
  if (agent.mode !== "subagent") continue
  if (agent.permission.some((rule) => rule.permission === "actor")) continue
  agent.permission = Permission.merge(agent.permission, Permission.fromConfig({ actor: "deny" }))
}
```

The rule must be **appended last**: `evaluate`/`disabled` use `findLast`, and the ruleset already carries `"*": "allow"` from `defaults`, whose wildcard permission matches the `actor` tool name — a rule merged earlier loses to it. The opt-back-in is therefore not "a later user rule wins" but the skip guard: an explicit `actor` rule in global or per-agent config suppresses the injection entirely. Verified semantics: `disabled(["actor"], merge(defaults, fromConfig({ actor: "deny" })))` → `["actor"]`.

Because the pattern is `"*"`, `Permission.disabled` removes `actor` from the subagent's LLM-visible tool schema (`llm.ts` `resolveTools`), which also makes `ctx.ask({ permission: "actor" })` unreachable for that agent.

**Scope.** All `mode === "subagent"` agents, native and user-defined, including hidden ones. Hidden internals already lack `actor` through `toolAllowlist` (`title`/`summary`/`compaction` have `[]`; `dream`/`distill` enumerate their tools), so the rule is a no-op for them. `mode: "all"` config agents are unaffected and need no rule: `tool/actor.ts`'s spawnable enum only accepts `mode === "subagent"`, so they can never be spawned as subagents.

**checkpoint-writer parity.** `checkpoint-writer` is the one hidden subagent with no `toolAllowlist`, because a fork must mirror the parent's tool schema for prefix-cache alignment. On the fork path its visibility ruleset is `merge(writer.permission, parentPermission)` (`llm.ts` `resolveTools` via `prompt.ts:3896`), and `parentPermission` is merged last, so the parent primary's `"*": "allow"` out-ranks the injected deny under `findLast`. Parity therefore holds, pinned by a test. A cold-start writer (`fork: false`, `checkpoint.ts:888`) is filtered against its own permission and does lose `actor`; harmless, since it never spawns.

**Prompt alignment.** The subagent prompt must not name the capability at all — neither inviting delegation nor explaining that delegation is unavailable. A prompt that says "you have no ability to delegate" still plants the concept and sends the model looking for the tool, and it reads as an explanation aimed at a human reviewer rather than instruction for the model; the correct tone is silence. So `prompt/general.txt` drops the delegation bullet entirely and keeps only a scope statement — "Work outside the delegated scope is not yours to start. Name it in your final report and leave it to the parent." — with the opening line's "Own that task and complete it end to end" carrying the ownership framing. The word `actor` does not appear in the file.

Tests guard only against the old invitation (`"You may delegate"`). The wider "never names the tool" property stays design intent rather than an assertion: it is prose-shaped, hard to express without false positives, and would make any legitimate rewording fail for the wrong reason.

`System.agent` (`session/system.ts:52`) returns `[agent.prompt]` when an agent declares one, so the base prompt's orchestration guidance never reaches `general` and needs no change. The per-turn recall reminder is the other prose surface that names the tool: `recallHintLines` takes a `hasActor` flag and the injection site computes it from the acting agent's own visibility, so a subagent is never pointed at an absent tool.

**Comment budget.** The rationale above lives in this document, not in the source. `agent.ts` keeps three lines at the injection site — enough to stop a future reader "fixing" the merge order — and `recallHintLines` one clause about `hasActor`.

**Docs.** `packages/web/src/content/docs/permissions.mdx` lists `actor` among the available permissions and documents the subagent default plus the opt-back-in snippet.

**Behavior after the change.** Peer/orchestrator sessions (`session` tool, already orchestrator-only), `workflow()`'s internal `spawnRef` spawns, `@agent`-mention spawns (`bypassAgentCheck`), and `checkpoint-writer` forks are all untouched — none of them route through the subagent's `actor` tool schema. A subagent loses `actor`'s non-spawn verbs (`status`/`wait`/`cancel`/`send`/`models`) as an accepted cost of full invisibility.

## [S3] Out of Scope

- No depth counter or ancestry check in `Actor.spawn`; the gate is tool visibility only, so programmatic spawn paths keep working.
- No change to the `session` tool, orchestrator peers, or the workflow runtime's own spawn cap. Subtask commands (`prompt.ts:4681`) and the flag-gated `workflow` tool can still start agents from a subagent.
- Not fixing the pre-existing permission-name split where `registry.ts:340` filters spawnable types with `evaluate("task", ...)` while `actor.ts:696` asks with `permission: "actor"`; `permission.task` is consequently not an opt-back-in.
- No new config key or experimental flag; the existing `agent.<name>.permission.actor` is the opt-back-in.

## Tasks

- [x] T1: Inject `actor: "deny"` for every `mode === "subagent"` agent in `agent.ts` — acceptance: `bun dev debug agent general` reports `"actor": false`, and a config `agent.general.permission.actor: "allow"` restores `true` (covers: S2)
- [x] T2: Drop the delegation bullet from `prompt/general.txt` so the prompt neither invites delegation nor names the tool — acceptance: the file no longer contains "You may delegate" (covers: S2; depends: T1)
- [x] T3: Add regression tests — every `mode === "subagent"` agent has `actor` disabled, a user `actor: "allow"` override re-enables it, and `checkpoint-writer` under a parent primary's `parentPermission` still sees `actor` — acceptance: the new tests pass and the subagent-deny guard fails on `main`'s behavior (covers: S2; depends: T1)
- [x] T4: Verify with `bun typecheck`, `bun lint`, the agent/actor test files, and a live `bun dev debug agent` for `general` + `explore` — acceptance: recorded commands with PASS/PRE-EXISTING status (covers: S2; depends: T1, T2, T3)
- [x] T5: Gate the recall reminder's `actor` hint on the acting agent's tool visibility and document `permission.actor` — acceptance: `recallHintLines(cfg, false)` omits the actor line under test, and the permissions doc lists `actor` with the subagent default (covers: S2; depends: T1)
