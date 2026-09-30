---
name: validate-data
description: "Validate whether an analysis is accurate, well-supported, and ready to share or use for a decision. Use when reviewing methodology, calculations, comparisons, visuals, caveats, or conclusions."
---
## Related Skills

Use $analyze-data-quality when validation depends on whether the underlying data is trustworthy, comparable, fresh, or at the right grain.

Use $product-business-analysis when the task asks for a recommendation or decision after the validation pass.

# Validate Data Analysis

Validate an analysis before it is shared with stakeholders. Focus on whether the question, data, methodology, calculations, visuals, claims, caveats, and recommendations are trustworthy enough for the stated audience and decision.
This skill is for analysis QA, not raw dataset profiling alone. When validation depends on dataset reliability checks such as freshness, grain, missingness,
duplicates, join coverage, or source mismatches, use $analyze-data-quality as a companion.

## Workflow

1. Inventory the artifact and claims.

   Identify the report, notebook, spreadsheet, SQL, dashboard, chart, pasted analysis, or recommendation being validated. Inspect source artifacts when a path, link, query, notebook, spreadsheet, or dashboard is referenced. Extract the main question, audience, decision, key claims, headline numbers, data sources, time windows, populations, filters, comparison baselines, and stated caveats. Verify that every metric or KPI requested by the user appears in the analysis or is explicitly marked unavailable, not applicable, or out of scope.

2. Validate the question, methodology, and assumptions.

   Confirm that the analysis answers the stated business or product question,
   not a nearby easier question. Check whether the population, eligibility rules, exclusions, sampling, metric definitions, formulas, units,
   denominators, timezones, cohorts, comparison periods, and baselines match the stakeholder decision. Flag hidden exclusions, inconsistent definitions,
   partial-period comparisons, and causal wording that lacks experimental or otherwise credible causal evidence.

3. Validate data selection and quality risks.

   Confirm that the chosen tables, files, dashboards, or extracts are appropriate and current enough for the decision. Check freshness or "as of"
   date, expected partitions, segment coverage, row/category completeness, null handling, deduplication, filter logic, join coverage, and source mismatches when those risks could change the conclusion. Use `~~structured_data` for source metadata, schema checks, sample rows, query history, or SQL spot checks through the relevant source connector when available. Use `~~operations_logs` for table freshness, lineage, or pipeline context.

4. Verify calculations and aggregations.

   Recompute the highest-impact numbers independently when possible. Check grain, subtotals, denominators, non-zero denominators, rate bases,
   period-over-period bases, weighted averages, units, currency, timezone handling, and whether mutually exclusive categories add to totals. For SQL,
   inspect join types, group-by grain, filters, distinct counts, and row counts before and after joins. Use $jupyter-notebooks or `~~spreadsheet_workspace`
   when the artifact itself is a notebook or spreadsheet, or when reproducible spot checks need code or formulas.

5. Test reasonableness and common analytical traps.

   Compare magnitudes against known dashboards, historical reports, prior analyses, finance sources, or expected product scale when possible. Investigate trend jumps, drops, flatlines, exact round numbers, 0% or 100% rates, segment shares that should sum to about 100%, and results that perfectly confirm the hypothesis without friction. Check edge cases such as empty segments, new entities, and boundary dates.

6. Review visuals and presentation integrity.

   Confirm that charts use appropriate chart types, scales, axes, intervals,
   titles, labels, units, ordering, annotations, color, and precision. Use
   $visualize-data for non-trivial chart review. For rendered reports,
   dashboards, slides, docs, PDFs, HTML, or other final artifacts, inspect the rendered output for broken charts, missing tables, clipped text, bad formatting, stale placeholders, and obvious layout issues. Check whether a quick reader could walk away with a misleading interpretation, especially from truncated axes, dual axes, 3D effects, inconsistent intervals, missing date ranges, or chart titles that overstate the data.

