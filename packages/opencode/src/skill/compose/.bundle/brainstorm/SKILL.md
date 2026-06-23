---
name: compose:brainstorm
hidden: true
description: "You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation."
---

# Brainstorming Ideas Into Designs

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design and get user approval.

<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.

**Autonomous override:** When no user is available to approve, this HARD-GATE does not apply: skip design presentation and approval, proceed directly to implementation, treating every approval gate as auto-approved.
</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

**Autonomous override:** When no user is available, skip this anti-pattern guidance — proceed directly to exploring context and implementing; do not present a design for approval.

## Checklist

You MUST create a task for each of these items and complete them in order:

**Autonomous mode (no user available):** Skip steps 2–8. Only do: explore project context (step 1) → implement directly (invoke compose:plan or compose:execute). Do NOT present a design, ask questions, write a spec, or wait for approval.

1. **Explore project context** — check files, docs, recent commits
2. **Offer visual companion** (if topic will involve visual questions) — this is its own message, not combined with a clarifying question. See the Visual Companion section below.
3. **Ask clarifying questions** — one at a time, understand purpose/constraints/success criteria
4. **Propose 2-3 approaches** — with trade-offs and your recommendation
5. **Present design** — in sections scaled to their complexity, get user approval after each section
6. **Write design doc** (optional, multi-step features only) — save to the `specs/` directory given in the `<compose_docs_dir>` block of your prompt, as `YYYY-MM-DD-<topic>-design.md`, and commit. For single-step fixes or small changes, keep the design in conversation context only.
7. **Spec self-review** (if doc written) — quick inline check for placeholders, contradictions, ambiguity, scope (see below)
8. **User reviews written spec** (if doc written) — ask user to review the spec file before proceeding
9. **Transition to implementation** — invoke compose:plan to create implementation plan

## Process Flow

- **Explore project context**
- **Visual questions ahead?** — Yes → offer Visual Companion (own message, no other content)
- **Ask clarifying questions**
- **Propose 2-3 approaches**
- **Present design sections**
- **User approves design?** — No → revise, back to present design sections
- **Write design doc**
- **Spec self-review** (fix inline)
- **User reviews spec?** — Changes requested → back to write design doc / Approved → **invoke compose:plan**

**The terminal state is invoking compose:plan.** Do NOT invoke frontend-design, mcp-builder, or any other implementation skill. The ONLY skill you invoke after brainstorming is compose:plan.

## The Process

**Understanding the idea:**

- Check out the current project state first (files, docs, recent commits)
- Before asking detailed questions, assess scope: if the request describes multiple independent subsystems (e.g., "build a platform with chat, file storage, billing, and analytics"), flag this immediately. Don't spend questions refining details of a project that needs to be decomposed first.
- If the project is too large for a single spec, help the user decompose into sub-projects: what are the independent pieces, how do they relate, what order should they be built? Then brainstorm the first sub-project through the normal design flow. Each sub-project gets its own spec → plan → implementation cycle.
- For appropriately-scoped projects, ask questions one at a time to refine the idea
- When the question has a known set of likely answers, use `compose:ask` with those answers as options
- For open-ended questions, use `compose:ask` with 2-3 suggested answers as options — the user can always type their own answer
- If no user is available, make reasonable assumptions from project context and proceed
- Only one question per tool call — if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why

**Presenting the design:**

- Once you believe you understand what you're building, present the design
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced
- After presenting each section, use `compose:ask`:
  - header: `Design Review`
  - question: `Does this <section-name> look right?`
  - options:
    - label: `Looks good`, description: `Approve and continue`
    - label: `Needs changes`, description: `I have feedback`

  If no user is available, treat as approved and continue.
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

**Design for isolation and clarity:**

- Break the system into smaller units that each have one clear purpose, communicate through well-defined interfaces, and can be understood and tested independently
- For each unit, you should be able to answer: what does it do, how do you use it, and what does it depend on?
- Can someone understand what a unit does without reading its internals? Can you change the internals without breaking consumers? If not, the boundaries need work.
- Smaller, well-bounded units are also easier for you to work with - you reason better about code you can hold in context at once, and your edits are more reliable when files are focused. When a file grows large, that's often a signal that it's doing too much.

**Working in existing codebases:**

