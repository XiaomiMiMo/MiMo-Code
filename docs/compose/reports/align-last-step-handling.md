---
feature: align-last-step-handling
status: delivered
specs: []
plans:
  - docs/compose/plans/2026-06-17-align-last-step-handling.md
branch: 41f7-
commits: e9fa96ac83..5fd4316a5e
---

# Align Last-Step Handling With Provider Requirements — Final Report

## What Was Built

When an agent reaches its configured step cap (`agent.steps`), the session loop sends one final "wrap up and summarize" request to the model. That final request is now constructed so it ends on a **user** turn with tools disabled, instead of ending on a pre-filled **assistant** turn.

This fixes a hard failure on Bedrock-routed Claude, which rejects any conversation that ends on an assistant message (`400 — This model does not support assistant message prefill. The conversation must end with a user message.`). It also restores step-cap enforcement that had silently regressed: the model can no longer emit tool calls on the final step, so `agent.steps` is an actual hard stop rather than a suggestion.

## Architecture

The change lives entirely in `packages/opencode/src/session/prompt.ts`, at the two sites that build the per-step LLM request inside the run loop:

- **Main-loop send site** (~line 2720/2723)
- **Fork/subagent send site** (~line 2850/2853)

`isLastStep` is computed once per iteration at `prompt.ts:2573` (`step >= (agent.steps ?? Infinity)`) and is in scope at both sites.

At each site, when `isLastStep` is true:

- **Messages** — a message carrying the `MAX_STEPS` instruction (from `src/session/prompt/max-steps.txt`) is appended with `role: "user"`, so `messages` ends on a user turn. Previously this was `role: "assistant"` (a prefill).
- **toolChoice** — set to `"none"`, physically preventing tool calls on the final turn. On non-last steps the prior behavior is unchanged (`"required"` for `json_schema` format, otherwise `undefined`). Last-step `"none"` takes precedence over the `json_schema` `"required"` branch.

`toolChoice: "none"` is a valid value on both code paths: `StreamInput` (`src/session/llm.ts:195`) and the max-mode step (`src/session/max-mode.ts:61`) both type it as `"auto" | "required" | "none"`. Setting `toolChoice` does not alter the tools schema, so the cached request prefix (system prompt + tool definitions) is unaffected.

### Design Decisions

- **User message, not provider detection.** We deliver `MAX_STEPS` on a user-role message rather than branching on provider capability (e.g. a `supportsPrefill` flag). The user-role form is valid on every provider including Anthropic-direct, so per-provider branching would be dead complexity.
- **Provider-agnostic by ending on a user turn.** Rather than using assistant prefill to force a final turn, the instruction rides on a prompt-text/user message with turn bounding. Conversations that end on an assistant turn are rejected by providers that don't support prefill (e.g. Bedrock-routed Claude), so ending on a user turn is the portable choice.
- **Restored `toolChoice: "none"` deliberately.** The original max-steps feature (upstream PR #4062) disabled tools on the last step; the effectify refactor (upstream PR #19483) dropped it, leaving the assistant prefill as the only last-step control. Removing the prefill alone would have made the step cap a no-op, so tool disabling was restored alongside.

## Usage

No user-facing API or config change. Behavior triggers automatically when an agent with a finite `steps` value (e.g. fork subagents at `maxTurns`/`steps` limits) reaches its cap. On that final step the model receives the `max-steps.txt` instruction (announce limit reached, summarize work done, list remaining tasks, recommend next steps) and cannot call tools.

## Verification

- `bun typecheck` (from `packages/opencode`) — exits 0 after both edits.
- Grep assertions: zero `role: "assistant" ... MAX_STEPS` matches; two `role: "user" ... MAX_STEPS` matches; two `isLastStep ? "none"` toolChoice lines.
- Test suites `test/session/prompt.test.ts`, `prompt-sweep.test.ts`, `max-mode.test.ts`, `test/agent/agent.test.ts` — 62 pass, 1 fail. The single failure (`general agent denies todo tools`) is **pre-existing and unrelated**: confirmed by reproducing it on the pre-change `prompt.ts` (it fails identically without this change).
- Reasoning: on non-last steps both edited lines reduce to the prior behavior (the `isLastStep` ternary takes its false branch), so normal turns are byte-for-byte unchanged.

## Journey Log

> Brief notes on what informed the final design. Not required reading.

- [lesson] The 400 was not a fork bug — the assistant-prefill last-step pattern is upstream-native (PR #4062). This fork only widened its reach by copying it into the fork/subagent loop.
- [lesson] The effectify refactor (PR #19483) silently dropped two of three original last-step controls (`system.push(MAX_STEPS)` and `toolChoice: "none"`), leaving only the prefill — so a naive "just delete the prefill" fix would have quietly disabled step-cap enforcement.
- [pivot] The robust pattern is to avoid assistant-final turns entirely for non-prefill providers. That confirmed the user-message + tool-disable approach over any provider-detection scheme.

## Source Materials

| File | Role | Notes |
|------|------|-------|
| `docs/compose/plans/2026-06-17-align-last-step-handling.md` | Implementation plan | Complete (3 tasks) |