7. Evaluate narrative, conclusions, and recommendations.

   Confirm each conclusion is supported by visible evidence or saved artifacts.
   Separate verified findings from interpretation, caveats, and open questions.
   Identify alternative explanations, uncertainty, missing context,
   recommendations that go beyond the evidence, and any causal language that is not supported by the design.

8. Produce a confidence assessment and required fixes.

   Prioritize issues that materially affect the stakeholder decision. Separate blockers from caveats: do not block sharing for minor polish issues, but do block when a number, denominator, join, time window, population, comparison,
   or conclusion is materially unreliable. Record incomplete handoff blockers separately from caveats, including missing access, unavailable source artifacts, unrun checks, broken render steps, unresolved data-quality risks,
   or absent owner confirmation. If SQL, Python, a notebook, or a spreadsheet was used for validation, include the artifact path, query permalink, notebook path, spreadsheet tab, or dashboard link so the check is reproducible.

## Standards

### Validation Stance

- Validate the claims the analysis actually makes, not just whether the artifact looks polished.
- Prefer concrete evidence: recompute important numbers, inspect source data,
  check code paths, trace records, or reconcile against trusted sources when tools and access allow it.
- Label anything that cannot be verified, and state what would be needed to verify it.
- Treat surprising results, stakeholder-facing recommendations, causal claims,
  high-impact decisions, and externally shared analyses as higher-risk validation targets.
- Select checks that match the artifact and decision. Do not run every possible check mechanically.

### Methodology Checks

- Question framing: the analysis answers the stated business or product question.
- Data selection: sources are appropriate and current enough for the decision.
- Population: inclusions, exclusions, eligibility rules, and sampling are explicit.
- Metric definitions: formulas, units, denominators, and timezones are clear and aligned with stakeholder definitions.
- Baselines: comparison periods, cohorts, and contexts are comparable.
- Causality: causal wording is backed by experimental or otherwise credible causal evidence.

### Data Quality Checks

- Freshness: the analysis states or can recover the data "as of" date.
- Completeness: no unexpected missing partitions, segments, rows, or categories.
- Null handling: key columns have expected null rates or explicit treatment.
- Deduplication: primary entities are not double counted.
- Filter verification: filters and WHERE clauses do not silently exclude the population of interest.
- Join coverage: dimensions, experiments, and reference tables do not drop or multiply important rows.

### Calculation Checks

- Grain: the aggregation level matches the intended analysis grain.
- Denominators: rates and percentages use the correct population and non-zero denominators.
- Period alignment: comparisons use equal or explicitly caveated windows.
- Weighted metrics: averages are weighted correctly when group sizes differ.
- Subtotals: parts add to totals where categories are mutually exclusive.
- Units: currency, token, user, request, account, day/week/month, and timezone units are consistent.

### Reasonableness Checks

- Magnitudes are plausible relative to known dashboards, historical reports, or expected product scale.
- Percentages fall in expected ranges and segment shares sum to about 100% where expected.
- Trend jumps, drops, flatlines, exact round numbers, and 0% or 100% rates have an explanation.
- Results do not perfectly confirm the hypothesis without friction or exceptions.
- Edge cases such as empty segments, new entities, and boundary dates behave sensibly.

### Common Pitfalls

- Join explosion: many-to-many joins silently multiply rows and inflate counts or sums. Compare row counts and distinct primary entities before and after the join, and check whether the right-hand table has multiple rows per join key.
  Aggregate the right-hand table to the intended grain before joining when needed, use `COUNT(DISTINCT primary_id)` when counting entities through joins,
  and comment intentional one-to-many joins.
