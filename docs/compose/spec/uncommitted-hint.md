---
feature: uncommitted-hint
status: delivered
updated: 2026-09-18
branch: wt/stop-hook-soft-hint
commits: 2bda17944b..ff7dbd8d2f
---

# Uncommitted Hint

Turn-end soft reminder for uncommitted git changes. **Engine product feature.**
Desktop (or any host) only writes `experimental.uncommitted_hint.enabled` into
engine config; it does not implement inject policy.

## Report

**What was built** — Engine `experimental.uncommitted_hint` (default **off**):
after a completed **user-source main** turn, if the session workspace git tree
is dirty, inject a synthetic soft reminder (porcelain + **gitignore-first**
guidance). **No session-once hard cap**: later dirty user turns may re-hint.
Hook/spawn/undefined never inject (fail-closed anti-loop). Clean tree stops
injection; cancel/delete invalidates pending inject; WARN decision logs.

**Verification** — Review-loop design baseline `UH-DESIGN-R2`. CODE phase
Round 6 **CR-PASS** on snapshots engine `ff7dbd8d2f` / desktop pin
`ff7dbd8d2f` (`fa55d9e32`). Ledger UH-D01–D03 and UH-C01–C08 all closed
(`VERIFIED_FIXED`); no open findings. Engine typecheck PASS;
`test/session/uncommitted-hint.test.ts` **34 pass / 0 fail**. Desktop unit
uncommitted-hint (8) + host e2e receipt `/tmp/mimo-uh-e2e.log` **3 passed**
(engine `bc789a4bfb`); later C03 test-only + C08 in-memory dispose-guard
increments do not change host UI/IPC/product semantics and were verified by
focused unit/typecheck (not claimed as a fresh e2e re-run on this pin). Do
not treat historical session-once CR as approval of this re-hint revision.


## [S1] Problem

Agents finish a turn with a dirty workspace and never commit. Users keep
driving the next turn on uncommitted work. The engine must remind the model at
**user-turn end** without becoming a hard commit gate and without re-entering
on its own hook follow-up.

Hosts that only flip a lab/config switch must not own git policy, inject
identity, or anti-loop rules — those belong in the engine.

## [S2] Design

### Contracts

1. **Config gate (engine schema)**  
   `experimental.uncommitted_hint.enabled`  
   - Effective on only when `enabled === true`.  
   - Missing key / non-true / **malformed live JSON** → off (no git probe required; malformed live must not revive cached on).  
   - Live `MIMOCODE_CONFIG_CONTENT` with an explicit key (including `false`) wins for `enabled`.  
   - Live env present, JSON valid, key absent → cached/file config still applies.  
   - Hosts (Desktop Lab) always write explicit `true`/`false`, never delete the key.  
   - **No** `max_consecutive`. **No** session-once hard cap.

2. **When inject is allowed** (every completed **main** turn, `firePostSession`):

   | Condition | Decision |
   |-----------|----------|
   | `enabled !== true` | skip · `disabled` |
   | `outcome !== completed` | skip · `bad_outcome` |
   | `agentID !== "main"` | skip · `not_main` |
   | `turnSource !== "user"` (hook / spawn / undefined) | skip · `non_user_source` (fail-closed anti-loop) |
   | no session directory | skip · `no_directory` |
   | not a git repo | skip · `not_repo` |
   | porcelain empty | skip · `clean` |
   | otherwise | **inject · `dirty`** |

   **Re-hint policy:** later **user** turns that still see a dirty tree inject
   again. Learning to commit cleans the tree → `clean` stops injection. A later
   dirty user turn may inject again. Hook/spawn/undefined never inject, even if
   dirty — that is the only hard anti-loop rule.

3. **Inject identity**  
   - Synthetic user message on the same session.  
   - Follow-up reminder turn runs `runLoop(..., "hook")`.  
   - Body = `UNCOMMITTED_HINT_PROMPT` + `git status --porcelain` (keep leading XY).  
   - Prompt guides **.gitignore first**, then stage + descriptive commit; does
     **not** force commit; forbids committing secrets / ignored paths.  
   - Inherit triggering turn `agent` / `model` / `model.variant` (not a top-level `variant`).  
   - Missing `finalAsst.agent` → do not inject (no defaultAgent fallback).

