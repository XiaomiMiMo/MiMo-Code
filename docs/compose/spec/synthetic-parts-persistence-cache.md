---
feature: synthetic-parts-persistence-cache
status: delivered
updated: 2026-09-16
branch: analyze/recall-unpersisted-push-cache
commits: e93a49cd97954df8cedbeff71d5f7230f6f8cc1d..HEAD
---

# Synthetic Parts Unpersistence and Prompt-Cache Break

Analysis only — no production code change on this branch. Fix strategy intentionally open (user: 看完分析再选).

## Report

**What was built** — A durable analysis of unpersisted synthetic `parts.push` sites in `session/prompt.ts` `runLoop` and how they break provider prompt-cache reuse. Inventory covers recall reminder (`3840-3874`), loop-streak nudge (`4026-4065`), compose `unshift` (`1186-1199`), and mid-turn `p.text` wrap (`4353-4368`). Mechanism: every step reloads `msgs` from DB; unpersisted pushes vanish and reappear with new PartIDs **after** later `insertReminders` parts, flipping last-user tail order between step 1 and step 2. Secondary effects: checkpoint-writer `ForkContext` is captured from DB-clean history → parent/fork prefix parity loss; trajectory includes parts the DB never stored.

**Verification** — Static analysis on worktree `analyze/recall-unpersisted-push-cache` @ `origin/main` `e93a49cd`. Code anchors re-read in full (recall, loop-streak, insertReminders, updatePart, hasMemoryOrTasks, toModelMessages, trajectory, checkpoint prefix capture). No runtime test suite for this analysis-only branch; implementation tasks remain unchecked by design.

**Journey log**

1. User screenshot line numbers `3840-3876` match **origin/main**, not the stale main checkout (main was 64 behind; analysis redone on worktree from `e93a49cd`).
2. `parts.push` without `updatePart` is the incomplete half of the user-side reminder contract — persistence + dedupe is the other half (auto-worktree / skills already do both).
3. Cache break is primarily **order instability vs persisted insertReminders siblings**, plus **fork prefix DB reload** — not “synthetic body changing every step” (recall body is stable).
4. Mid-turn `p.text` wrap is a second unpersisted mutator: step1 vs step2 user text differ by design after the first finished assistant; any fix plan must treat it separately from recall.
5. Fix strategy left open per user; Option A (persist + marker dedupe) is the default recommendation because it is already the repo’s own pattern.

## [S1] Problem

`packages/opencode/src/session/prompt.ts` `runLoop` reloads history every step:

```ts
while (true) {
  let msgs = yield* MessageV2.filterCompactedEffect(sessionID, { ... })
  // ... inject synthetic content into msgs ...
  msgs = yield* insertReminders({ messages: msgs, agent, model, session })
  // ... serialize msgs into the LLM request ...
}
```

Several synthetic injections `parts.push(...)` (or `unshift`, or in-place `p.text = ...`)
**without** `sessions.updatePart(...)`. The injected bytes therefore:

1. Exist only in this step's in-memory `msgs`.
2. Vanish on the next step when history is reloaded from the DB.
3. Reappear with a **new `PartID`** at a possibly **different index** among other parts.

Provider prompt caches key on the **serialized request prefix** (system + tools +
message content up to a point). Within one agent-loop turn, the prefix is supposed
to be byte-stable across steps so tool-call steps reuse cache. Unpersisted, re-pushed
synthetic parts make that user-message tail **order-unstable** and can flip content
between step N and step N+1 — the classic mid-turn cache miss.

This is **not** the same class as system-prompt drift (host clock, etc.). Previous
investigation (`MEMORY-engine-prefix-internals.md`) already closed: within ONE turn
the assembled **system** prefix is byte-stable; the remaining within-turn miss source
must be looked for in **message parts**. This document names those sites.

User-visible framing from the screenshot analysis (now confirmed on `origin/main`):

- Trigger: `hasMemoryOrTasks(sessionID)` after any session memory dir entry or task row.
- Then every LLM request re-attaches a ~120-token recall `<system-reminder>` via bare push.
- Trajectory/DB/history consumers that do not filter `synthetic` see boilerplate glued
  inside the user turn.

## [S2] Design (mechanism)

### Request pipeline relative to injection

```
filterCompactedEffect(DB)          ← clean of unpersisted parts
        │
        ▼
lastUserMsgForRecall.parts.push    ← UNPERSISTED (recall)          ~3846-3874
lastUserMsg.parts.push             ← UNPERSISTED (loop-streak)      ~4043-4065
fireCheckpoints / rebuild          ← reloads DB again (clean)
crop spanPart                      ← updatePart + push  (persisted)
insertReminders                    ← updatePart + push  (persisted, with markers)
step>1 mid-turn wrap               ← mutates p.text in memory only  ~4353-4368
plugin transform                   ← may mutate msgs
        │
        ▼
MessageV2.toModelMessagesEffect → LLM request
```

