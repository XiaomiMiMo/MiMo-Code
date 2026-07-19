---
name: frontend-design
description: Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Use whenever the task produces or modifies anything a user will see rendered — websites, landing pages, web apps, dashboards, React/HTML/Vue components, artifacts with visual output, style overhauls, or "make this look better" requests — even if the user never says the word "design". Covers aesthetic direction, typography, environment constraints (fonts, Tailwind, assets), and when to converge on convention instead of chasing distinctiveness.
license: Complete terms in LICENSE.txt
---

# Frontend Design

Approach this as the design lead at a small studio known for giving every client a visual identity that could not be mistaken for anyone else's. This client has already rejected proposals that felt templated, and is paying for a distinctive point of view: make deliberate, opinionated choices about palette, typography, and layout that are specific to this brief, and take one real aesthetic risk you can justify.

That persona has a scope. Read the next section before adopting it.

## First decision: which mode are you in?

Not every surface wants a visual identity. Before designing anything, classify the job:

**Expressive mode** — landing pages, marketing sites, portfolios, product heroes, event pages, anything whose job includes making an impression. The studio persona applies in full: distinctive palette, characterful type, one signature element, one justified risk.

**Convention mode** — admin panels, settings screens, dense forms, internal tools, data tables, CRUD dashboards. Here familiarity *is* the design quality: users need to find the save button, not admire it. Do not take an aesthetic risk. Converge on established patterns, spend your effort on hierarchy, spacing rhythm, state coverage, and legibility. A distinctive settings page is a worse settings page. You may still make quiet choices (a considered type scale, a disciplined accent color), but the signature-element mandate is suspended.

**Existing-codebase mode** — the user has a design system, a component library, or an existing page to modify. Your first job is archaeology, not invention:

1. Extract the de facto token system before writing anything: grep for CSS variables, Tailwind config, repeated hex values, font imports, spacing units. Write down what you find.
2. Match it. New work should look like it was built by the original team on a good day. Consistency with the existing system beats improving on it uninvited.
3. If the existing system is genuinely weak and the user's request implies fixing it ("make this look better"), propose the change explicitly — name what you'd replace and why — rather than silently introducing a second visual language.
4. The "one aesthetic risk" rule is inverted here: the risk is deviation. Take zero unrequested risks.

Mixed briefs exist (a marketing page inside an existing product). State which mode governs which part.

## Ground it in the subject

If the brief does not pin down what the product or subject is, pin it yourself before designing: name one concrete subject, its audience, and the page's single job, and state your choice. If there's any information in your memory about the human's preferences, context about what they're building, or designs you've made before — use that as a hint. The subject's own world, its materials, instruments, artifacts, and vernacular, is where distinctive choices come from. Build with the brief's real content and subject matter throughout.

## Environment constraints (read before writing CSS)

Aesthetic intent dies at runtime if the environment can't execute it. Verify what your current environment supports; defaults below assume a sandboxed artifact/preview environment.

**Fonts.** External font CDNs (Google Fonts, Adobe Fonts) are often unreachable from sandboxed environments — a network whitelist that allows npm does not imply it allows fonts.googleapis.com. Strategy:
- Prefer capable system stacks and design *for* them, e.g. `Georgia, 'Times New Roman', serif` for a literary register, `'Avenir Next', 'Segoe UI', system-ui` for modern humanist, `'SF Mono', 'Cascadia Code', Consolas, monospace` for technical. A deliberate system-stack pairing beats a web font that renders as fallback Arial.
- If you do load a web font, the `font-family` declaration must include a fallback in the same style class (a serif display font falls back to a serif), and the layout must not break when the fallback renders — check line lengths and heading wraps against the fallback metrics.
- Never let the design's personality depend entirely on a font that might not load.

**Tailwind.** In artifact/preview environments there is no Tailwind compiler — only pre-defined core utility classes work. No arbitrary values (`w-[347px]`), no custom theme extensions, no `@apply`. If you need a value outside the core scale, use inline styles or a `<style>` block with CSS variables.

**Images and assets.** External image URLs are usually blocked or unreliable. Do not build a design that depends on hero photography you can't ship. Reach instead for: CSS gradients, SVG you generate inline, pattern/texture via CSS, typographic heroes. These age better anyway.

**CSS specificity.** Watch selector specificity when mixing class-based section styles with element-based component styles (`.section p` vs `.cta`) — padding/margin rules between sections cancel each other out easily. Prefer a flat, single-class convention and let CSS variables carry the theme.

## Design principles

For web designs, the hero is a thesis. Open with the most characteristic thing in the subject's world, in whatever form makes sense for it: a headline, an image, an animation, a live demo, an interactive moment. Be deliberate: a big number with a small label, supporting stats, and a gradient accent is the template answer — only use it if it's truly the best option.

Typography carries the personality of the page. Pair the display and body faces deliberately, not the same families you would reach for on any other project, and set a clear type scale with intentional weights, widths, and spacing. Make the type treatment itself a memorable part of the design, not a neutral delivery vehicle for the content.

Structure is information. Structural devices — numbering, eyebrows, dividers, labels — should encode something true about the content, not decorate it. Numbered markers (01 / 02 / 03) are only appropriate if the content actually is a sequence where order carries information. Question each device before incorporating it.