- Explore the current structure before proposing changes. Follow existing patterns.
- Where existing code has problems that affect the work (e.g., a file that's grown too large, unclear boundaries, tangled responsibilities), include targeted improvements as part of the design - the way a good developer improves code they're working in.
- Don't propose unrelated refactoring. Stay focused on what serves the current goal.

## After the Design

**Documentation (optional, multi-step features only):**

For features with multiple tasks or significant architectural decisions:
- Write the validated design (spec) to the `specs/` directory given in `<compose_docs_dir>`, as `YYYY-MM-DD-<topic>-design.md`
  - (User preferences for spec location override this default)
- Use elements-of-style:writing-clearly-and-concisely skill if available
- Commit the design document to git

For single bug fixes or small changes, skip the written spec — the design presented in conversation is sufficient.

**Spec Self-Review (if doc written):**
After writing the spec document, look at it with fresh eyes:

1. **Placeholder scan:** Any "TBD", "TODO", incomplete sections, or vague requirements? Fix them.
2. **Internal consistency:** Do any sections contradict each other? Does the architecture match the feature descriptions?
3. **Scope check:** Is this focused enough for a single implementation plan, or does it need decomposition?
4. **Ambiguity check:** Could any requirement be interpreted two different ways? If so, pick one and make it explicit.

Fix any issues inline. No need to re-review — just fix and move on.

**User Review Gate (if doc written):**
After spec self-review passes, use `compose:ask`:
- header: `Spec Review`
- question: `Spec written and committed to <path>. Ready to proceed?`
- options:
  - label: `Approved`, description: `Proceed to compose:plan`
  - label: `Changes needed`, description: `I have revisions`

If no user is available, treat as approved and invoke compose:plan.

If "Changes needed" or custom feedback, apply changes and re-run spec review. Only proceed on approval.

**Implementation:**

- Invoke compose:plan to create a detailed implementation plan
- Do NOT invoke any other skill. compose:plan is the next step.

## Spec Section Anchors

When writing the spec, give every `##` section heading a stable anchor ID so downstream plan tasks and reviewers can reference exact spec locations. Put the ID at the start of the heading text:

```markdown
## [S1] Problem
## [S2] Solution overview
## [S3] Coverage gate behavior
```

Rules:

- **ID format** is `S` followed by a number (`[S1]`, `[S2]`, `[S3]`, ...), unique within the spec — no two sections share an ID, and no section is left without one.
- **Number sections in document order** when first authoring the spec (top section is `[S1]`, the next is `[S2]`, and so on).
- **The ID is stable.** If a heading is later reworded, keep its existing ID and do NOT renumber the other sections. Downstream `covers:` references and review verdicts depend on these IDs not drifting — renumbering would silently break every reference that points at them.

These anchors are the index the plan and reviewers use to trace each task and each review verdict back to the exact spec section it serves.

## Key Principles

- **One question at a time** - Don't overwhelm with multiple questions
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Incremental validation** - Present design, get approval before moving on
- **Be flexible** - Go back and clarify when something doesn't make sense

## Visual Companion

A browser-based companion for showing mockups, diagrams, and visual options during brainstorming. Available as a tool — not a mode. Accepting the companion means it's available for questions that benefit from visual treatment; it does NOT mean every question goes through the browser.

**Offering the companion:** When you anticipate visual content (mockups, layouts, diagrams):

1. **Check memory** for a `visual-companion` preference in the `compose-preferences` memory file. If found, honor it.

2. **If no saved preference,** offer consent using `compose:ask` (this MUST be its own message — do not combine with other content):
   - header: `Visual Companion`
   - question: `Some upcoming questions may benefit from browser-based mockups and diagrams. This feature is token-intensive and requires opening a local URL.`
   - options:
     - label: `Yes, always`, description: `Enable visuals for this and future sessions`
     - label: `No, never`, description: `Skip visuals for this and future sessions`
     - label: `Yes, this time`, description: `Enable visuals for this session only`
     - label: `No, this time`, description: `Skip visuals for this session only`

   If no user is available, skip the visual companion and use text-only.

3. **If "Yes, always" or "No, never":** Save to the `compose-preferences` memory file.

If declined, proceed with text-only brainstorming.

**Per-question decision:** Even after the user accepts, decide FOR EACH QUESTION whether to use the browser or the terminal. The test: **would the user understand this better by seeing it than reading it?**

- **Use the browser** for content that IS visual — mockups, wireframes, layout comparisons, architecture diagrams, side-by-side visual designs
- **Use the terminal** for content that is text — requirements questions, conceptual choices, tradeoff lists, A/B/C/D text options, scope decisions

A question about a UI topic is not automatically a visual question. "What does personality mean in this context?" is a conceptual question — use the terminal. "Which wizard layout works better?" is a visual question — use the browser.

If they agree to the companion, read the detailed guide before proceeding:
`<compose:brainstorm>/visual-companion.md`