`toModelMessagesEffect` (`message-v2.ts:862-871`) includes **every non-ignored**
user text part, synthetic or not. Desktop UI may hide `synthetic`; the model does not.
Trajectory (`trajectory.ts:81-86`) also serializes all parts for replay fidelity.

### Why unpersisted push breaks prefix cache

**Order flip vs persisted siblings (primary mid-turn break).**

| Step | Last-user parts after injection pipeline |
|------|------------------------------------------|
| 1 | `[db…, recall, loop-streak?, insertReminders…]` |
| 2 reload | `[db…, insertReminders…]` (persisted parts stay) |
| 2 after re-push | `[db…, insertReminders…, recall, loop-streak?]` |

Step 1 places recall **before** `insertReminders` parts; step 2 places it **after**.
Any cached prefix that covered through step-1's user message is invalid on step 2.

When `insertReminders` contributes nothing on step 2 (skills already loaded, plan
already injected), content may accidentally match — cache holds — which makes the
bug **intermittent** and easy to mis-blame on the provider or `prompt_cache_key`.

**New PartID each step.** Harmless if the provider hashes content only; still
corrupts any consumer that assumed part identity is stable (logs, trajectory diffs,
UI keying).

**Fork / checkpoint-writer prefix parity.**

`tryStartCheckpointWriter` (`checkpoint.ts:698-702`) rebuilds `msgs` from
`filterCompactedEffect` — **without** unpersisted parts — then freezes
`ForkContext.inheritedMessages` via `buildLLMRequestPrefix`. The parent runLoop
request at the same watermark **did** include recall (pushed earlier in the same
iteration, and again on every subsequent step). Parent prefix ≠ fork prefix →
checkpoint-writer pays full prefix cost whenever session memory/tasks exist.

**DB / trajectory / rebuild divergence.**

| Consumer | Sees unpersisted recall? |
|----------|---------------------------|
| LLM request (this step) | yes |
| SQLite parts table / history reload | no |
| `serializeTrajectoryMessages` / plugin `session.llm.request` | yes (in-memory) |
| Checkpoint-writer fork capture | no (DB reload) |
| Desktop UI (`synthetic` filter) | hidden |
| Flat BM25/embedding over trajectory text | yes — boilerplate noise |

**Token cost without cache amortization.** ~120 tokens/request when
`hasMemoryOrTasks`; if cache misses every step, cost is ~120 × steps **plus** full
re-read of the uncached prefix, not 120 once.

### What “persistence” means in this codebase

`sessions.updatePart` (`session.ts:631-641`) fires `MessageV2.Event.PartUpdated`
via `SyncEvent` → durable write + event bus. Established harness contract for
user-side reminders (auto-worktree comment at `prompt.ts:1202-1207`):

> Injected as a user-side system-reminder and **persisted** via
> `auto_worktree_hint_sent` so compaction/rebuild cannot re-inject.

`insertReminders` itself documents (`prompt.ts:1370-1371`):

> insertReminders runs every step and **updatePart persists**, so
> injecting past step 1 would stack duplicate reminders.

So the intended pattern for multi-step user-side synthetic content is:

1. `updatePart` (durable identity + content)
2. Marker / content dedupe so re-entry does not stack
3. Push the **returned** part onto the in-memory message for this request

Unpersisted bare push violates (1) and usually (2).

### Per-site cache impact

| Site | Location (origin/main) | Persist? | Dedupe | Multi-step? | Cache impact |
|------|------------------------|----------|--------|-------------|--------------|
| **Recall reminder** | `prompt.ts:3846-3874` | no | none | every step while `hasMemoryOrTasks` | **High** — order flip + every request + fork parity |
| **Loop-streak nudge** | `prompt.ts:4026-4065` | no | in-memory text check only | every step while streak holds | **High when triggered** — DB has no copy so check never sees prior inject |
| **Compose mode prompt** | `prompt.ts:1186-1199` `parts.unshift` | no | none | every `insertReminders` call on compose agent | **Medium** — always head of compose user msg; content usually stable so order flip needs another sibling |
| **Mid-turn user wrap** | `prompt.ts:4353-4368` `p.text =` | no | `step > 1` | every step ≥2 after lastFinished | **Medium-High** — rewrites **visible** user text in the request; step1 vs step2 content differs by design |
| Crop span | `prompt.ts:~4274` | yes | crop metadata | as needed | OK (request-layer crop + marker) |
| insertReminders skills/plan/auto-worktree | `prompt.ts:1202+` | yes | markers / loaded set | every step, deduped | OK |
| Output-length / structured / text-loop recovery | new user + `updatePart` | yes | counters | once per recovery | OK — new message id is an intentional prefix change |

