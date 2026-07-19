# Value Model And Evidence Rules

## Standard value model structure
Use these value buckets exactly. Inline the logic rather than inventing new categories.

### `Enhanced Productivity`

Use when work gets done faster or with less effort.

Typical logic:

- `users x tasks per period x time saved per task x labor cost x adoption rate`

Examples:

- drafting
- summarization
- research
- knowledge retrieval
- coding assistance
- support response generation
- document preparation

### `Cost Reduction`

Use when there is hard-dollar savings or spend avoidance.

Typical logic:

- `current cost baseline - future cost baseline`
- avoided vendor spend
- avoided contractor spend
- reduced manual processing cost

Examples:

- workflow automation
- support cost reduction
- process consolidation
- lower external services cost

### `Risk Reduction`

Use when the seller solution reduces losses, errors, escalations, or incidents.

Typical logic:

- `incidents avoided x average cost per incident x confidence factor`

Examples:

- fewer manual errors
- better documentation quality
- reduced compliance issues
- fewer support escalations
- reduced operational rework

### `Revenue Acceleration`

Use when the seller solution helps increase or accelerate revenue.

Typical logic:

- `impacted revenue pool x improvement rate x confidence factor`

Examples:

- faster sales response
- better product discovery
- better conversion support
- earlier launch of revenue-generating features
- improved service capacity

### `Time to Market`

Use when the seller solution helps teams ship, launch, or execute faster.

Typical logic:

- `cycle time reduction x value of earlier release or deployment`

Examples:

- software development acceleration
- testing acceleration
- debugging acceleration
- workflow deployment
- faster product or feature launch

## Assumptions framework

Every output should clearly separate:

### `Hard data`

Customer-provided or system-derived metrics.

### `Directional assumptions`

Reasonable assumptions used where customer data is missing.

### `External context`

Industry or public-company information used to support the narrative.

### `Confidence level`

Use simple language such as:

- High confidence
- Medium confidence
- Low confidence

Confidence should reflect:

- input quality
- data completeness
- attribution difficulty
- adoption uncertainty
- baseline uncertainty

Required labeling behavior:

- label `Known` when supported by customer-provided or system-derived evidence
- label `Inferred` when a conclusion is reasonable but not directly stated
- label `Assumed` when the case depends on a directional assumption
- label `Missing` when required evidence is absent
- label public-derived insights clearly when they materially shape strategic context or "why now"

If confidence is low, say why. Do not soften uncertainty into polished prose.

## Evidence hierarchy

When evidence conflicts or is incomplete, prioritize sources roughly in this order:

1. customer-provided metrics
2. product telemetry or usage data
3. discovery notes or ~~Meeting Transcripts
4. ~~CRM, ~~Knowledge & Files, or internal account notes
5. public filings, earnings materials, website, investor materials, and recent material company news
6. analogous wins or directional benchmarks

Evidence rules:

- cite where important claims came from when available
- distinguish fact from inference
- do not let weaker public context silently override stronger customer or system evidence
- if public evidence conflicts with stronger internal evidence, prefer internal evidence and call out the tension if it materially changes the case
- use analogous wins and benchmarks to shape hypotheses, not to pretend customer proof exists

## Guardrails

The skill must never:

- invent customer numbers without labeling them as assumptions
- blur customer facts and directional assumptions
- over-claim AGI-like outcomes
- use unsupported claims as proof
- hide missing data
- write generic hype language disconnected from customer value
- treat earnings-call or public-company rhetoric as proof of company-specific business impact
- use public statements to infer exact internal workflow owners unless supported
- convert public strategic language into fake ROI
- let public research bloat the output with generic company background

The skill must always:

- label assumptions clearly
- show sources for key facts when available
- separate knowns versus unknowns
- use scenario ranges where uncertainty is meaningful
- tie use cases back to strategic priorities
- explain caveats openly
- be auditable and explainable
- use public sources to sharpen strategy and executive framing when a named company is present
- keep public strategic context separate from account-native proof

Fallback behavior:

- If the evidence is thin, narrow the output and make the gaps explicit.
- If the math is weak, present a structural case and the validation inputs required to strengthen it.
- If the user provided enough context to answer directionally, do not stall with unnecessary clarification questions.
