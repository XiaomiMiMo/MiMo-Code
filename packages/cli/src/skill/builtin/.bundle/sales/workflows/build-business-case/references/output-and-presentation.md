# Output And Presentation Rules

## Presentation and design guidance
This section is presentation-only. It governs customer-ready templates, HTML artifacts, or output templates associated with the skill. It must not change the build-business-case logic.

Apply this guidance only to formatted artifacts produced beyond plain chat markdown, or to support files the user provides for that artifact. Do not assume this skill ships with HTML, CSS, or output template files unless those files are actually present.

Do not let presentation rules alter:

- the workflow
- the evidence hierarchy
- the assumptions handling
- the value-model logic
- the output content requirements

Visual direction:

- editorial
- reductive
- precise
- presentation-grade
- branded like an internal corporate deliverable
- not dashboard-like
- not consumer-marketing-like

Typography for presentation artifacts:

- primary font: `Arial`
- fallback stack: `"Helvetica Neue", Arial, sans-serif`
- use bold, high-contrast titles
- use restrained section headings
- keep body text readable and calm
- use compact metadata labels
- do not use monospace styling except for literal data snippets or code

Color and palette for presentation artifacts:

- use the user's supplied brand conventions when available;
- otherwise use near-black or dark navy text, a very light neutral background, and restrained neutral or blue accents;
- use status accents only when they clarify meaning, not as decoration.

Color rules:

- start from neutrals
- use color for hierarchy, focus, or status
- avoid decorative overuse of accent fills

Layout and composition for presentation artifacts:

- use deck-like, 16:9-inspired composition
- use a strong hero or header treatment
- maintain disciplined grid alignment
- preserve generous whitespace
- prefer presentation-like framing rather than app-like chrome
- use a 2-column rhythm where appropriate on desktop
- collapse cleanly to a single column on mobile

Tables and data visualization for presentation artifacts:

- reductive
- clear
- hierarchical
- precise
- simple and scalable
- clean keylines
- minimal fills
- high contrast
- no heavy zebra striping
- no noisy chrome

Component behavior for presentation artifacts:

- compact, restrained metadata chips
- refined pills rather than generic app badges
- clean, editorial content blocks
- subtle shadows only when structurally helpful
- large-radius modules only if they still read as corporate, not playful

Explicitly forbidden visual patterns:

- glassmorphism
- frosted translucency
- glossy gradients
- floating app-style chrome
- oversized drop shadows
- startup-marketing UI treatment
- decorative visual effects that compete with the data

If no presentation artifact is requested, ignore this section and return strong plain markdown.

## Default output pattern

Unless the user asks for something else, default to this structure:

### `Executive Summary`

Include:

- what the customer is trying to achieve
- why this matters now
- what workflows and use cases matter most
- what the likely value story is
- public-company "why now" context when material

### `Strategic Initiatives`

Include:

- the customer's most relevant strategic goals
- explicit public-company statements when available, rather than generic sector inference

### `Key Challenges`

Include:

- the main blockers or pain points
- a clear distinction between public pressure and internal blockers

### `Priority Workflows`

Include:

- the workflows most relevant to those priorities

### `Priority Use Cases`

Include:

- the use cases most relevant to those workflows

### `Value Hypothesis by Use Case`

Include:

- expected benefit
- why it matters
- which value bucket it maps to

### `Metrics and Assumptions`

Include:

- required inputs
- known data
- assumptions
- confidence level

### `ROI or Value View`

Include:

- low, base, and high case where possible

### `Solution Differentiators`

Include:

- why the seller solution is a strong fit for the customer and use case
- linkage to both internal workflow evidence and public strategic context when both exist

### `Proof Points or Analogous Wins`

Include:

- relevant supporting examples
- keep public-company statements separate from account-native proof

### `Caveats and Open Questions`

Include:

- what still needs validation
- what public research could not determine

Default output rules:

- keep the package decision-useful
- keep prioritization explicit
- label `Known`, `Inferred`, `Assumed`, and `Missing` when evidence is mixed
- use focused public research by default for named public companies when it sharpens why-now context
- do not claim precision you cannot support

## Example prompts to include when building and testing the skill

Use prompts like:

- `Build an ROI narrative for an enterprise productivity platform for a 20,000-employee bank.`
- `Build a value narrative for developer productivity tooling for a 10,000-employee retail bank.`
- `Build a value narrative for a financial services customer using platform APIs to optimize workflows.`
- `Turn messy discovery notes and a call transcript into an executive-ready business case.`
- `Create a low, base, and high value scenario using customer metrics and directional assumptions.`
- `Business case for ExampleCorp.`
- `Build a business case for the seller solution at a public company using account evidence plus public filings and earnings commentary.`

Use these prompts when evaluating whether the skill is behaving in a customer-led, decision-useful, and source-disciplined way.

Acceptance checks:

- focused public research is included by default for named public companies when it materially sharpens the case
- the output improves strategic-priority framing and "why now" logic
- the output does not invent internal baselines or buyer certainty from public materials
- public evidence is clearly separated from account-native proof

## Common failure modes to avoid

### `1. Generic consulting language`

Looks polished but says nothing specific.

### `2. Product-led instead of customer-led`

Starts with "the seller can..." instead of "The customer is trying to..."

### `3. False precision`

Shows detailed math with weak inputs and no assumptions called out.

### `4. Weak differentiation`

Uses generic "best-in-class" language with no customer relevance.

### `5. No prioritization`

Lists many use cases without saying which matter most.

### `6. No decision usefulness`

Reads like a summary, not a tool for advancing the deal.

### `7. No source discipline`

Mixes facts, assumptions, and public context without distinction.

### `8. Dashboard-like presentation drift`

If a template exists, it looks like a generic web app rather than a branded corporate deliverable.
