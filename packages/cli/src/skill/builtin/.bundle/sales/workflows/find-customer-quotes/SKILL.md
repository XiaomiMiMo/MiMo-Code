---
name: find-customer-quotes
description: "Use when the user wants verbatim customer or prospect quotes, voice-of-customer evidence, theme validation, objection evidence, product-friction examples, or support for a product area, use case, or sales narrative. Retrieve from transcripts, call notes, supplied transcript-like recordings or exports, and other grounded call material using explicit speaker-confidence and provenance rules."
---

# Find Customer Quotes


## Context-Gathering Intake

Whenever this skill asks for context, strongly prefer using the `answers-ask-user-input` skill and the `ask_user_input` tool over other tools such as `request_user_input`; otherwise ask directly in the conversation.

Extract high-confidence customer or prospect language from transcript-like evidence. This skill owns quote discovery, verification, selection, and readable provenance; it is not call analytics, paraphrase generation, legal review, or a posting workflow.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to `plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices`.

## Key Dependency Categories

Use the narrowest evidence lane that can support the requested quote set.

- [Blocking] ~~Meeting Transcripts for transcript search, fetched transcript text, speaker labels, participants, dates, companies, and source links. It blocks the default live-source quote-extraction path; explicit transcript-like material already in context satisfies the need.
- ~~CRM only for account identity, customer/prospect status, and company or segment filters that narrow transcript search
- ~~Knowledge & Files for uploaded or exported transcripts and grounded call notes that preserve direct language and speaker context

Transcript-like evidence is required. ~~CRM, account summaries, public research, internal notes, and memory can narrow scope but are never quote evidence. If no live or user-provided transcript-like material exists, ask for a transcript export, pasted transcript text, recording export with text, or grounded call notes.

## Reference Loading

`SKILL.md` owns the normal transcript-first path, thresholds, and readable output. Use [references/extraction-and-output.md](references/extraction-and-output.md) when transcript parsing is ambiguous, speaker-role confidence is hard to judge, quote ranking or deduplication needs the full rules, JSON is requested, or failure handling needs the exact response shape.

## Terms

- **Quote candidate:** a verbatim snippet that may be useful, but still needs speaker, context, and usage checks before being treated as customer evidence.
- **Customer confidence:** confidence that the speaker is actually a customer or prospect rather than an internal teammate, partner, or unknown speaker.
- **Fallback evidence:** relevant non-customer or lower-confidence material that may explain a gap but should not be presented as a customer quote.
- **Safe usage notes:** guidance on attribution, sensitivity, confidence, and where the quote can responsibly be reused.

## Workflow Guidance

### 1. Resolve theme and evidence scope

- If the theme or transcript-like evidence scope isn't clear, ask the user via `ask_user_input()`. For a bare invocation such as “Find customer quotes for me,” do not assume a theme or transcript set; offer:
  - `Use the most common blocker from recent Meeting Transcript evidence`
  - `Use a theme, objection, product area, or narrative I specify`
  - `Use a specific transcript or call set I provide`
- For a broad request such as “Find customer quotes about the most common blocker in my recent customer calls,” treat both the recommended theme and broad recent-call scope as a clarification case; offer:
  - `Use the blocker theme you recommend from recent Meeting Transcript evidence`
  - `Use a blocker theme I specify`
  - `Use a specific transcript or call set I provide`
  Do not search transcript evidence or draft a quote set until the user selects one.
- Require a feedback theme, objection, product area, use case, narrative, or a specific transcript set after that clarification. Preserve the user’s wording.
- Default to five quotes per theme. Process many themes in small batches.
- Normalize time windows: use explicit dates when supplied; treat “last month” as trailing 30 days unless the user says “last calendar month”; use calendar meaning for “last quarter” and trailing meaning for “last N days/weeks.”
- If a date phrase is too ambiguous to convert responsibly, ask one brief clarification unless the user clearly signals flexibility.
- For an ambiguous account, segment, or transcript set, make a bounded pass and offer up to five concrete candidates via `ask_user_input()`. Do not search transcript evidence or draft a quote set until the user selects one. Use ~~CRM only to resolve filters; do not gather CRM content as quote evidence.
- If a recent call-follow-up, pasted transcript, upload, or linked call clearly supplies the theme and evidence source, proceed without asking.

### 2. Search transcript evidence first

- Start with ~~Meeting Transcripts when available, using the theme plus one or two intent terms such as `pain point`, `blocker`, `request`, `limitation`, or `need`.
- Apply company, segment, and date filters only when the user supplied or confirmed them. Start with 10-15 results and a relevance threshold around 0.7.
- If the selected ~~Meeting Transcripts source exposes an account-segment filter with a known enum, use the connector-visible value that matches the user's wording.
- Do not invent additional user intent. If the user asks only for a theme, keep the query theme-centric.
- If sparse, simplify the query, lower relevance modestly to about 0.6, then expand toward 20-40 results only when coverage still needs it.
- Fetch the top-ranked transcripts first and expand only until enough high-confidence, diverse evidence exists or the first pass is clearly thin.
- For pasted, uploaded, or exported material, parse only transcript-like text that preserves enough speaker/context evidence to classify customer or prospect likelihood.
- Keep a mapping of theme, search-result metadata, fetched transcript content, connector-specific refetch handle, and call or transcript URL when available. Do not assume a fixed transcript schema; inspect the fetched shape and adapt.

### 3. Extract verbatim candidates

