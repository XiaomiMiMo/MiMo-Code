# Extraction And Output Rules

Use this reference after the skill has found or received transcript-like evidence. It owns the detailed quote extraction, speaker verification, ranking, output, and gap behavior for `find-customer-quotes`.

## Output format

Default: return a readable grouped summary (Markdown/plain text) that a human can scan quickly.

Use JSON only when:

- the user explicitly asks for JSON
- the results will be consumed downstream by another tool/workflow
- you need a machine-readable artifact for comparison/review

Readable summary should still preserve provenance and confidence, but in a compact format.

Minimum fields per quote:

- `theme`
- `quote` (verbatim)
- `speaker_name` (`"unknown"` if unavailable)
- `speaker_role_guess` (`customer`, `prospect`, `internal_seller`, `unknown`)
- `customer_confidence` (`0.0`-`1.0`)
- `theme_relevance` (`0.0`-`1.0`)
- `evidence` (brief reason the speaker is likely a customer and why the quote matches the theme)
  - `transcript_url` (the call or transcript link from the ~~Meeting Transcripts fetch response)

Strongly recommended extra fields when available:

- `call_date`
- `company`
- `call_title`
- `connector_file_id` (optional internal/debug field; useful for refetching with ~~Meeting Transcripts)
- `transcript_snippet` (short surrounding context, not a rewrite)

If a theme has insufficient high-confidence quotes, return fewer quotes and include a short gap note.

If no high-confidence customer/prospect quotes pass threshold but the reviewed transcript-like sources contain relevant internal, vendor-eval, partner-readiness, or implementation evidence, keep the customer quote count at zero and place those snippets only in a separate non-customer fallback section. Do not count fallback snippets toward the requested quote target or present them as customer/prospect language.

## Readable summary shape

Per theme, include:

- theme name
- number of quotes returned / target
- short one-line note on coverage quality, for example, `strong spread across 8 calls`
- quote list, each quote on its own bullet, with quote text, customer/company when available, speaker name when known, compact confidence, and a transcript link labeled `[Transcript]`

For readable summaries, do not print `speaker_role_guess` unless the user explicitly asks for role metadata or a quote needs an ambiguity caveat. Omit extra internal retrieval metadata unless the user asks.

Optional footer:

- `Gaps` section for themes with weak coverage
- `Internal / Non-Customer Evidence` section when no customer/prospect quotes pass threshold but relevant non-customer transcript evidence exists
- `Method notes` section if transcript formatting or speaker labeling quality reduced confidence

Fallback evidence section rules:

- Use a heading such as `Internal / Non-Customer Evidence`, never `Quote Candidates`.
- Include only verbatim snippets with strong theme relevance and enough surrounding context to explain why they are useful but excluded from the customer/prospect quote set.
- For each snippet, include speaker/context when known, `speaker_role_guess`, `customer_confidence`, `theme_relevance`, source link, and a usage note such as `Useful for an internal product brief; do not present as a customer quote`.
- Prefer a compact set of the strongest, most actionable snippets. Exclude garbled, bracket-reconstructed, or low-context fragments unless the uncertainty is essential and clearly noted.
- If high-confidence customer/prospect quotes exist, omit this fallback section unless the user explicitly asked for internal evidence too or the fallback materially explains a source gap.

## Candidate extraction

Run a theme-specific extraction pass over each transcript.

Goal:

- find verbatim quote candidates related to the theme
- identify whether the speaker is likely a customer/prospect
- preserve evidence and uncertainty

Important:

- Keep multiple quotes per call when they are distinct.
- Do not use a data structure keyed only by call id for quotes, because that collapses multiple valid quotes from the same call.
- Prefer a list of quote objects with a stable `quote_key`, such as `"{call_id}:{index}"` or `"{connector_file_id}:{index}"` when call id is unavailable.
- Candidate extraction may keep multiple quotes per call, but final exemplar selection should usually keep only one quote per call.

Include candidates that:

- directly express a pain point, blocker, constraint, concern, unmet need, or purchase condition
- are relevant to the theme
- are substantial enough to be useful, not generic praise
- appear to be spoken by an external participant or are ambiguous but promising

Exclude:

- obvious internal seller-side statements
- paraphrases that are not direct quotes unless the user explicitly asks for paraphrases
- concatenated or garbled fragments that combine multiple thoughts
- extremely short fragments with no clear meaning

## Speaker verification

Run a second pass over the extracted candidates with local transcript context.

For each candidate, provide:

- `speaker_role_guess`: `customer|prospect|internal_seller|unknown`
- `customer_confidence`: float `0-1`
- `evidence`: concise explanation grounded in transcript text/labels

Default threshold:

- Keep only `customer_confidence >= 0.8`
- Keep only `theme_relevance >= 0.75`

If fewer than `quotes_per_theme` remain, prefer returning fewer quotes over lowering `customer_confidence`. You may lower `theme_relevance` slightly, for example to `0.65`, if speaker evidence stays strong.

## Customer-likelihood heuristics

These heuristics improve precision. They are not substitutes for evidence.

Positive signals:

- Speaker labels or participant sections identify an external company contact.
- Quote uses customer-side operational constraints, such as procurement, legal, security review, compliance approval, budget ownership, or rollout blockers.
- Quote frames asks or needs from the seller, such as "we need", "we can't move forward without", "our team requires", or "this blocks procurement".
- Transcript context shows a seller asking a question and another speaker responding with the pain point.

Negative signals:

- Roadmap or launch language, such as "we shipped", "we can put that on the roadmap", or "our team is working on".
- Sales process language, such as pricing/packaging pitch, implementation promises, or next-step coordination without a customer pain point.
- Speaker labels indicate seller-side roles.

