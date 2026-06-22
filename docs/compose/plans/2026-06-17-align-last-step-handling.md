# Align Last-Step Handling With Provider Requirements Implementation Plan

> [!NOTE]
> This document may not reflect the current implementation.
> See the final report for up-to-date state:
> [Final Report](../reports/align-last-step-handling.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop ending the conversation on an assistant message when the agent reaches its step cap, so Bedrock-routed Claude no longer returns a 400 (`This model does not support assistant message prefill`), while restoring the step-cap enforcement that the effectify refactor accidentally gutted.

**Architecture:** At `step >= agent.steps` (`isLastStep`), both LLM send sites in `prompt.ts` currently append `{ role: "assistant", content: MAX_STEPS }` — an assistant prefill that Bedrock rejects. Replace it with a provider-agnostic pattern: deliver the MAX_STEPS instruction on a **user**-role message (conversation ends on a user turn → accepted by all providers) and set `toolChoice: "none"` on the last step so tools are physically disabled (the cap is enforced, not merely requested).

**Tech Stack:** TypeScript, Effect, Bun, the `ai` SDK (`ModelMessage`, `toolChoice`).

---

## Background (verified facts)

- The original feature (upstream PR #4062, `feat: add max steps`) had **three** last-step layers: `system.push(MAX_STEPS)`, `toolChoice: isLastStep ? "none"`, and the assistant prefill.
- The effectify refactor (upstream PR #19483) **dropped** the first two. Today only the assistant prefill remains — so naively deleting it would silently disable step-cap enforcement.
- The provider-agnostic alternative is to never end on an assistant turn for this purpose: deliver the instruction via a prompt-text/user message plus turn-bounding, since models behind providers that don't support prefill reject conversations ending with an assistant turn.
- `toolChoice?: "auto" | "required" | "none"` is valid in both `llm.ts:195` (StreamInput) and `max-mode.ts:61` (max-mode path). `"none"` is accepted.
- Both send sites already have `isLastStep` (computed at `prompt.ts:2573`) in scope.

## File Structure

- Modify: `packages/opencode/src/session/prompt.ts`
  - Main-loop send site (`messages` at `:2720`, `toolChoice` at `:2723`)
  - Fork-loop send site (`messages` at `:2850`, `toolChoice` at `:2853`)
- Test: `packages/opencode/src/session/classify.test.ts` is unrelated; the build of the messages array is inline in `prompt.ts` and not independently exported, so verification is via typecheck + a targeted assertion in a new/existing prompt-level test if one exists. If no prompt-level unit harness exists, verification is typecheck + manual reasoning (documented in Task 3).

No new files. `max-steps.txt` content reused verbatim. No `system.ts` change (the instruction now rides on the last-step user message).

---

### Task 1: Replace prefill with a user-role MAX_STEPS message + restore `toolChoice:"none"` at the main-loop send site

**Covers:** core fix (main loop)

**Files:**
- Modify: `packages/opencode/src/session/prompt.ts:2720` (messages) and `:2723` (toolChoice)

- [ ] **Step 1: Edit the `messages` line (main loop, `:2720`)**

Replace the assistant prefill with a user-role message so the conversation ends on a user turn.

Old:
```ts
                messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : [])],
```

New:
```ts
                messages: [...modelMsgs, ...(isLastStep ? [{ role: "user" as const, content: MAX_STEPS }] : [])],
```

- [ ] **Step 2: Edit the `toolChoice` line (main loop, `:2723`)**

Restore last-step tool disabling. Last-step takes precedence over the `json_schema` "required" form — the step cap is the harder constraint and a closing summary turn must not be forced into a tool call.

Old:
```ts
                toolChoice: format.type === "json_schema" ? "required" : undefined,
```

New:
```ts
                toolChoice: isLastStep ? "none" : format.type === "json_schema" ? "required" : undefined,
```

- [ ] **Step 3: Typecheck**

Run from `packages/opencode`:
```bash
bun typecheck
```
Expected: PASS (no new errors). `"none"` is a valid `toolChoice` literal per `llm.ts:195`.

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/src/session/prompt.ts
git commit -m "fix(session): use user-role MAX_STEPS message + toolChoice none on last step (main loop)

The assistant-prefill MAX_STEPS message made the conversation end on an
assistant turn, which Bedrock-routed Claude rejects (400, no prefill
support). Deliver the instruction on a user turn instead and restore
toolChoice:\"none\" (lost in the effectify refactor) so the step cap is
enforced rather than merely requested."
```

---

### Task 2: Apply the identical fix at the fork-loop send site

**Covers:** core fix (fork / subagent loop)

**Files:**
- Modify: `packages/opencode/src/session/prompt.ts:2850` (messages) and `:2853` (toolChoice)

- [ ] **Step 1: Edit the `messages` line (fork loop, `:2850`)**

Old:
```ts
              messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : [])],
```

New:
```ts
              messages: [...modelMsgs, ...(isLastStep ? [{ role: "user" as const, content: MAX_STEPS }] : [])],
```

- [ ] **Step 2: Edit the `toolChoice` line (fork loop, `:2853`)**

Note this site annotates the literal with `as const`; keep that on the `json_schema` branch.

Old:
```ts
              toolChoice: format.type === "json_schema" ? ("required" as const) : undefined,
```

New:
```ts
              toolChoice: isLastStep ? ("none" as const) : format.type === "json_schema" ? ("required" as const) : undefined,
```

- [ ] **Step 3: Typecheck**

Run from `packages/opencode`:
```bash
bun typecheck
```
Expected: PASS. The fork path's `processArgs` flows into both `handle.process` and `MaxMode.runMaxStep`; `max-mode.ts:61` also types `toolChoice?: "auto" | "required" | "none"`, so `"none"` is accepted on both.

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/src/session/prompt.ts
git commit -m "fix(session): apply user-role MAX_STEPS + toolChoice none on fork last step

Mirror the main-loop fix on the fork/subagent send site so subagents that
hit agent.steps also end on a user turn (Bedrock-safe) with tools disabled."
```

---

### Task 3: Verify the fix end-to-end

**Covers:** verification

**Files:**
- Read-only inspection of `packages/opencode/src/session/prompt.ts`

- [ ] **Step 1: Confirm no assistant-prefill remains**

Run:
```bash
cd /root/projects/.vibe-board-workspaces/41f7-/opencode && grep -n 'role: "assistant" as const, content: MAX_STEPS' packages/opencode/src/session/prompt.ts
```
Expected: no output (zero matches).

- [ ] **Step 2: Confirm both sites now use the user-role form + last-step toolChoice**

Run:
```bash
cd /root/projects/.vibe-board-workspaces/41f7-/opencode && grep -n 'role: "user" as const, content: MAX_STEPS' packages/opencode/src/session/prompt.ts; grep -n 'isLastStep ?' packages/opencode/src/session/prompt.ts | grep -i none
```
Expected: two matches for the user-role messages line; two matches for the `isLastStep ? ... none` toolChoice lines.

- [ ] **Step 3: Final typecheck**

Run from `packages/opencode`:
```bash
bun typecheck
```
Expected: PASS, no new errors.

- [ ] **Step 4: Reasoning check (no behavioral regression)**

Confirm by inspection:
- When `isLastStep` is false, both lines are byte-identical to before except the (false) ternary branch — no behavior change on normal steps.
- When `isLastStep` is true, the appended message is `role:"user"` (conversation ends on user turn) and `toolChoice` is `"none"` (model cannot emit tool calls). This matches the intended provider-agnostic design.

No commit (verification only).
