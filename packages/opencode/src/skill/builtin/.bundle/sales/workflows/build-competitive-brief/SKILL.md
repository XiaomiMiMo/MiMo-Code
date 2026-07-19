---
name: build-competitive-brief
description: "Use when the user wants a competitor or vendor comparison, market-landscape analysis, battlecard, objection package, positioning brief, or account-specific competitive view. Produce an evidence-backed comparison, guidance, and brief, using supplied materials, connected research, and public evidence when appropriate."
---

# Build Competitive Brief

Create a seller-ready competitive brief that separates verified facts from field signal and inference. Default to a self-contained HTML artifact plus a concise chat readout; use chat or Markdown only when the user explicitly asks for it. This skill owns research, synthesis, and the brief artifact, not external posting or CRM writes.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices.

## Key Dependency Categories

Use the categories that materially apply to the request; do not broaden a search merely because a source is available.

- ~~CRM for account, opportunity, contact, ownership, known competitor, and active-deal truth
- ~~Knowledge & Files for battlecards, competitive docs, account plans, product positioning, proof points, and prior briefs
- ~~Internal Messaging for recent field signals, account-team observations, objection examples, and source-of-truth routing when internal context matters
- ~~Meeting Transcripts for prior objections, competitor mentions, buyer language, decisions, and commitments
- ~~Sales Intelligence only when it sharpens competitor discovery, company context, or a concrete evidence gap

Use public research for current public competitor facts. Prefer official product, pricing, launch, customer-story, investor, and regulatory sources; use secondary coverage only when primary sources are insufficient.

## Reference Loading

`SKILL.md` owns the normal research flow, HTML-by-default behavior, and evidence guardrails. Load references only when their extra detail matters:

- Use [references/request-schema.yaml](references/request-schema.yaml) for structured input, mode normalization, or matrix bounds.
- Use [references/source-priority.md](references/source-priority.md) when source conflict, authority order, or public-proof downgrade behavior is ambiguous.
- Use [references/output-contract.md](references/output-contract.md) for exact section order, compressed brief variants, or machine-readable compatibility.

## Terms

- **Battlecard:** a compact seller guide for how to position against a competitor, including where they win, where they are weaker, and what to say.
- **Defensive prep:** preparation for a competitor that may be relevant even when there is not enough evidence to say the competitor is active in the live deal.

## Workflow Guidance

### 1. Resolve the comparison anchor

- Require one useful anchor: named competitor(s), a named account or deal with competitor context, or a clear product, workflow, segment, or market category to compare.
- Preserve the user's exact seller, competitor, account, and objection wording. Infer the seller from the prompt or provided material only when credible; otherwise ask one targeted question.
- When the user gives a clear product, workflow, segment, or market category but no competitor names, discover likely competitors from seller context, buyer context, product scope, maintained competitive material, and public evidence. Keep the discovered set focused and label uncertainty.
- User confirmation is required for any required anchor inferred from sources rather than provided by the user.
- If the anchor is ambiguous, do a bounded candidate pass before asking: at most three source reads, only enough to offer up to five concrete candidates with one-line rationale.
- When a company-like name could be a competitor or customer, use a bounded ~~CRM check when available. If it resolves to a customer and the user did not clearly name it as a competitor, treat it as account context or ask the user to choose.
- Do not gather broad enrichment before the user confirms an inferred required anchor.

### 2. Gather evidence in authority order

Use this order unless the user specifies a narrower lane:

1. User-provided notes, decks, transcripts, prior briefs, and linked material
2. ~~Knowledge & Files competitive docs, battlecards, account plans, and positioning
3. ~~CRM for named account or deal truth
4. ~~Meeting Transcripts and ~~Internal Messaging when they materially change the talk track
5. Official public competitor and seller sources
6. Investor, regulatory, or other primary public materials
7. ~~Sales Intelligence and reputable secondary coverage for a specific remaining gap

- Do not let generic web research replace stronger user or internal material.
- Establish a seller baseline from seller-controlled sources when the seller is known: positioning, product lines, target segments, customer proof, recent launches, and comparison language.
- Validate claims about current positioning, launches, pricing, partnerships, and public proof with public primary sources.
- For competitor-only runs, seek multiple distinct evidence units when available. For account-scoped runs, add account evidence when the user supplied it or a connected source can fetch it narrowly.
- Treat internal field signals as directional unless corroborated by account evidence, maintained docs, or public proof.
- For each important source, extract a concrete evidence unit: what is claimed, what is confirmed, why buyers may care, how to counter or reframe, and what not to overclaim.
- Cite material claims with clickable links when available. If a lane is unavailable, stale, thin, or conflicting, say so and continue with the strongest remaining evidence.