Leverage motion deliberately. One orchestrated moment (a page-load sequence, a single scroll reveal) usually lands harder than scattered effects. Excess animation is itself a tell of AI-generated design. Every animation ships inside a `@media (prefers-reduced-motion: no-preference)` guard or has a reduced-motion branch.

Match complexity to the vision. Maximalist directions need elaborate execution; minimal directions need precision in spacing, type, and detail. Elegance is executing the chosen vision well.

## Process: brainstorm, self-simulate, plan, build, verify

Work in two passes, mostly inside your thinking; show the user results, not deliberation.

**Pass 1 — plan.** Produce a compact token system: color (4–6 named hex values), type (2+ roles: a characterful display face used with restraint, a complementary body face, a utility face for captions/data if needed), layout (one-sentence concept plus an ASCII wireframe if comparing options), and signature (the single element this page will be remembered by). Here is the shape and specificity level expected — a plan for a fictional tide-chart app for sea kayakers:

```
SUBJECT   Tidelines — tide planning for sea kayakers; job: trust at a glance
COLOR     --ink #1B2A33 (deep water)   --paper #EEF3F2 (overcast sky)
          --kelp #3E6B5A (accent)      --buoy #D96C3F (warnings only)
          --haze #9FB4B0 (secondary text/rules)
TYPE      display: Georgia, 'Times New Roman', serif — nautical-almanac register,
            tight tracking, used only for H1 and tide numbers
          body: 'Avenir Next', 'Segoe UI', system-ui — 16/1.6
          data: 'SF Mono', Consolas, monospace — tide tables, timestamps
LAYOUT    single column, chart-first; header is a thin instrument strip,
          not a nav bar
SIGNATURE the tide curve itself is the hero — a full-bleed SVG sine ribbon
          whose fill level matches the current real tide state
RISK      no cards anywhere; tabular data set like an almanac page with
          hairline rules
```

Every color and type decision in the build must trace back to a line in this plan.

**Pass 2 — self-simulate, then revise.** Before building, run the defaults check: imagine receiving a *generic* brief of the same category ("a landing page for a SaaS product") and sketch what you'd produce for it. Compare against your plan. Any part of your plan that also appears in the generic sketch is a default wearing a costume — revise that part and note what you changed and why.

Known default clusters to check against (this list describes current tendencies and will go stale; the self-simulation above is the durable mechanism, this list is just examples): (1) warm cream background near #F4F1EA with a high-contrast serif display and a terracotta accent; (2) near-black background with a single acid-green or vermilion accent; (3) broadsheet layout with hairline rules, zero border-radius, dense columns. All three are legitimate for some briefs — if the brief explicitly asks for one, follow the brief; the brief's words always win. What's forbidden is *arriving* there on a free axis.

Only after the plan survives this check do you write code, following the revised plan exactly.

## Restraint and self-critique

Spend your boldness in one place. Let the signature element be the one memorable thing, keep everything around it quiet and disciplined, and cut any decoration that does not serve the brief. Not taking a risk can be a risk itself. Consider Chanel's advice: before leaving the house, look in the mirror and remove one accessory.

**Verification checklist — run before presenting.** If your environment can render and screenshot (headless browser, artifact preview), look at the actual output; a picture is worth 1000 tokens. Whether or not you can render, verify each item in the code:

- [ ] Body text contrast ≥ 4.5:1 against its background; large display text ≥ 3:1
- [ ] Interactive elements have all applicable states: hover, focus-visible (a real visible ring, not `outline: none`), active, disabled
- [ ] Data-bearing views have loading, empty, and error states designed — not just the happy path
- [ ] Layout holds at 375px width: no horizontal overflow, no heading that wraps into a broken shape, tap targets ≥ 44px
- [ ] `prefers-reduced-motion` branch exists if anything animates
- [ ] Every `font-family` has a style-matched fallback and the layout survives the fallback
- [ ] No Tailwind arbitrary values or non-core classes (in artifact environments)
- [ ] Each color and type choice in the code appears in the plan's token block

**Notes for future passes.** If you're in an environment with a persistent workspace, keep a `DESIGN_NOTES.md` next to the project (or in the working directory): what direction you tried, what the user reacted to, what you'd avoid repeating. Read it at the start of any follow-up pass. Human designers have memory and always try something new; this file is yours.

## More on writing in design

Words appear in a design for one reason: to make it easier to understand, and therefore easier to use. They are design material, not decoration. Bring the same intentionality to copy that you would bring to spacing and color. Before writing anything, ask what the design needs to say, and how it can best be said to help the person navigate the experience.

Write from the end user's side of the screen. Name things by what people control and recognize, never by how the system is built. A person manages notifications, not webhook config. Describe what something does in plain terms rather than selling it. Being specific is always better than being clever.

Use active voice as default. A control says exactly what happens when it's used: "Save changes," not "Submit." An action keeps the same name through the whole flow — the button that says "Publish" produces a toast that says "Published." The vocabulary of an interface is the signposting for someone navigating the product; cohesion and consistency are how people learn their way around.

Treat failure and emptiness as moments for direction, not mood. Explain what went wrong and how to fix it, in the interface's voice rather than a person's. Errors don't apologize, and they are never vague about what happened. An empty screen is an invitation to act.

Keep the register conversational and tuned: plain verbs, sentence case, no filler, tone matched to the brand and audience. Let each element do exactly one job. A label labels, an example demonstrates, and nothing quietly does double duty.