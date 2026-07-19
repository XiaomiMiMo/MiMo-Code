# DESIGN.md — [Brand name]

<!--
This is the fillable template. When producing a DESIGN.md as part of a blueprint,
copy this structure, replace every [placeholder], remove these HTML comments, and
delete any sub-bullets that don't apply. Do not add sections beyond these nine.

See references/nine-section-protocol.md for how to write each section well.
-->

## 1. Objective

[One paragraph, at most three sentences. What should someone walk away feeling after any well-executed artifact in this system? What's the quality bar?]

## 2. Product Context

- **What the product does:** [one sentence anyone could parrot]
- **Who it's for:** [primary user, in enough detail to visualize]
- **Adjacent brands (feel like these):** [three real references]
- **Distant brand (do not feel like this):** [one real anti-reference, with a one-clause why]
- **Cultural register:** [serious / playful / technical / aspirational — pick and defend]

## 3. Visual Foundations

### 3a. Color

- **Neutral scale:** `[--n-50: #____, --n-100: #____, ...]` (5–9 stops)
- **Accent(s):** `[--accent-primary: #____]` [+ secondary if warranted]
- **Semantic:** `[--success: #____, --warning: #____, --error: #____]` [omit if artifact doesn't need]
- **Usage rules:** [when each color appears; e.g., "accent is used once per screen, on the primary CTA or the single most important number — never as a section background"]

### 3b. Typography

- **Display face:** `[name, weights in use, tracking if non-default]`
- **Body face:** `[name, weights in use]`
- **Fallback stack:** `[fallback list]`
- **Type scale:** `[12 / 14 / 16 / 18 / 24 / 32 / 48 / 72]` (or state the ratio)
- **Weight discipline:** [which weights are permitted where; state explicitly to prevent drift]

### 3c. Spacing & rhythm

- **Base unit:** `[4 | 6 | 8 px]`
- **Spacing scale:** `[4, 8, 16, 24, 32, 48, 64, 96, 128 px]` (or state the ratio)
- **What "generous" whitespace means in numbers:** [e.g., "section padding ≥ 96px on desktop"]

### 3d. Component seeds

- **Button:** [variant count, what makes each different, shape rules]
- **Card / container:** [used at all? if so, what makes them distinctive from the default]
- **Iconography:** [set + weight, or "no icons" as a real choice]
- [Any additional component conventions specific to this brand]

## 4. Accessibility

- **Text contrast:** body 4.5:1 min, large text/UI 3:1 min
- **Motion:** [default reduced, or state the intent]
- **Focus indicators:** [what they look like — not "TBD"]
- **Alt text policy:** [what alt text says for decorative vs. informational images]
- [Any additional a11y floor items relevant to the artifact type]

## 5. Voice & Tone

- **Register:** [formal / conversational / technical / playful]
- **Sentence rhythm:** [short / long / mixed — state the norm]
- **Words this brand uses:** [2–4 examples]
- **Words this brand refuses:** [3–5 examples — list them explicitly, e.g., "seamless, elevate, journey, unlock, delight"]
- **Address:** ["you" / "your team" / "customers" — pick one primary]

## 6. Implementation Practices

- **Token format:** [CSS variables / Tailwind theme / Figma variables / other]
- **Component library convention:** [shadcn / Radix / bespoke / other]
- **Image treatment rules:** [photography style / illustration system / "no images" as a real choice]
- **Grid system:** [12-col / asymmetric / no formal grid]
- **Motion rules:** [easing, duration range, permitted animation types]
- [For non-code artifacts, translate to the medium: export specs, print rules, slide dimensions, etc.]

## 7. Anti-Patterns

<!-- Draw from references/anti-slop.md then add 3–5 refusals SPECIFIC to this brand. -->

- **No [pattern].** [One sentence on why — reason specific to this brand, not a generic tell.]
- **No [pattern].** [Why.]
- **No [pattern].** [Why.]
- **No [pattern].** [Why.]
- **No [pattern].** [Why.]

## 8. Decision-Making

<!-- Priority order — numbered — for when principles conflict. Four to six rules. -->

1. **[Principle name].** [What to do when this principle conflicts with a lower one.]
2. **[Principle name].** [...]
3. **[Principle name].** [...]
4. **[Principle name].** [...]

## 9. Workflow

<!-- Numbered step-order any agent (human or AI) should follow when producing a new artifact in this system. Five to eight steps. -->

1. [Step]
2. [Step]
3. [Step]
4. [Step]
5. [Step]
6. [Step]
7. [Step]
