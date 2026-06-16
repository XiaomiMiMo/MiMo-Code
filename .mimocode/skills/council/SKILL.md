---
name: council
description: >
  Multi-LLM consensus mechanism. Runs multiple models in parallel via actor system,
  collects their judgments, and synthesizes a final verdict. Use for architecture decisions,
  complex debugging, strategy comparison, or when a single model's perspective isn't enough.
  Trigger: "council", "multi-model consensus", "ask multiple models", "vote on approach".
---

# Council Skill

Multi-LLM consensus: run parallel subagents with different models, synthesize verdict.

## When to Use

- Architecture decisions with no clear winner
- Complex debugging where single model may have blind spots
- Strategy comparison ("which approach is better?")
- Code review requiring multiple perspectives
- User explicitly asks for council/consensus

**When NOT to use:**
- Simple tasks one model can handle
- Urgent fixes (council is slower)
- Cost-sensitive situations (runs multiple models)

## How It Works

Council uses MiMo Code's `actor` tool to spawn parallel subagents, each with a different model. Results are collected and synthesized into a final verdict.

## Workflow

### Step 1: Frame the Question

Clearly state what needs deciding. Include:
- The problem context
- Available options (if any)
- Constraints (performance, compatibility, time, etc.)
- What "good" looks like

### Step 2: Spawn Councillors

Use `actor` tool to spawn parallel subagents. Each gets the same question but a different model.

**Recommended model mix** (adjust based on availability):

| Councillor | Model | Role |
|-----------|-------|------|
| Councillor A | mimo-v2.5-pro | Strong reasoning |
| Councillor B | A different model (e.g., deepseek, qwen) | Alternative perspective |
| Councillor C | A third model | Tie-breaker / edge cases |

**Actor spawn pattern:**

```
actor({
  operation: {
    action: "run",
    subagent_type: "general",
    description: "Council: model-A perspective",
    prompt: "<the question with full context>",
    model: "mimo-v2.5-pro"
  }
})
```

```
actor({
  operation: {
    action: "run",
    subagent_type: "general",
    description: "Council: model-B perspective",
    prompt: "<the question with full context>",
    model: "<different-model>"
  }
})
```

Spawn all councillors in parallel (single message with multiple actor calls).

### Step 3: Collect Results

Use `actor({ operation: { action: "wait", actor_id: "<id>" } })` to collect each result.

### Step 4: Synthesize Verdict

As the orchestrator, analyze all councillor responses:

1. **Find agreements** — where models converge, confidence is high
2. **Find disagreements** — where they diverge, examine reasoning
3. **Weigh perspectives** — consider each model's strength relative to the question
4. **Produce verdict** — clear recommendation with reasoning

**Synthesis format:**

```markdown
## Council Verdict

### Question
<restated question>

### Models Consulted
- Councillor A (<model>): <one-line position>
- Councillor B (<model>): <one-line position>
- Councillor C (<model>): <one-line position>

### Areas of Agreement
- <what all models agree on>

### Areas of Disagreement
- <point of divergence and why>

### Verdict
<clear recommendation with reasoning>

### Confidence
High / Medium / Low (based on model agreement level)
```

### Step 5: Optional Follow-up

If disagreement is significant and the stakes are high:
- Ask follow-up questions to specific councillors
- Request they address the other models' counterarguments
- Re-synthesize with the new information

## Example

**User asks:** "Should we use REST or gRPC for the internal service communication?"

**Council spawns:**
1. Councillor A (mimo-v2.5-pro) — strong on architecture
2. Councillor B (deepseek model) — strong on practical implementation
3. Councillor C (qwen model) — strong on ecosystem analysis

**Synthesis:**
- All agree: gRPC better for internal high-throughput
- Disagree on: migration complexity assessment
- Verdict: gRPC for new services, REST gateway for external, phased migration

## Tips

- Keep councillor prompts identical for fair comparison
- Include full context in each prompt (councillors don't share context)
- For binary decisions (A vs B), 3 councillors is ideal
- For open-ended exploration, 2 councillors often sufficient
- Budget consideration: each councillor = separate model invocation cost