### Out of scope for the cache argument (not bugs by themselves)

- `message-v2.ts` `parts.push` inside `toModelMessagesEffect` — request assembly, not session state.
- `codex-import` / `claude-import` / TUI draft pushes — import/UI builders, then persisted on save.
- Skill-catalog suppression in `toModelMessages` — suppresses **old persisted** catalogs; different feature.
- System-prompt host clock / L2 plugin notes — closed host-side cache work; different layer.

## [S3] Out of Scope

- Implementing a fix (user deferred strategy choice).
- Desktop-host prompt assembly (`pluginNote`, attachment notes in L2 `system`).
- `prompt_cache_key` routing / gateway affinity (config-level; separate stream).
- Changing `serializeTrajectoryMessages` to filter synthetic (would reduce replay fidelity).
- Auto-worktree / skill-body reminder behavior beyond their persistence pattern as the **reference**.

## [S4] Inventory — all unpersisted (or request-only) mutations in `session/prompt.ts`

1. **Recall reminder** — `lastUserMsgForRecall.parts.push({ ..., synthetic: true, text: recallProtocol })`  
   Gate: `checkpoint.hasMemoryOrTasks(sessionID)`.  
   No marker. Comment says “per-user-message”; code runs **per loop step**.

2. **Loop-streak nudge** — `lastUserMsg.parts.push({ ..., synthetic: true, text: streakNudge })`  
   Gate: last `REPEATED_STEP_THRESHOLD` finished steps share `stepSignature`.  
   Dedupe looks at `lastUserMsg.parts` which DB never wrote → always misses after reload.

3. **Compose mode** — `composeModeMsg.parts.unshift({ ..., synthetic: true, text: PROMPT_COMPOSE })`  
   Every `insertReminders` when any compose user message exists.

4. **Mid-turn nudge wrap** — for user messages after `lastFinished`, non-synthetic text is rewritten to wrap in `<system-reminder>The user sent the following message…`.  
   Intentional request-time steering; still an unpersisted content change across steps (step1 unwrapped, step2+ wrapped). Combined with (1)–(3) amplifies tail instability.

5. **Plugin transform** — `experimental.chat.messages.transform` may mutate `msgs`; plugin contract, not fixed here.

Reference persisted patterns (contrast):

- Auto-worktree: `updatePart` + session flag + marker scan.
- Skill bodies: `updatePart` + `skill_content name=` marker into `loaded`.
- Plan mode: `updatePart` + “only on fresh user turn” gate because persist+every-step would stack.
- Recovery users: **new** `updateMessage` + `updatePart` (cache change is the point).

## [S5] Judgements (from user screenshots, refined)

| Question | Judgement |
|----------|-----------|
| Is it inserted into the middle of the user utterance? | No — tail (or head for compose) **synthetic** part; user original text is not split. |
| Should this live in system? | **Policy** already in system (`# Memory system` / search-first). **Path recall** deliberately in user tail to survive rebuild and stay near memory dir. Putting dynamic path in system is a known prefix-cache hazard (auto-worktree migration: “别碰 system”). |
| Is bare push a “wrong position” bug? | Design chose user-side channel; **implementation** skipped the persistence half of that channel’s contract. |
| Side effects for “轨迹命中” | Real: every-step re-attach (~120 tokens), order flip mid-turn, fork prefix parity loss, trajectory BM25 noise, DB/request divergence. |
| Relation to system-memory MR | Separate chain: system block is always-on policy; this is the **engine recall path** (`hasMemoryOrTasks`) that becomes visible once memory/tasks exist — e.g. after `task create` or notes.md. |

## [S6] Fix strategy options (not chosen)

Ranked by fit to the existing harness contract. User deferred selection.

### Option A — Persist + marker dedupe (recommended default if fixing later)

For each user-side reminder that should be durable:

```ts
const marker = "This session has memory at"
if (!lastUser.parts.some(p => p.type === "text" && p.synthetic && p.text?.includes(marker))) {
  const part = yield* sessions.updatePart({ id: PartID.ascending(), ... synthetic: true, text: ... })
  lastUser.parts.push(part)
}
```