- Keep only direct, substantial language that expresses a pain point, blocker, constraint, concern, unmet need, request, purchase condition, or other theme-relevant signal.
- Keep wording verbatim. Do not clean up grammar, join fragments, or convert paraphrases into quotes.
- Exclude paraphrases that are not direct quotes unless the user explicitly asks for paraphrases. If requested, label them separately and never present them as verbatim quotes.
- Exclude obvious internal seller statements, generic praise, garbled fragments, and tiny snippets without usable meaning.
- Preserve transcript, call, date, company, speaker label, participant context, and source link when available.

### 4. Verify speaker and rank precisely

- For each candidate, inspect nearby transcript context and assign `speaker_role_guess` as `customer`, `prospect`, `internal_seller`, or `unknown`; `customer_confidence` from 0.0-1.0; `theme_relevance` from 0.0-1.0; and a concise evidence note.
- Keep only candidates with `customer_confidence >= 0.8` and `theme_relevance >= 0.75` by default.
- If coverage is thin, prefer fewer quotes over lowering customer confidence. You may lower theme relevance slightly, to about 0.65, only when speaker evidence remains strong.
- Rank by customer confidence, theme relevance, diversity across calls/customers, specificity/actionability, then readability while remaining verbatim.
- If no candidate passes the customer threshold, report `0/[target]` customer/prospect quotes. Do not backfill the main quote set with unknown or internal speakers.

### 5. Deduplicate and select exemplars

- Normalize whitespace and punctuation for comparison only; never alter displayed quote text.
- Drop exact and near-duplicate quotes.
- Default to one quote per call. Use a second quote from the same call only when it adds materially different evidence or is needed to reach the target with strong quotes.
- Prefer breadth across customers when identity is available.
- Keep relevant non-customer transcript snippets only in a separate fallback section, labeled by role such as `internal evidence`, `vendor-eval evidence`, `partner-readiness evidence`, or `unknown non-customer evidence`.

### Next Step Options

After the first output, offer the most relevant follow-up from the options below. Offer one clear transition, not a menu. Suggest ONLY these unless you are very confident another option is more useful:
- Search an adjacent or narrower theme to improve evidence coverage.
- Expand or tighten the transcript, account, segment, or time-window scope.
- Package the selected quotes into a business case, competitive brief, meeting prep, or evidence appendix.
- Draft a source-safe internal summary of what the quotes support and what they do not support.
- Close the smallest speaker-identity or transcript-quality gap.

Next steps to avoid:
- Paraphrasing quotes, presenting ambiguous speakers as customers, or implying legal or compliance approval.

## Modes

- `Theme Quote Set` — default; grouped readable Markdown for one or more themes.
- `Specific Transcript` — extract from user-named or supplied calls only.
- `JSON` — use only when the user explicitly asks for machine-readable output or a downstream workflow requires it.

## Output Format

Use readable Markdown by default.

```md
# Customer Quotes

## [Theme]

**Coverage:** [returned]/[target] high-confidence customer/prospect quotes · [spread/quality note]

- “[Verbatim quote]”
  - **Speaker:** [Name or Unknown] · **Customer confidence:** [0.00] · **Theme relevance:** [0.00]
  - **Context:** [Company/call/date when known]
  - **Why it fits:** [Concise transcript-grounded evidence note]
  - **Source:** [Clickable transcript/call link, or no useful link available]

## Gaps

- [Theme with weak coverage, speaker ambiguity, transcript quality issue, or missing evidence]

## Internal / Non-Customer Evidence

- “[Verbatim fallback snippet]”
  - **Speaker / context:** [Known context] · **Role:** [non-customer classification] · **Customer confidence:** [0.00] · **Theme relevance:** [0.00]
  - **Usage note:** Useful for [internal purpose]; do not present as a customer quote.
  - **Source:** [Link/label]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

Omit empty optional sections. When both high-confidence customer quotes and fallback evidence exist, include fallback evidence only if the user asked for it or it materially explains a gap.

Include compact Method Notes when search breadth, transcript formatting, repeated calls, or speaker-label quality lowered confidence. Keep each theme's coverage explicit even when the result is `0/[target]`.
Do not print `speaker_role_guess` in readable summaries unless the user explicitly asks for role metadata or a quote needs an ambiguity caveat.
Use clickable source links when available; otherwise say `no useful link available`.

## Example Prompts

- `Find customer quotes about a feedback theme.`
- `Find customer quotes about setup friction from recent enterprise calls.`
- `Pull prospect quotes about data residency from the last month of call notes.`
- `Find quotes that support the "faster account research" story from these transcripts.`

## Rules

- Do not fabricate or infer quote text, speaker names, titles, roles, companies, dates, transcript links, or call metadata.
- Do not treat every quote from a relevant call as relevant, or every relevant quote as customer-spoken.
- Do not treat missing speaker labels as high confidence unless surrounding context strongly establishes an external participant.
- Keep quotes verbatim and make provenance visible near each quote.
- Prefer precision, diversity, and honest gaps over a padded list.
- This workflow is not for exhaustive call analytics, exact speaker identity verification when transcripts lack evidence, or legal/compliance review.
- Keep this workflow read-only. Do not post, send, package, or save quotes unless the user explicitly asks in a later step.

## Failure Handling

If no transcript-like evidence is available, state that quote extraction cannot be grounded and ask for the smallest usable source. If transcript formatting is poor or speaker identity is ambiguous, return fewer quotes, name the limitation, and keep lower-confidence evidence out of the customer/prospect set.
