---
name: review-rep-call-trends
description: Use when the user wants to understand how a sales or customer-facing rep's call behavior is changing over time. Produce an evidence-backed trend readout with improvements, regressions, stable patterns, coaching actions, and calls to re-listen.
---

# Review Rep Call Trends


## Context-Gathering Intake

Whenever this skill asks for context, strongly prefer using the `answers-ask-user-input` skill and the `ask_user_input` tool over other tools such as `request_user_input`; otherwise ask directly in the conversation.

Turn a representative time-based call sample into objective coaching guidance. This skill compares older and newer call evidence to identify genuine improvement, regression, and stable patterns. It owns the readout only; it does not create trackers, send feedback, post messages, or save artifacts.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to `plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices`.

## Key Dependency Categories

These categories are particularly important for this workflow; use other sources only when they materially improve sampling or interpretation.

- [Blocking] ~~Meeting Transcripts for time-sliced call search, summaries, transcript moments, speaker context, dates, companies, and clickable call links. It blocks the default live-source trend path; explicit older/newer call evidence already in context satisfies the need.
- ~~Knowledge & Files for user-provided or exported transcripts, call summaries, manager-provided call sets, and prior coaching context

Call summaries or transcripts are required for trend claims. Manager notes, CRM outcomes, and generic impressions may provide context, but cannot substitute for older-versus-newer call evidence. If the sample is small or skewed, return a limited trend readout rather than overgeneralizing.

## Reference Loading

`SKILL.md` owns the normal time-sliced trend workflow and output format. Load references only when their extra detail matters:

- Use [references/request-schema.yaml](references/request-schema.yaml) for structured input normalization.
- Use [references/rubric.md](references/rubric.md) when the compact behavior categories are insufficient for classifying evidence, especially technical-success or meeting-craft signals.

## Workflow Guidance

### 1. Resolve the rep and comparison basis

- If the target rep or comparison basis is not clear, ask the user via `ask_user_input()`. For a bare invocation such as “review call trends,” do not assume a rep or time window; offer: `My calls over the default trailing 90 days`, `A named rep over the default trailing 90 days`, and `Supplied older/newer call sets or a custom window`.
- If the user names only “my call trends” without a comparison basis, offer the same explicit choices before broad retrieval. Do not infer a representative rep, comparison window, or trend-review mode from a fresh request.
- Require a target rep or clearly supplied target call set and a comparison basis: time window, older/newer sets, transcript set, call summaries, or explicit coaching dimension.
- After the user selects “my calls,” use the current user when available. For an ambiguous manager-style request, ask for the rep's exact display name or email before broad retrieval.
- If an attendee-filtered search returns zero results, try small grounded variations: first/last name only, then an obvious nickname when context supports it. If those still return zero, ask for the rep's exact display name in the selected ~~Meeting Transcripts source.
- After the user selects the default Trend Review path, use the trailing 90 days split into three non-overlapping slices: 0-30 days, 31-60 days, and 61-90 days. Convert every relative window to concrete absolute dates before searching.
- Preserve user-specified motion, product focus, account, coaching dimension, or audience. If a supplied date phrase could materially change the sample, ask one brief clarification.
- If the target remains ambiguous after the user selects a lane, make at most three narrow source reads, offer up to five concrete candidates, and confirm any inferred anchor before deeper analysis.

### 2. Collect summaries across time

- Start with ~~Meeting Transcripts and search each time slice separately. Use the rep's exact email or display name, a limit of about 25 per slice, and `score_threshold=0` when supported—or the lowest practical threshold—so the sample is not biased toward only “strong” calls.
- When the user names a focus such as discovery, demo, renewal, objections, or technical troubleshooting, use a short matching query. Otherwise use an empty or neutral query to avoid biasing the sample.
- Aim for 30-60 deduplicated calls when available, with a mix of call types and companies visible in summaries. If a slice is sparse, expand it once by about 30 days and state the adjustment.
- If there are hundreds of calls, prioritize the most recent calls plus a smaller older baseline while preserving visible call-type and company variety.
- Build the trend view from summaries first: date, company, title, topics, call link, and the retrieval handle kept only for fetching.
- Do not claim improvement or regression from a single recent call or from outcomes alone.

### 3. Compare supported behavior categories