- Matches auto-worktree / skill-body pattern.
- Step 2 reload finds the part → no re-push → **order stable** → cache holds.
- Loop-streak: persist once when streak first detected; marker prevents re-stack.
- Compose: either persist once per compose user message, or move to system tail for compose only (compose is a dedicated agent; system tail is already dirty for that path by design of PROMPT_COMPOSE).
- Mid-turn wrap: leave as request-only **or** stop wrapping on every step≥2 if cache evidence shows it is the dominant miss (it changes user text every turn after first tool step by design — may be intentional steering worth keeping despite cache cost).

**Tradeoff:** DB history retains synthetic parts (UI already filters `synthetic`; trajectory already includes them today from in-memory pushes). Compaction/rebuild must not re-inject (markers handle this).

### Option B — Request-scope only, inject once per step into a **stable slot**

Do not persist; inject **after** `insertReminders` and all other part mutations, always as the last synthetic tail, with a deterministic body (no new id in the serialized text — provider usually ignores part ids).

- Avoids order flip vs insertReminders.
- Still: every request carries the part (by design); fork capture from DB still **lacks** it → checkpoint-writer cache parity remains broken.
- Trajectory still diverges from DB.

### Option C — Move recall protocol to system tail / memory instructions

- Static protocol already partly in system (`memory-prompt-decouple.md`: search-first stays on).
- Dynamic `sessMemDir` in system is a **prefix-cache landmine** if anything about it changes; path is session-stable though (`memory/sessions/<sessionID>`).
- User previously rejected system for dynamic notices (“别碰 system” for auto-worktree).

### Option D — Drop per-step recall entirely; rely on system + tool descriptions + rebuild dump

- Cheapest cache-wise.
- Loses the “keep reflex warm across many post-rebuild turns” intent of the ~120-token nudge.
- Checkpoint rebuild already injects memory paths in rebuild context when checkpoint exists.

## Tasks

No implementation tasks until strategy is chosen. If/when fixing:

- [ ] T1: Decide strategy A/B/C/D for recall + loop-streak + compose — acceptance: written decision in this doc (covers: S6)
- [ ] T2: Align unpersisted sites to the chosen contract — acceptance: step≥2 last-user parts order matches step1 modulo new assistant/tool history; no duplicate markers (covers: S2, S4; depends: T1)
- [ ] T3: Regression test — acceptance: multi-step runLoop mock shows recall/loop-streak `updatePart` once; second build does not stack; order after insertReminders stable (covers: S2; depends: T2)
- [ ] T4: Fork prefix parity check — acceptance: checkpoint-writer `ForkContext.inheritedMessages` equals parent request messages at watermark for synthetic user tails, or documented intentional divergence (covers: S2; depends: T2)

## Anchors (origin/main `e93a49cd`)

| Symbol | File:line |
|--------|-----------|
| `while (true)` reload | `packages/opencode/src/session/prompt.ts:3787-3809` |
| Recall push | `prompt.ts:3840-3874` |
| Loop-streak push | `prompt.ts:4026-4065` |
| `fireCheckpoints` (DB reload inside checkpoint) | `prompt.ts:4084-4094` |
| `insertReminders` call | `prompt.ts:4294` |
| Compose unshift | `prompt.ts:1186-1199` |
| Persisted reminder examples | `prompt.ts:1202-1261`, `1367-1392` |
| Mid-turn `p.text` wrap | `prompt.ts:4353-4368` |
| `updatePart` | `packages/opencode/src/session/session.ts:631-641` |
| `hasMemoryOrTasks` | `packages/opencode/src/session/checkpoint.ts:1202-1210` |
| `toModelMessages` synthetic inclusion | `packages/opencode/src/session/message-v2.ts:862-871` |
| Trajectory all-parts | `packages/opencode/src/session/trajectory.ts:81-86` |
| Checkpoint DB reload + prefix capture | `packages/opencode/src/session/checkpoint.ts:698-702`, `859-897` |
| Prefix build | `packages/opencode/src/session/llm-request-prefix.ts:35-107` |
| Recall hints | `prompt.ts` `recallHintLines` (exported; tests `test/session/recall-reminder.test.ts`) |

## Journey log

1. User screenshot line numbers `3840-3876` match **origin/main**, not the stale main checkout (main was 64 behind; analysis redone on worktree from `e93a49cd`).
2. `parts.push` without `updatePart` is incomplete half of the user-side reminder contract — persistence + dedupe is the other half (auto-worktree / skills already do both).
3. Cache break is primarily **order instability vs persisted insertReminders siblings**, plus **fork prefix DB reload** — not “synthetic content changing every step” (body is stable for recall).
4. Mid-turn `p.text` wrap is a second unpersisted mutator: step1 vs step2 user text differ by design after the first finished assistant; any fix plan must treat it separately from recall.
5. Fix strategy left open per user; Option A is the default recommendation because it is already the repo’s own pattern.
