---
name: compose:ask
description: "Use whenever you need a decision, clarification, or approval from the user — covers how to ask with the question tool, and how to resolve the decision yourself when no user is available (question tool absent, or a [Never-Ask] response)"
---

# Asking the User

## The Rule

Every time you need the user to decide, clarify, or approve something, route it through the `question` tool. **Never** stop the loop with a natural-language question ("Does this look right?", "Should I proceed?", "Which would you prefer?"). A natural-language question ends your turn without finishing the task; a `question` tool call does not.

This means: **the loop only ends when the task is actually complete** — never because you paused to ask in prose.

## How to Ask

- **Structured options** — when the decision has known choices, list them as `options` (each with a short `label` and a `description`).
- **Open-ended** — when you can't enumerate good options, pass **empty `options`**. An empty options list renders as a free-text prompt: the user types whatever they want. So anything you'd normally ask in prose can be asked through `question` instead.
- **One question per concern** — don't bundle unrelated decisions; ask them as separate questions (or separate calls).
- **Don't repeat the question in prose** — the tool already renders it. Just call the tool.

```
question({
  questions: [{
    question: "Which auth strategy should I use?",
    header: "Auth",
    options: [
      { label: "Session cookies", description: "Server-side sessions, simplest" },
      { label: "JWT", description: "Stateless, good for multiple services" },
    ],
  }],
})
```

## When No User Is Available

There are two situations where you won't get a human answer. **The decision behavior is identical in both** — you pick the best option for unattended/headless execution yourself and keep going. They differ only in *whether the question tool is reached this turn*:

1. **Question tool absent** (e.g. `run`/eval, where `question` is denied) — the tool isn't in your list. You never call it; decide and proceed directly.
2. **`[Never-Ask]` response** (never-ask is on) — you *do* call `question`, but instead of a user answer the tool returns a `[Never-Ask]` directive. Re-pick from the options you proposed, **explicitly state your choice and reasoning in your response text**, and continue.

### How to decide autonomously

The best option for a human is often **not** the best option for headless execution. Re-evaluate your own options through this lens:

- Prefer **text-only** over visual/interactive paths (e.g. don't launch a GUI companion, don't open a browser — produce the same content as text).
- Prefer **non-interactive** over anything needing the user present.
- Prefer the **minimal-scope** path — don't expand the work to cover speculative edge cases just because no one is gating it.
- When approval is the only thing being requested, treat it as **granted** and proceed to implementation.
- **Exception — destructive, irreversible actions** (deleting a branch/commits, dropping data, force-pushing) never auto-approve. When you can't get explicit confirmation, choose the non-destructive path (keep things as-is) and continue with the rest of the task.

### Only this turn — keep asking later

Autonomous resolution applies **only to the current question**. Do **not** infer "I should stop using the question tool from now on." never-ask can be turned off at any moment, and the question tool may reappear — at the next decision point, ask normally again. The user may have returned.

## Why this skill exists

This is the single source of truth for asking and autonomous fallback. Other compose skills reference it at their decision points instead of repeating fallback text, so the rules stay consistent and the prompts stay small.