If no speaker labels and no clear contextual evidence exist, mark `speaker_role_guess="unknown"` and exclude from final exemplars unless the user explicitly asks for lower precision.

## Prompting pattern

Use two passes per theme.

Pass A: candidate extraction per transcript.

- Extract up to 2-4 verbatim quotes from this transcript relevant to the theme.
- Include quote text, tentative speaker role, theme relevance, and evidence.
- Favor recall, but exclude obvious internal quotes.

Pass B: cross-call verification and ranking per theme.

- Review all candidates for the theme.
- Re-check speaker classification using provided transcript context snippets.
- Deduplicate near-duplicates.
- Enforce call diversity, defaulting to one quote per call.
- Rank by customer confidence, theme relevance, specificity, and exemplar quality.
- Output top `quotes_per_theme` quotes, or fewer when evidence is weak.

When prompting, require verbatim quotes only, require an explicit `evidence` field, require abstention when uncertain, and instruct the model to prefer diversity across calls/customers when quality is similar.

## Deduplication and ranking

Apply deterministic filtering before final LLM ranking when possible:

- normalize whitespace and punctuation
- lowercase for comparison only
- drop exact duplicates
- drop quotes that are near-identical with trivial wording changes

Goal: maximize breadth of customer evidence, not just quote quality from a small number of calls.

Default final selection policy per theme:

- `1 quote per call` target
- `2 quotes per call` maximum
- use the second quote from the same call only if you cannot reach the requested `quotes_per_theme` with strong quotes from distinct calls, or if the second quote adds materially different evidence

When customer/account identity is available, also prefer breadth across customers:

- avoid stacking many quotes from the same customer unless coverage is sparse
- when two quotes are similar quality, choose the one that increases customer diversity

If you exceed one quote from a call, note it briefly in method notes.

Ranking priorities:

1. `customer_confidence`
2. `theme_relevance`
3. diversity across calls/customers
4. specificity/actionability of the pain point
5. clarity/readability while staying verbatim

Do not over-optimize for eloquence. A plain but specific customer blocker is better than a polished vague quote.

## Practical limits

Per theme defaults:

- search up to `20-40` calls
- fetch up to `10-20` transcripts initially
- extract up to `2-4` candidates per transcript
- verify/rank a pooled set of `20-50` candidates

If a theme is very broad:

- narrow search query before fetching more transcripts
- split into sub-themes only if the user asks

## Failure handling

Return structured gaps instead of failing the whole task.

Examples:

- no ~~Meeting Transcripts search results for theme
- search results exist but transcript fetch fails
- transcript content lacks enough speaker evidence
- enough relevant quotes found, but not enough high-confidence customer quotes

When gaps occur, include:

- `theme`
- `reason`
- `what was tried` (brief)
- `suggested next step`, such as widening the date range or lowering relevance threshold only

When the gap is `0` high-confidence customer/prospect quotes but relevant non-customer evidence exists, pair the gap with the fallback section above. Make the distinction explicit: `0/{target} customer/prospect quotes found; the evidence below is internal/vendor-eval/partner-readiness material and should not be used as customer quotes`.

## Suggested JSON shape

```json
{
  "results": [
    {
      "theme": "data residency",
      "quotes": [
        {
          "quote_key": "call-987654321:0",
          "quote": "We cannot roll this out until data stays in region for our EU users.",
          "speaker_name": "unknown",
          "speaker_role_guess": "customer",
          "customer_confidence": 0.93,
          "theme_relevance": 0.97,
          "evidence": "Quote describes the buyer's deployment blocker and references internal rollout constraints; no internal seller-side phrasing.",
          "transcript_url": "https://example.com/transcript/987654321"
        }
      ]
    }
  ],
  "gaps": [
    {
      "theme": "mobile application management",
      "reason": "Only 3 high-confidence customer quotes found",
      "what_was_tried": "Searched 32 calls, fetched 14 transcripts, lowered relevance threshold to 0.65 while keeping customer confidence >= 0.8",
      "suggested_next_step": "Widen date range or provide company/account segment filters"
    }
  ]
}
```

## Suggested readable shape

```md
Theme: api latency (10/10 quotes)
Coverage: Strong spread across 9 calls and 8 customers. 1 theme had repeated quotes from one call due to sparse alternatives.

- "..." - CustomerName (Speaker Name, customer_conf=0.99, relevance=0.98, [Transcript](https://example.com/transcript/123456789))
- "..." - CustomerName (Speaker Name, customer_conf=0.94, relevance=0.91, [Transcript](https://example.com/transcript/987654321))

Theme: deployment blockers (7/10 quotes)
Coverage: Good precision, lower volume.

- "..." - CustomerName (Speaker Name, customer_conf=0.99, relevance=1.00, [Transcript](https://example.com/transcript/555555555))

Gaps
- deployment blockers: Only 7 high-confidence customer/prospect quotes found after enforcing call diversity and confidence thresholds.

Theme: sales plugin setup friction (0/10 customer/prospect quotes)
Coverage: No high-confidence customer/prospect speakers found in the reviewed transcripts.

Gaps
- sales plugin setup friction: Reviewed transcript-like evidence, but speaker context was internal/vendor-eval rather than customer/prospect.

Internal / Non-Customer Evidence
- "The CRM needed reauthentication..." - Internal Speaker (speaker_role_guess=internal_seller, customer_conf=0.05, relevance=0.90, [Transcript](https://example.com/transcript/222222222)). Usage note: Useful for an internal product brief; do not present as a customer quote.
```

## Migration note

This skill intentionally improves on a common notebook pattern:

- Old pattern: join quotes to themes at the call level, then ask a model to filter.
- New pattern: retrieve transcripts per theme, extract quote candidates, then verify speaker role with evidence.

This produces better auditable exemplars and avoids collapsing multiple valid quotes from the same call.