### 3. Build dossiers before synthesis

For each in-scope competitor, capture the relevant available facts:

- profile, target market, and what they sell
- positioning and buyer appeal
- pricing or pricing talk track only when supported
- recent launches, releases, partnerships, or public proof
- where they win and where the seller can separate
- likely objections, discovery questions, talk tracks, and landmines

Do not collapse competitors into one generic story. Keep distinct evidence and uncertainty for each.

### 4. Add account context carefully

- When an account is named, use user-provided account notes first and ~~CRM for account and opportunity truth.
- Use ~~Knowledge & Files, ~~Meeting Transcripts, or ~~Internal Messaging selectively when they sharpen the live account implication.
- Do not let public research or generic field chatter invent account status, competitor presence, or deal posture.
- If there is no direct evidence that a competitor is active in the deal, label the account section Defensive prep.

### 5. Synthesize the seller response

- Default to brief; use objections, positioning, or account_overlay when the request calls for a narrower shape.
- Compare at most five competitors in one matrix unless the user explicitly asks for more.
- For 1-v-1, use Area | Seller | Competitor | Readout. For 1-v-many, use Area | Seller read | Status | Main pressure.
- Use statuses such as Lead, Pressure from [Competitor], Mixed, and Not determined; do not force a winner when evidence does not support one.
- Keep the tone factual and calm. Include what to say, what to clarify, proof to use, and what not to overclaim; avoid a feature bakeoff unless requested.
- The package should answer what each competitor is doing, where they are dangerous, why they win, why they lose, how to compete, and what the seller or strategist should say next.

Example 1-v-1 row:

| Area | MyCompany | Competitor Alpha | Readout |
| --- | --- | --- | --- |
| Deployment fit | Strong for governed enterprise rollout | Strong for fast team-level adoption | Mixed; clarify buyer governance needs |

Example 1-v-many row:

| Area | MyCompany read | Status | Main pressure |
| --- | --- | --- | --- |
| Buyer simplicity | Strong if the buyer values one accountable platform | Pressure from Competitor Beta | Competitor Beta may look simpler for a narrow departmental use case |

### 6. Create and verify the artifact

- Default output: create a self-contained UTF-8 HTML brief with inline CSS and no external assets, then provide a concise chat summary. If the user explicitly asks for chat, plain text, or Markdown only, skip HTML and render the same substance in chat.
- Use a user-provided destination when supplied. Otherwise write a sanitized-seller-compintel-date.html file in the current workspace; use a safe temporary directory when a workspace file would be inappropriate. Ask before overwriting an existing user-visible file.
- Use a restrained, neutral, deck-inspired layout unless the user supplies brand conventions. Do not hardcode a company palette, logo, product name, or visual system.
- Include top-level sections or tabs: Overview, Competitors, Guidance, and Sources.
- Useful generic tooltip or card labels include Trigger, Discovery questions, Positioning, Verified signals, Where they win, Where the seller can separate, Why this works, Proof, Use when, and Landmine / do not say.
- Sources must show clickable provenance, evidence limitations, and which dependency categories were used, unavailable, or not relevant.
- Read the generated file back and verify the required sections, source provenance, and embedded styling are present. When a browser or Playwright-style renderer is available, render it once and fix blank pages, broken layout, unreadable contrast, or missing CSS before returning the link.
- Return the clickable artifact link first, followed by a short readout and a useful next-step offer. Do not narrate HTML mechanics in ordinary user-facing copy.

### Next Step Options

After the first output, offer the most relevant follow-up from the options below. Offer one clear transition, not a menu. Suggest ONLY these unless you are very confident another option is more useful:
- Add an account-specific overlay that separates confirmed deal evidence from defensive prep.
- Create an objections-only or positioning-only version for the immediate seller need.
- Prepare a meeting brief using the competitive risks and discovery questions.
- Draft a concise internal enablement or account-team update for review.
- Check whether a matching weekly automation already reruns this `build-competitive-brief` skill for the same competitor, product, category, or account scope; if none exists, offer to create one that gives the seller a reusable competitive digest.
- Close the smallest material competitive evidence gap.

Next steps to avoid:
- Sending, posting, or turning unsupported competitor claims into customer-facing assertions.

### Automation Offer Guard

For durable competitor, category, product, or account-specific competitive scopes, a weekly competitive digest is the preferred automation offer when the user would benefit from reusable field intelligence rather than a one-off battlecard. Frame the value in sales language: what changed in the competitive landscape, why buyers may care, where the seller can separate, what to say, what to clarify, and what not to overclaim.

The automation must be a scheduled rerun of this skill, not a separate custom research digest. When creating or describing the automation, make the prompt call this skill directly and preserve the same competitive scope and mode:

