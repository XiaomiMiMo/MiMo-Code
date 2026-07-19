---
name: get-rep-call-feedback
description: Use when the user wants evidence-backed coaching for one rep's calls, especially by comparing the rep with peer examples to identify repeatable best practices, specific upgrade moments, and practical next-call language.
---

# Get Rep Call Feedback


## Context-Gathering Intake

Whenever this skill asks for context, strongly prefer using the `answers-ask-user-input` skill and the `ask_user_input` tool over other tools such as `request_user_input`; otherwise ask directly in the conversation.

Turn grounded call evidence into practical coaching for one rep. This skill compares the target rep with relevant peer examples, extracts repeatable moves, and maps them to exact moments the target rep can improve. It owns the coaching readout only; it does not create scorecards, send feedback, post messages, or save coaching artifacts.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to `plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices`.

## Key Dependency Categories

These categories are particularly important for this workflow; use other sources only when they materially improve call selection or coaching context.

- [Blocking] ~~Meeting Transcripts for target and peer call search, summaries, transcript moments, speaker context, dates, companies, and clickable call links. It blocks the default live-source feedback path; explicit transcript-like call evidence already in context satisfies the need.
- ~~Knowledge & Files for user-provided or exported transcripts, call notes, manager examples, and prior coaching context

Transcript-like call evidence is required for behavioral claims. Manager notes, CRM outcomes, and generic impressions can shape focus, but cannot substitute for observed call evidence. If live transcripts are unavailable, continue from sufficiently detailed pasted or exported material and label the coverage limit.

## Reference Loading

`SKILL.md` owns the normal benchmarked-coaching loop and output format. Load references only when their extra detail matters:

- Use [references/call-transcripts-connector-playbook.md](references/call-transcripts-connector-playbook.md) when date-window conversion, attendee-filter limitations, threshold fallback, or sparse-result recovery needs more detail.
- Use [references/request-schema.yaml](references/request-schema.yaml) for structured input normalization.
- Use [references/source-priority.md](references/source-priority.md) when evidence quality is mixed.
- Use [references/output-contract.md](references/output-contract.md) when checking required sections or downstream compatibility.

## Terms

- **MAP:** mutual action plan, a shared customer-and-seller plan with owners, milestones, and dates.

## Workflow Guidance

### 1. Resolve the target and comparison set

- If neither a benchmarked target/comparison set nor a focused-coaching anchor is clear, ask the user via `ask_user_input()`. For a bare invocation such as “give me call feedback,” do not assume a target rep, peer set, or coaching focus; offer: `My calls compared with two relevant peers`, `A named rep compared with named peers`, and `Focused coaching on a supplied call set or theme`.
- If the user names only “my recent calls” without a peer basis or focused-coaching anchor, offer the same explicit choices before gathering deeper evidence. Do not infer a representative rep, peer set, or feedback mode from a fresh request.
- Require a target rep or clearly supplied target call set, plus transcript-like call evidence.
- For benchmarked feedback, prefer user-named peer reps. If peers are omitted, use named top performers only when the user explicitly asks for that comparison; otherwise ask for at least two peers or offer source-derived candidates after a bounded search.
- Accept an explicit coaching theme, call type, product focus, account, time window, audience, or requested depth when provided. Do not force optional scope.
- Use product focus only when the user requests it, the dataset mixes motions or products enough to make comparison noisy, or one grounded area is needed to find better exemplars. Choose one area or a small user-specified set from the user's wording or call evidence; never run placeholder-only product searches.
- If a required target, peer set, or supplied call-set anchor remains ambiguous after the user selects a lane, make at most three narrow source reads, offer up to five concrete candidates, and confirm any inferred anchor before gathering deeper evidence.
- If the user supplies transcripts, a clear target/peer/window for benchmarked feedback, or a clear target or call set plus a focused-coaching anchor, proceed without a setup detour.

### 2. Build a fair call sample

- Start with ~~Meeting Transcripts. Search by the rep's exact email or display name and convert relative windows to absolute dates before retrieval.
- Default to the trailing 30 days for the target and trailing 60 days for peers unless the user supplies a window; use the same user-specified window for both sides unless asked otherwise.
- Aim for at least 15 target calls and at least 15 peer calls total. Use about 15 per peer only when strict peer-by-peer benchmarking is requested.
- Keep the target and peer mix comparable by motion, segment, product focus, and topic when those dimensions are visible. Do not compare mostly discovery calls with mostly procurement calls without calling out the mismatch.
- Search summaries first. Use a few bounded query variations around the rep plus the requested motion or theme; lower thresholds or broaden the window only when it is likely to improve the sample.
- If the user provides a company or account, include it in the query text and any available structured filter; do not rely on structured filters alone.
- If targets are not met after a bounded pass, produce a limited feedback memo, state the shortfall, and name the next search that would improve confidence instead of padding the analysis.