4. **Git probe**  
   `git status --porcelain` in the session directory, **2s** timeout
   (`UNCOMMITTED_HINT_GIT_TIMEOUT_MS`). Hung/failed probe → fail-closed (no inject).
   Post-delay reprobe clean → skip · `cleaned` + diagnostic counter reset.

5. **Lifecycle / cancel**  
   - Delayed follow-up (~400ms) + claim via `state.start`.  
   - Diagnostic `recordHintOutcome` books at inject fact; does **not** gate re-hint.  
   - `openMainHintToken` cancels any prior main token before replace; records session workspace directory.  
   - `cancelPendingHints` is session-wide (current token + all pending handles).  
   - Late aborts log `cancelled` / `disabled_after_delay` / `cleaned`.  
   - Session delete: `clearAllHintStateForSession` — cancel token, clear pending
     handles, reset count, **and drop the directory-index row**.  
   - Instance dispose: `beginHintStateDisposeForDirectory` + finisher — cancel
     only tokens captured at begin; orphan directory-index rows are removed only
     when no replacement main token exists for that session.  
   - Only main user-turn runLoop opens the main hint token.

6. **Decision logs**  
   WARN-level structured fields: `decision`, `reason`, `enabled`, `turnSource`,
   `dirty` under service `session.prompt` + marker `uncommitted-hint`.

7. **Host surface (out of engine policy)**  
   Desktop Lab / TUI / any host: toggle only maps to engine config key.
   Synthetic parts do not enter host chat bubbles (host-side parse concern).
   **Internal automation** calling `prompt()` must pass explicit `source:"hook"`
   or `"spawn"` **and**, when parts include non-text (attachments), machine
   `provenance` (e.g. `{ machine: "mimocode-github" }`) so the entry gate allows
   the request. Hosts omitting source are trusted as user-facing.

### Module boundary

| Area | Location | Role |
|------|----------|------|
| Pure logic | `packages/opencode/src/session/prompt/uncommitted-hint.ts` | config resolve, `decideUncommittedHint`, hint text, counters, pending tokens |
| Inject orchestration | `packages/opencode/src/session/prompt.ts` | `PromptInput.source` → `runLoop(turnSource)` → `firePostSession` |
| Config schema | `packages/opencode/src/config/config.ts` | `experimental.uncommitted_hint` enabled-only |
| Tests | `test/session/uncommitted-hint.test.ts`, `test/session/prompt-effect.test.ts` | decide + live inject/anti-loop |

### Observable acceptance

- Config off / missing → no inject; log `skip · disabled`.
- Config on + user + dirty → synthetic hint with porcelain + gitignore guidance.
- Config on + user + dirty again later in same session → **another** hint.
- Config on + clean / non-git → `skip · clean` / `skip · not_repo`.
- Hook / undefined / spawn completed turn → never inject.
- Cancel during pending/hook follow-up → no late inject; later dirty user turn may re-hint.
- Decision logs at WARN on host default sinks.

## [S3] Out of Scope

- Desktop Lab UI, e2e, engine-pin bump (desktop repo — config host only).
- Auto commit/push; forcing the model to commit.
- Cloud / feature-gates.
- Builtin `session.stopping` plugin extraction (separate compose feature
  `uncommitted-hint-builtin-stop-hook`, not delivered here).
- Host bubble filtering of synthetic parts.

## Tasks

- [x] T1: Engine config schema enabled-only + live resolve — acceptance: unit resolve/default-off/explicit-false (covers: S2)
- [x] T2: decide + hint body (gitignore-first) + re-hint while dirty — acceptance: unit decide matrix + prompt markers (covers: S2)
- [x] T3: firePostSession inject + turnSource fail-closed + cancel/delete lifecycle — acceptance: prompt-effect uncommitted-hint cases green (covers: S2)
- [x] T4: WARN decision logs — acceptance: integration log sink case green (covers: S2)
- [x] T5: Engine compose spec is source of truth; desktop docs config-only + pointer — acceptance: no desktop doc claims session-once product rule (covers: S2)
- [x] T6: Independent review-loop CODE-phase CR-PASS on re-hint revision — acceptance: reviewer CR-PASS on current snapshot; all findings closed (covers: S2)