- Compare the same categories across older and newer slices whenever possible.
- Use the core categories: opening/agenda, discovery depth, qualification/prioritization, positioning/narrative, objection handling, next steps and mutual action plan, technical accuracy, clarity/concision, executive presence, and listening/turn-taking.
- When the calls are technical or solution-oriented, use the rubric's additional categories for problem framing, diagnosis/troubleshooting, solution design/tradeoffs, and technical-plus-business stakeholder management.
- Prefer three to six categories with the clearest evidence. Mark mixed evidence as Inconsistent rather than forcing a trend.
- Call something Improved or Regressed only when the time comparison supports a directional shift. Use Stable for repeated patterns without clear movement.

### 4. Fetch a small validation set

- Fetch full context only where summaries are ambiguous, a trend needs validation, or a concrete coaching moment would help.
- Normally inspect one to two strong recent calls, one to two recent calls with friction, and one to two older baseline calls.
- Capture two to six brief moments: what happened, why it mattered, category, readable title/date/company context, and live link.
- Keep quotes short and use the full content to validate—not replace—the summary-level sample.

### 5. Turn trends into action

- Tie each improvement, regression, and stable pattern to evidence from the compared slices.
- Recommend exactly three coaching actions for the next two weeks. Each action needs a skill to practice, an if/then play, a five-to-ten-minute drill, and an observable check for the next calls.
- Select three to eight calls to re-listen to, favoring the clearest recent and baseline examples that explain the coaching priorities.

### Next Step Options

After the first output, offer the most relevant follow-up from the options below. Offer one clear transition, not a menu. Suggest ONLY these unless you are very confident another option is more useful:
- Drill into one improved, regressed, or inconsistent behavior category.
- Turn the top three actions into a two-week practice plan or coaching note for review.
- Compare a bounded peer-exemplar set for one coaching priority.
- Select and summarize the most useful calls to re-listen to.
- Set up a future trend refresh for the same rep, scope, and comparison basis.

Next steps to avoid:
- Making performance judgments from thin evidence or sending feedback automatically.

## Modes

- Trend Review — default trailing-window analysis.
- Focused Trend Review — use for a named motion, category, account set, or supplied older/newer calls.
- Limited Trend Readout — use when one slice, transcript depth, or sample balance is insufficient for confident movement claims.

## Output Format

Return these sections in order.

```md
# Rep Call Trends: [Target Rep]

## Coverage

- **Target rep:** [Name]
- **Window analyzed:** [Absolute start] -> [Absolute end]
- **Time slices:** [Older / middle / recent absolute ranges]
- **Calls reviewed:** [N summaries], [M full fetches]
- **Sample shape / limits:** [Mix, sparse slice, or confidence note]

## What Improved

- **[Behavior change]** — [Evidence from older vs newer readable call context + inline links] — [Why it matters]

## What Regressed / Risk Signals

- **[Behavior change]** — [Evidence from older vs newer readable call context + inline links] — [Why it matters]

## What Stayed Consistent

- **[Stable or inconsistent pattern]** — [Evidence + inline links]

## Top 3 Coaching Actions: Next 2 Weeks

1. **Practice:** [Skill]
   - **If / then:** [In-the-moment play]
   - **Quick drill:** [5-10 minute drill]
   - **Look for next:** [Observable signal]

## Calls to Re-Listen

- [Readable date, company, title + inline link] — [Why this call matters]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

## Example Prompts

- `Review a rep's call trends.`
- `Review Jamie's call trends over the last month.`
- `Compare this rep's recent discovery calls to their earlier calls and flag changes.`
- `Find improvement and regression patterns across this rep's demo calls.`

## Rules

- Do not invent calls, behavior, outcomes, metrics, quotes, dates, companies, or links.
- Every improvement or regression claim must compare older and newer evidence and cite at least one readable call link; do not turn anecdote into trend.
- Prefer explicit structure, questions, summaries, objections, and next steps over speculative interpretation. Do not infer intent or personality.
- Cite with readable title/date/company context and compact inline numbered Markdown links, such as `2026-03-24, ExampleCorp, Pilot & Pricing [1](https://example.com/call/123)`. Prefer live transcript or call URLs; never expose raw connector ids.
- When one statement is supported by multiple calls, append multiple numbered links inline.
- Keep excerpts short, normally no more than 25 quoted words from one source.
- If a useful call has no stable link, use readable context and say that no direct link was available.

## Failure Handling

If the target or comparison basis cannot be resolved, state the smallest missing input and offer concrete candidates when available. If the sample is sparse or uneven, produce the limited readout, name which movement claims are unsupported, and suggest the smallest additional call set or window that would improve confidence.