### 3. Find peer exemplars and target moments

- Search for the moment, not just the meeting label: agenda control, discovery, value framing, objection handling, stakeholder mapping, pricing, security, procurement, next steps, or mutual action plan.
- Prefer peer moves repeated across multiple calls, or several strong moments in one clearly relevant call.
- Fetch only the calls needed to validate the pattern and show useful moments. For each fetched call, retain readable title/date/company context, motion, live link, connector-specific refetch handle for internal retrieval only, and three to eight observed moments.
- Tag evidence internally as Peer exemplar, Target strength, or Target opportunity.
- For each target opportunity, identify the exact moment, the peer move that fits it, and concrete language the rep could use next time.

### 4. Synthesize coaching without a scorecard

- Do not create a formal rubric, rating, ranking, or scorecard.
- Turn repeated peer behavior into a short best-practice list: what the peer does, why it works, one to three supporting peer examples, and a stealable line when the transcript supports one.
- Map those practices to specific target moments: “In this target call, when this happened, use this peer move; here is how it could sound.”
- Normally surface five to ten stealable peer moments and five to ten specific target upgrades; use fewer when the evidence does not support that many.
- Keep strengths visible alongside upgrades so the output is useful for coaching, not just critique.

### Next Step Options

After the first output, offer the most relevant follow-up from the options below. Offer one clear transition, not a menu. Suggest ONLY these unless you are very confident another option is more useful:
- Focus the coaching on one skill, motion, account, or call moment.
- Add a practical 30-day practice plan grounded in the observed opportunities.
- Draft a concise manager-to-rep or self-coaching note for review.
- Compare an additional bounded call set when it would improve confidence or find better exemplars.
- Turn the steal sheet into a reusable coaching document after review.

Next steps to avoid:
- Creating a scorecard, inferring performance or personality, or sending feedback automatically.

## Modes

- Benchmarked Feedback — default when target and peer evidence are available.
- Focused Coaching — use when the user names one theme, motion, account, or small call set.
- Limited Feedback — use when peer evidence, transcript depth, or comparable sample size is thin; clearly separate supported observations from coverage gaps.

## Output Format

Return these sections in order.

```md
# Call Feedback: [Target Rep]

## TL;DR

- [3-6 evidence-backed coaching takeaways]

## Dataset Coverage

- **Target calls reviewed:** [N; goal >=15]
- **Peer calls reviewed:** [N total; peers included; goal >=15]
- **Coverage window:** [Absolute target window] / [Absolute peer window]
- **Comparable mix:** [Motion, segment, product focus, or mismatch]
- **Confidence / limits:** [Shortfall, missing transcripts, or none material]

## Peer Exemplars: Stealable Moves

### [Behavior]

- **What they do:** [Observable move]
- **Why it works:** [Observable effect]
- **Examples:** [Readable call context + short excerpt + inline call link]
- **Stealable line:** “[Only transcript-supported language]”

## Target Rep: Specific Upgrade Opportunities

### [Upgrade]

- **Moment observed:** [Readable target call context + short excerpt + inline call link]
- **Peer exemplar move:** [Readable peer context + short excerpt + inline call link]
- **Apply it like this:** [Specific behavior and suggested language]

## Next-Call Steal Sheet

- [10-15 practical behaviors or example lines]

## Optional 30-Day Practice Plan

[Include only when requested.]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

## Example Prompts

- `Give feedback on a rep's calls.`
- `Give feedback on Jamie's last three discovery calls.`
- `Compare this rep's demo calls with strong peer examples and suggest coaching points.`
- `Review these transcripts for talk-listen balance, qualification, and next-step clarity.`

## Rules

- Ground every coaching claim in a call excerpt, transcript moment, or repeated observable pattern; never invent call content, outcomes, attendees, metrics, or deal context.
- Cite examples with readable title/date/company context and compact inline numbered Markdown links. Prefer live transcript or call URLs; never expose raw connector ids.
- Keep excerpts short, normally one to three lines and no more than 25 quoted words from one source.
- Use peer examples only when the call mix is reasonably comparable; state mismatches and lower confidence when it is not.
- If a useful call has no stable link, use readable context and say that no direct link was available.
- Keep recommendations behavior-based and immediately usable. Do not infer intent, personality, or performance from thin evidence.

## Failure Handling

If the target, peer set, or call evidence cannot be resolved, state the smallest missing input and offer concrete candidates when available. If evidence is sparse, return the limited memo with supported observations, explicit coverage gaps, and the next bounded search that would improve it.
