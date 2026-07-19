# Decision Trace

The Decision Trace is the single most important differentiator of this skill. Without it, a design can only be *regenerated*. With it, a design can be *edited*. That's the difference between "AI made this" and "we have a designer working with us."

## Schema

Each Decision Trace entry is one JSON-style object with exactly four fields:

```json
{
  "decision": "one line — what was chosen",
  "reason": "why this fits the brief better than the alternatives",
  "alternatives": ["the other options you seriously considered"],
  "tradeoff": "what this choice costs — what it's worse at than the alternatives"
}
```

Notes on each field:

- **decision** — Concrete and specific. "Warm off-white background (`#F7F3EC`) instead of pure white" — not "chose a warm background."
- **reason** — Tied to the brief, the audience, the identity, the mood. Not generic ("looks better") — specific ("Reads as considered rather than clinical; matches the Analog Warmth direction the user picked and the editorial-web references they cited.")
- **alternatives** — 1–3 real options you actually thought about, not straw men. If you can't name a real alternative you rejected, you weren't really deciding.
- **tradeoff** — Every real decision costs something. Naming the cost is what makes the trace honest and useful.

## When to emit a trace

**Emit a trace whenever any of these are true:**

1. You made a choice that a competent designer could reasonably have made differently. (This is most choices worth tracing.)
2. You broke a common pattern deliberately. (Anti-slop reversals — trace them so they don't read as mistakes.)
3. You picked one direction over another when the brief could have supported either.
4. You made a scope call — decided *not* to include something a default template would.
5. You resolved a conflict between two principles from the DESIGN.md (e.g., accessibility vs. distinctive color).

**Do NOT emit a trace for:**

1. Following an explicit user directive. ("User said Söhne, we used Söhne" is not a decision.)
2. Complying with a hard accessibility floor. (Not a decision — it's the floor.)
3. Trivialities. Margin=24px vs margin=20px does not warrant a trace unless the choice was itself principled and consequential.

Rough target: **5–10 traces per blueprint.** Fewer than 5 usually means you're not making enough real choices, or you're hiding them. More than 15 usually means you're tracing pixel-nudges.

## Good traces vs. weak traces

### Weak trace 1 — vague reason

```json
{
  "decision": "Serif display face for headlines",
  "reason": "Feels more editorial",
  "alternatives": ["Sans-serif"],
  "tradeoff": "May be less modern"
}
```

Everything here is empty. "Feels more editorial" doesn't say *how* or *why for this brief*. "Sans-serif" as an alternative is a genre, not a decision — what specific sans? "May be less modern" is an aesthetic hedge, not a real cost.

### Stronger version

```json
{
  "decision": "Söhne 700 for display, GT America 400 for body — no serif",
  "reason": "The user cited Ramp and Mercury as adjacent brands; both use humanist sans, not serif. Serif would push the brand toward Aeon / Substack territory, which the brief specifically distanced itself from ('less magazine, more capable-tool').",
  "alternatives": ["Söhne body + Söhne Breit display (single family)", "GT Alpina serif for display"],
  "tradeoff": "GT Alpina would give a stronger character contrast and read as more distinctive; the two-sans pairing is safer and more likely to read as fintech-native. If the brand ever wants to differentiate harder against Ramp/Mercury, Alpina is where I'd go."
}
```

Notice what changed: the reason connects to a specific brief detail, the alternatives are real choices with real names, the tradeoff is a genuine cost with an actionable next-move for the user.

### Weak trace 2 — hidden default

Missing entirely. The blueprint just uses a card grid for a feature section. No trace.

### Stronger version

```json
{
  "decision": "Feature section rendered as inline typographic list, not a card grid",
  "reason": "The Editorial Restraint direction the user picked treats every card grid as a slop tell (see anti-slop.md #U2). Inline typographic rhythm — feature name in Söhne 500, description in GT America 400, one accent color for the feature-name, hairline divider between — carries the same information with less template drag.",
  "alternatives": ["3×2 card grid (rejected: template)", "Icon+heading+description in a flex row (rejected: still reads as grid-derived)"],
  "tradeoff": "Inline typography is harder to skim than a card grid. If usability testing shows people miss features, revisit — but for the current brief (a considered, reading-first brand), skim isn't the primary optimization."
}
```

The hidden default is now surfaced, named, and defended. If the user disagrees, they can push back at the trace level, not at the artifact level.

## Example set — a full blueprint's worth

For a landing-page blueprint, a reasonable set of traces might be:

1. Direction pick (Editorial Restraint over the other four)
2. Type pairing choice
3. Accent color choice
4. Whether to include real photography
5. Feature section rendering (typographic list vs. card grid)
6. Primary CTA visual weight
7. Whether to include social proof, and in what form
8. Section count / page length
9. Any deliberate anti-slop reversal (breaking a common pattern)

Nine traces. Each connects a specific choice to a specific brief detail.

## Format in your final output

Either as a JSON array (if the user is likely to consume this programmatically):

```json
[
  { "decision": "...", "reason": "...", "alternatives": [...], "tradeoff": "..." },
  { "decision": "...", "reason": "...", "alternatives": [...], "tradeoff": "..." }
]
```

Or as a numbered list with the four fields as sub-bullets (better for reading):

```
1. **Direction: Editorial Restraint**
   - **Reason:** Brief cited Substack, Aeon, and "quiet magazine feel" — Editorial Restraint is the direction that matches all three references and refuses the SaaS-default gradient hero the user complained about.
   - **Alternatives:** Refined Minimal (Apple-adjacent, rejected as too polished for the founder's voice); Broadsheet (too data-dense for a mostly-textual product page).
   - **Tradeoff:** Editorial Restraint is high-execution-risk — done badly it reads as "unstyled." All downstream choices need to be sharp to justify the direction.

2. **Type pairing: GT Alpina + GT America Mono**
   - **Reason:** ...
```

Pick whichever format the artifact and user context call for. When in doubt, use the numbered list — it's more readable and easier for the user to reply-inline to individual traces.

## The reason this all matters — one more time

A design without traces is opaque. If the user says "change the accent color," you don't know whether that change breaks any other decision, and neither does the user. If the accent was traced with a reason and a tradeoff, the user sees the ripple — "if I change the accent from #E85D3B to blue, I also need to reconsider decision #4 and #7 because those depended on the warmth of this palette." That's the whole point. Traces make the design a set of connected commitments, not a monolithic pile of pixels.
