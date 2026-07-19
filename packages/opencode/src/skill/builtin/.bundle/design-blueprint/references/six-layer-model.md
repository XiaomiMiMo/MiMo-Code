# The Six-Layer Harness Model

Reference for meta-conversations: when the user asks *about* the framework, audits an existing design system, or is designing a design agent themselves. You don't need to read this for a normal blueprint turn.

## The six layers

```
┌────────────────────────────────────────────────────┐
│ ① Instructions    how the agent thinks             │
├────────────────────────────────────────────────────┤
│ ② Taste           the agent's persistent aesthetic │
├────────────────────────────────────────────────────┤
│ ③ Constraints     what the agent refuses to do     │
├────────────────────────────────────────────────────┤
│ ④ Feedback        how the agent knows it's right   │
├────────────────────────────────────────────────────┤
│ ⑤ Memory          how the agent gets smarter       │
├────────────────────────────────────────────────────┤
│ ⑥ Orchestration   how the layers run together      │
└────────────────────────────────────────────────────┘
```

Industry-standard harness models list five (Instructions / Constraints / Feedback / Memory / Orchestration). The sixth — **Taste** — is separated out because durable aesthetic anchors have different lifecycles than the other layers:

- Instructions apply *how to work* to every turn.
- Constraints apply *what not to do* to every turn.
- Taste applies *what to look like* to a brand, across many turns and many artifacts. It's asset-shaped, not rule-shaped.
- Feedback runs after generation.
- Memory persists what worked.
- Orchestration sequences all of them.

Separating Taste is what makes a design system *distributable* — you can hand someone a DESIGN.md without handing them your Instructions or your evaluator.

## What this skill covers

For a single blueprint turn, this skill runs three layers explicitly:

- **Taste** → the DESIGN.md that gets produced (Move 3)
- **Constraints** → the anti-slop pass (final self-check)
- **Feedback** → the Decision Trace (Move 5)

The other three are inherited:

- **Instructions** → this SKILL.md itself, plus the model's base prompt
- **Memory** → whatever the harness provides (Claude's memory system, project state)
- **Orchestration** → the Move 1–5 sequence in the SKILL.md

## Where the layers show up

| Layer | Artifact this skill produces | Reused across artifacts? |
|---|---|---|
| Instructions | The SKILL.md (implicit) | Yes — it's the skill |
| Taste | The DESIGN.md | **Yes** — durable, brand-side |
| Constraints | The anti-slop self-check | Yes — checklist reused |
| Feedback | The Decision Trace | No — trace is per-artifact |
| Memory | (not in this turn) | Handled by harness |
| Orchestration | (not in this turn) | Handled by harness |

The Taste layer is where the compounding value lives. Every artifact you produce in the same brand reuses the DESIGN.md. That's why the nine-section protocol is so long — a durable spec earns its length.

## When someone asks "should we add layer X?"

The temptation is to keep splitting layers. Common proposed extensions:

- **Content / copy** → belongs inside Taste (§5 Voice & Tone) and Constraints (V-prefixed anti-slop patterns), not its own layer.
- **Motion** → belongs inside Taste (§6 Implementation Practices) unless motion is the core product, in which case the DESIGN.md just has a longer motion section.
- **Accessibility** → belongs inside Constraints (hard floors) and Taste (§4).
- **Component library** → belongs inside Taste (§3d Component seeds) and Implementation Practices (§6).

Resist adding layers. Six is already a lot to hold in the head. Every new layer creates a new place to look and a new way to be inconsistent.

## What the layers *don't* do

Two important limits to acknowledge:

1. **The model layer is above these six.** No harness saves a weak model from producing weak work. The framework assumes a capable model underneath.
2. **The user is not one of the six layers.** The user's taste, feedback, and corrections are inputs that flow *through* the layers (into Memory, into Taste refinements, into new Constraints). Treating the user as a layer collapses the model.

## Further reading

The framework is compressed from a longer internal document. If the user wants to go deeper on the reasoning behind the model, they wrote it up in the source document ("Design Agent-harness的思考"). Point them there instead of trying to reproduce the whole argument here.