- Survivorship bias: the analysis only includes entities that exist today and misses deleted, churned, failed, or otherwise absent entities. Ask who is not in the dataset and whether the missing population changes the conclusion.
- Incomplete period comparison: a partial period is compared with a complete period. Use complete periods, compare the same number of elapsed days, or label the partial-period caveat prominently.
- Denominator shifting: the eligible population changes between periods or segments. Validate that conversion, churn, activation, attach, and retention rates use stable definitions across compared groups.
- Average of averages: pre-computed averages are averaged without weighting for group size. Aggregate from raw numerators and denominators or use a weighted average.
- Timezone mismatch: sources use different timestamp conventions or daily cutoffs. Confirm the analysis standardizes timestamps or explicitly states the timezone and cutoff.
- Selection bias in segmentation: segments are defined by the outcome being measured. Define comparison groups by pre-treatment characteristics when making lift, causality, or behavior-difference claims.
- Other statistical traps: Simpson's paradox where aggregate and segment-level trends conflict, correlation presented as causation, small samples,
  outlier-dominated averages that need medians or distribution views, multiple testing, cherry-picked time ranges, and look-ahead bias.

### Spot-Check Recipes

- Recompute a key metric from raw numerators and denominators.
- Trace a few individual records through joins, filters, and final output.
- Reconcile a key total against a trusted dashboard, prior report, or finance source.
- Reverse engineer a headline number from component metrics, such as users times per-user revenue.
- Run a one-day, one-segment, or one-entity boundary check to make sure filters and joins behave sensibly.
- Compare the same metric through an alternate query path when a claim is surprising or high stakes.

### Visualization Checks

- Bar charts should generally start at zero; waterfall, bridge, variance, and other delta-focused charts may use a non-zero or narrowed value axis when zero would materially compress the intended movement, provided exact values, units, and the focused scale are clear.
- Comparison charts should use consistent scales unless the scale difference is explicit and justified.
- Axes, units, legends, and date ranges should be labeled.
- Category ordering should match the comparison the reader should make.
- Truncated axes, dual axes, 3D effects, and inconsistent intervals require explicit justification or redesign.
- Chart titles and annotations should match exactly what the data supports.
- Titles should state the finding and include date range or scope when needed.
- Caveats should be visible near the claims they qualify.
- Number formatting should use appropriate precision and units.
- Rendered artifacts should be checked in their final form when available, not only in source form.

### Confidence Ratings

- `Ready to share`: The analysis is methodologically sound, key calculations are verified or low risk, caveats are clear, and any remaining issues are minor.
- `Share with caveats`: The analysis is directionally usable, but specific assumptions, limitations, or unverified checks must be communicated to stakeholders.
- `Needs revision`: There are material errors, unsupported claims, missing checks, or methodological issues that should be fixed before sharing.

### Output Standards

Use this structure unless the user asks for a lighter review:

```markdown
## Validation Report

### Overall Assessment: [Ready to share | Share with caveats | Needs revision]

### Methodology Review
[Findings about question framing, data selection, population, definitions, comparisons, and assumptions.]

### Issues Found
1. [Severity: High/Medium/Low] [Issue description, evidence, and impact]
2. ...

### Calculation Spot-Checks
- [Metric or claim]: [Verified / Discrepancy found / Not verified] - [brief evidence]

### Visualization Review
[Chart or presentation issues, if applicable.]

### Suggested Improvements
1. [Improvement and why it matters]

### Required Caveats for Stakeholders
- [Caveat that must be communicated]
```

- Include the question being answered, data sources and "as of" date, metric and segment definitions, time period and timezone, methodology steps, assumptions and limitations, SQL queries, notebook paths, spreadsheet tabs, dashboard links, or caveats required before acting when those details are relevant.
- Preserve source references from the original artifact, including links, query IDs, notebook paths, spreadsheet tabs, dashboard URLs, cited documents, and other evidence needed to trace the analysis.
- Verify that every section requested by the user or implied by the deliverable format is present; explain omitted sections.
- Keep issues prioritized by decision impact, not by artifact section order.
- Make unverified claims and remaining caveats explicit.
- List incomplete handoff blockers separately from caveats and suggested improvements.
