# Agent Multi-Skill Coordinated Workflow Orchestration Design

**In one sentence:** Referencing multiple skills = the user specifies multiple SKILLs and a question, a SKILL-Reminder prompts the model to build a multi-SKILL workflow, and finally the tasks are decomposed and persisted to disk to solve the problem.

## 1. Design Motivation

In multi-skill scenarios, the question is no longer "whether to use it" but "how to coordinate."

❌ Traditional trigger problem
The harness has to guess from query semantics which skills to activate, easily missing triggers or firing wrong ones.

✅ Explicit `/skill` resolves it
The user writes `/skill-a /skill-b` directly in the input box — triggering is 100% precise, with no semantic ambiguity.

🎯 The remaining challenge
How multiple skills should be orchestrated: who goes first, how data is passed, how conflicts are resolved.

## 2. Three-Layer Responsibility Split

| Layer | Responsibility | Key Action | Failure Fallback |
|-------|----------------|------------|------------------|
| User Layer | Explicit `/` intent declaration | Type `/skill-a /skill-b` directly in the input box | N/A |
| Harness Layer | Static check + inject Reminder | Parse frontmatter, detect conflict points, produce targeted prompt | Downgrade to a generic template Reminder |
| Model Layer | Produce a structured workflow | Read SKILL.md → judge composition relationship → define contract → persist to disk | Task-Execution drift mitigated by disk persistence |

## 3. Injection Location and Timing

Core decision: The Reminder is a system-injected message appended after the user message (aligned with Anthropic's `long_conversation_reminder` pattern) — it does not rewrite the system prompt.

Why the message layer rather than the system prompt

| Dimension | Modify system prompt | Append after user message (chosen option) |
|-----------|---------------------|-------------------------------------------|
| Instruction-following rate | Far from the query, follow-through is lower | Close to the query, follow-through is markedly higher |
| Prefix-cache hit rate | Pollutes the prefix; any content change breaks the cache | Prefix stays stable; all dynamic content is pushed down to the message layer |
| On-demand injection | Hard to condition on a per-turn basis | Appears only on turns with ≥2 `/skill` references; other turns are entirely unaware |

Conditional trigger rules

Do not inject the Reminder for a single `/skill`.

A single-skill scenario has no orchestration problem; forcing planning purely adds latency and induces over-planning (writing a three-part plan for a trivial task). The trigger condition must be precise:

- `/` count == 0 → do not inject
- `/` count == 1 → do not inject
- `/` count >= 2 → inject Reminder

## 4. Reminder Content Design

The key is to have planning produce something structured and verifiable — not a vague "I'll do A first, then B."

### Reminder Template

```
<skill_composition_reminder>
The user has explicitly referenced multiple skills: {skill_names}.
Before starting work, complete an orchestration plan:
1. Read the SKILL.md of every referenced skill FIRST, then plan
   (never plan from skill descriptions alone — the full SKILL.md
   may contain constraints that invalidate an imagined workflow)
2. Classify the composition relationship: pipeline (A's output →
   B's input) / parallel (each handles a separate part) /
   constraint overlay (one does the work, the other provides
   rules or standards)
3. If pipeline: define the interface contract for intermediate
   artifacts — format and file path
4. If two skills give instructions on the same dimension (output
   format / style / process), explicitly declare a conflict
   resolution rule: which skill takes precedence on which dimension
5. Output a concise workflow (phase → skill used → artifact),
   then execute according to it
Keep planning proportional to task complexity: for simple
combinations, two or three sentences suffice.
</skill_composition_reminder>
```

## 5. Design Trade-off Summary

| Trade-off Point | Choice | Rejected Alternative & Reason |
|-----------------|--------|-------------------------------|
| Trigger mechanism | Explicit `/skill` | Rejected automatic semantic matching — unreliable and prone to over-triggering |
| Reminder injection location | After the user message | Rejected modifying the system prompt — breaks prefix cache, lower follow-through |
| Trigger threshold | `/skill` ≥ 2 | Rejected always-on injection — for single-skill cases it purely adds latency and induces over-planning |
| Reminder content | Constrain output structure | Rejected teaching specific procedures — skill content evolves, hard-coding is unmaintainable |
| Workflow storage | Persist to disk / Task | Rejected keeping it only in the assistant message — long tasks inevitably dilute and lose it |
| Harness enhancement | Static conflict pre-parsing | Rejected letting the model discover conflicts itself — static checks are more reliable at near-zero cost |