```text
Use the Sales `build-competitive-brief` skill.
Rerun it weekly for the same competitive scope: [competitor, product, workflow, category, segment, region, or account].
Return the standard competitive brief output, including source posture and landmines.

seller_company_name: "[seller company when known]"
product_scope: "[same product scope]"
workflow_scope: "[same workflow or buyer problem]"
competitor_scope: "[same competitor category or market category]"
competitor_names: [same named competitors when used]
account_name: "[same account when account-specific]"
mode: "[brief, objections, positioning, or account_overlay]"
known_objections: [same recurring objections when used]
```

For broad category or product scopes where named competitors are discovered by the skill, keep the stable scope in the plain-language prompt text and let this skill resolve likely competitors using its normal comparison-anchor guidance. Do not offer this automation for a narrow one-time objection, meeting-specific prep, or sparse evidence gap unless the user clearly wants a recurring competitive watch.

The recurring output should follow this skill's competitive brief contract: context, seller baseline, competitive landscape summary, competitor snapshots, comparison takeaways, response strategy, what not to overclaim, and sources. Keep it read-only; it may recommend talk tracks, discovery questions, proof, and internal updates for review, but must not post, send, share, or turn unsupported competitor claims into customer-facing assertions unless the user separately asks and approves.

Before offering the weekly competitive digest, check whether the user already has a matching local automation installed. Inspect local automation records under `$CODEX_HOME/automations/*/automation.toml`, or `~/.codex/automations/*/automation.toml` when `CODEX_HOME` is unset, and match by name, prompt, skill name, cadence, competitor, product, category, segment, account, mode, known objections, or other stable scope details. Treat active and paused matches as already installed.

- If a matching automation exists, do not suggest creating another one. Continue with the next most relevant non-automation follow-up.
- If no matching automation exists, end with one clear offer to check/create a weekly rerun of `build-competitive-brief` for the same scope. Describe the recurring output as a seller-ready competitive digest with what changed, why it matters, what to say, proof to use, and landmines to avoid. Do not create or update the automation until the user explicitly agrees.
- If the automation surface is unavailable, do not mention tool details; offer to help set up a recurring competitive digest when automations are available.

## Modes

- brief — default; canonical competitive brief, matrix, response guidance, and sources
- objections — buyer objections, proof points, discovery questions, talk tracks, and do-not-say guidance
- positioning — comparison framing, danger zones, differentiators, and response strategy
- account_overlay — account-specific implications, clearly separating confirmed deal evidence from defensive prep
- chat_or_markdown_only — same evidence contract without an HTML artifact, only when explicitly requested

## Output Format

For the HTML artifact and Markdown-only fallback, preserve this content contract:

```md
# [Seller] Competitive Brief

## Context
[Scope, buyer/account context, mode, and evidence posture]

## Seller Baseline
[Seller positioning and relevant proof]

## Competitive Landscape Summary
[What matters most and why]

## Competitor Snapshot
### [Competitor]
- **What they claim:** [Grounded claim]
- **What is confirmed:** [Evidence-backed fact]
- **Why buyers may care:** [Buyer appeal]
- **Where they win:** [Supported strength]
- **Where we can separate:** [Supported response]
- **Landmine / do not say:** [Overclaim to avoid]

## Comparison Matrix Takeaways
[Matrix plus the few implications that change seller behavior]

## Response Strategy
- **Say:** [Talk track]
- **Clarify:** [Discovery question]
- **Prove:** [Evidence]

## What Not To Overclaim
- [Uncertainty, conflict, or unsupported claim]

## Sources
- [Clickable source + what it supported]
- [Dependency category status and material gaps]

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

Add Account Implications for account_overlay, and label unsupported competitor presence as Defensive prep.

## Example Prompts

- `Build a competitive brief for MyCompany vs Competitor Alpha.`
- `Create a battlecard for MyCompany against Competitor Alpha and Competitor Beta in financial services.`
- `Compare MyCompany's enterprise workflow platform against the top three alternatives for regulated buyers.`
- `Build an account-specific defensive prep brief for ExampleCorp where Competitor Alpha may be in the deal.`
- `Create a shareable HTML competitive brief for MyCompany vs Competitor Alpha.`

## Rules

- Never fabricate competitor capabilities, pricing, customer proof, account posture, or source links.
- Keep facts, field signals, and inference visibly separate.
- If evidence is sparse, narrow the brief and name the smallest evidence gaps that would improve it.
- Do not post, send, share, or update systems from this workflow unless the user later explicitly requests a separate supported action.
- Always cite material source-backed claims with hyperlinks when useful links are available.
