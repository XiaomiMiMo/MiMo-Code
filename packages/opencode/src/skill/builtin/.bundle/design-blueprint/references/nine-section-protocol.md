# The Nine-Section DESIGN.md Protocol

The DESIGN.md is the persistent, brand-side spec — the durable *taste anchor* that survives across many artifacts (this slide deck, next quarter's poster, the landing page redesign). If it reads like a one-off memo about *this specific request*, you wrote it wrong. Rewrite it so any future designer, or any future agent, could execute a fresh artifact against it and stay on-brand.

Nine sections, each with a clear job. Do not merge them, and keep all nine headers even in a lite-depth spec (see SKILL.md Move 3 for when lite is appropriate) — a future turn can inflate a compressed section, but two specs with different shapes can't be reconciled. Whatever the depth, do not skip Anti-Patterns or Decision-Making — those two are the sections that actually prevent drift.

---

## 1. Objective

**Job:** Name the outcome the brand is trying to produce with its design system, above the level of any one artifact.

- Not "make a slide deck for the Q3 all-hands." That's the task.
- Instead: "Feel like a serious company that ships. Confidence without swagger. The visual system should read as *edited*, not *decorated*."

One paragraph, at most three sentences. Answer: what should someone walk away *feeling* after any well-executed artifact in this system?

Also state the quality bar explicitly (e.g., "portfolio-piece for the designer who made it" vs. "internal comm, ship it fast").

**Weak:** "Modern, clean, professional."
**Strong:** "The design should feel like it was made by a person who reads *The Baffler* and thinks Substack overdesigned. Type-forward. Restrained color. Confident whitespace. Any decoration must earn its place."

---

## 2. Product Context

**Job:** Ground the design in what the product/brand actually *is* and *does*. This is where designer-native details live: what industry, who the audience is, what the competitive set looks like, what the brand explicitly is *not*.

Include:
- What the product does, in one sentence anyone could parrot
- Who it's for (primary user, in enough detail to visualize — not "SMB owners" but "the operations lead at a 40-person logistics company, mid-30s, always in six tabs")
- Competitive landscape: three real reference brands the design should feel *adjacent to* and one it should feel *distant from* ("adjacent: Ramp, Mercury, Linear. Distant: Stripe — too polished, we want more edge.")
- Cultural register: is this a serious brand? a playful one? a technical one? an aspirational one?

**Why include competitive references:** naming a real, existing brand collapses ambiguity faster than any adjective. "Feel like Ramp" tells a designer more than "feel modern and financial."

---

## 3. Visual Foundations

**Job:** Concrete, executable tokens. This is the section that gets copy-pasted into a CSS file or a Figma library. Vagueness here is failure.

Four mandatory sub-sections:

### 3a. Color
- 1 primary neutral scale (5–9 stops)
- 1–2 accent colors, with hex values
- Semantic colors (success, warning, error, info) if the artifact type needs them
- Rules for when to use each. "Accent is used once per screen, on the primary CTA or the single most important number. Never as a section background."

### 3b. Typography
- Display face (headings) — name it, specify weights actually in use
- Body face — same
- Fallback stack
- Type scale as numbers: `12 / 14 / 16 / 18 / 24 / 32 / 48 / 72` — or whatever the deliberate ratio is (1.25 minor third? 1.5 perfect fifth?)
- Weight discipline: which weights are permitted where. Half of "AI slop" typography is weight indiscipline — bold headline, bold subhead, semibold body, medium caption.

### 3c. Spacing & rhythm
- Base unit (4? 6? 8?)
- Spacing scale
- What "generous" whitespace means here in numbers, so future artifacts don't drift tight

### 3d. Component seeds
- Button: how many variants exist, what makes them different, what shapes they take
- Card / container: are they used at all? if so, what makes them distinctive vs. the default 16px-rounded shadow-sm slop
- Iconography: which set, which weight, whether icons are used at all (a "no icons" call is a real Visual Foundation)

---

## 4. Accessibility

**Job:** The non-negotiables. Contrast, motion, focus, alt text policy.

Minimum bar:
- Body text against its background: 4.5:1
- Large text and UI: 3:1
- Motion: default reduced, or state the intent
- Focus indicators: state what they look like — not "TBD"
- Alt text policy: what alt text says for decorative vs. informational images

This section is short. Its shortness is not laziness — it's stating the floor, not writing an essay.

---

## 5. Voice & Tone

**Job:** How copy in this system sounds. Because "AI slop copy" is at least as tell-tale as AI slop visuals — em-dash overuse, "elevate," "seamlessly," "unlock," "delight," rhetorical questions in headers.

Include:
- Register: formal / conversational / technical / playful
- Sentence rhythm: does this brand write short? long? mixed?
- Words this brand uses (2–4 examples)
- Words this brand refuses (3–5 examples). Yes, list them explicitly. "We do not use: seamless, elevate, journey, unlock, delight."
- Pronoun and address: "you" or "your team" or "customers"?

---

## 6. Implementation Practices

**Job:** How the system is realized in code / production, at the level a downstream implementer needs. This section is a bridge to the frontend-design or code-execution phase.

Include:
- Design token format (CSS variables? Tailwind theme? Figma variables?)
- Component library convention (are we using shadcn? Radix? bespoke?)
- Image treatment rules (real photography? illustration? no images?)
- Grid system (12-col? asymmetric? no formal grid?)
- Motion / animation rules ("easing: cubic-bezier(0.4, 0, 0.2, 1); duration: 150–300ms; never bounce")

If the artifact isn't code (a poster, a slide), translate this to the medium: "Export at 300dpi. Print CMYK, screen sRGB. Slides are 16:9, exported PDF at 2560×1440 for the deck link."

---

## 7. Anti-Patterns

**Job:** State what this system *refuses to do*. This is the single most valuable section of the whole spec — it's where slop gets killed.

Format: bullet list, each bullet is one refusal + one sentence on why.

Draw from `references/anti-slop.md` for the general list, then add 3–5 refusals *specific to this brand*.

Example (fintech landing page brand):
- No gradient hero backgrounds. Sits in the median of every fintech landing since 2020.
- No stacked "trust logos" strip immediately under the fold. Everyone does it; it stops meaning anything.
- No emoji in section headings. This brand's confidence is verbal, not visual.
- No card grids for feature lists. Use inline typographic rhythm instead.
- No "unlock your team's potential" copy. See Voice & Tone forbidden words.

---

## 8. Decision-Making

**Job:** What to do when the rules conflict. Every real design decision is a conflict between principles — accessibility vs. distinctive color, whitespace vs. information density, brand voice vs. clarity.

State the priority order. Explicitly.

Example:
1. **Accessibility floor is not negotiable.** If a distinctive color choice fails contrast, we change the color, not the contrast requirement.
2. **Clarity over cleverness.** If a distinctive layout obscures the message, revise the layout.
3. **Restraint over completeness.** When in doubt, cut. This brand is more likely to under-decorate than over-decorate.
4. **Distinctive over safe.** Given a choice between the default move and a considered non-default move, default to the non-default. But see rule 2.

Four to six rules. In priority order. Numbered.

---

## 9. Workflow

**Job:** The step-order any agent (human or AI) should follow when producing a new artifact in this system. This is what makes the DESIGN.md reusable.

Example (for a slide-deck system):
1. Read Objective + Product Context + Voice & Tone.
2. Write the slide outline in plain text — one line per slide, no visuals.
3. For each slide, decide: does the message need a visual, or does typographic treatment carry it?
4. Apply Visual Foundations (color, type scale) to the outline.
5. Anti-Patterns pass: flag any slide that matches a slop pattern; revise.
6. Accessibility pass: contrast + type size.
7. Ship.

Five to eight steps. Numbered. Executable.

---

## Two writing rules that apply to every section

**Concrete beats vague.** If you can replace a phrase in your DESIGN.md with a synonym and lose no information, the phrase was empty. "Modern" is empty. "Clean" is empty. "Sohne 400, tracked -0.01em" is not empty.

**Include what's excluded.** For every choice, name the thing you did not choose and why. "Body face is Söhne, not Inter — Inter is the default of the space and reads as unmade." That single "not Inter" clause is what makes the choice legible.
