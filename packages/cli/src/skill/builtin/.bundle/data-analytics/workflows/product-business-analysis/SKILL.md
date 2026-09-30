---
name: product-business-analysis
description: "Analyze product or business data to support a decision or recommendation. Use when a decision depends on metric-backed evidence, such as choosing a direction, prioritizing an opportunity, evaluating a change, segmenting users, sizing tradeoffs, or deciding what to do next."
---

## Related Skills

Use $metric-diagnostics when the recommendation depends on explaining a metric movement, anomaly, gap, or discrepancy.

# Product And Business Analysis

Use this skill to answer product or business questions with data-backed evidence, context, and a recommendation. Give the audience enough trustworthy evidence, interpretation, and uncertainty framing to choose a practical next action.

## Skill Configuration

### Source Discovery And Verification

Use the relevant semantic layer as a starting map, not a boundary.

1. **Explore all possible sources.** Search every connected or provided source that could contain task-relevant data or change the interpretation. Within each structured-data source, run fresh catalog or metadata discovery for relevant schemas, datasets, tables, views, models, and metrics. Known sources, tables, dashboards, and semantic mappings are starting points, not stopping points.
2. **Compare duplicates and conflicts.** When sources overlap or disagree, compare ownership, freshness, definition, grain, coverage, and directness. Use the best authoritative source, or combine complementary sources when needed. Note material conflicts, explain why the selected source or sources control the answer, and verify selected data through live reads before concluding.

### Source Access Guardrail

Before querying sources, building artifacts, or drawing conclusions, determine whether the answer requires a specific source of truth.

If a required source is unavailable, stop that path. Tell the user what source is needed, ask them to make it available or provide a reviewed fallback, and do not treat weaker substitutes as equivalent.

If the missing source is only optional enrichment, continue with the strongest available evidence and label the gap when it materially affects the answer.

Clarify with the user when a missing input would materially change the analytical frame or recommendation. Otherwise make a reasonable assumption, state it, and proceed.

## Workflow

### 1. Start From The Decision

Identify the decision, audience, and action the analysis should inform before choosing data sources or metrics.

State plainly:

- the question and decision the analysis should inform
- who will use the answer and what they can act on
- the scope and comparison that define a useful answer
- the outcome or behavior that matters for the decision
- any assumptions needed to proceed

Do not let unclear scope turn into broad exploratory work by default.

### 2. Gather Decision-Relevant Context

Run $gather-business-context before deeper analysis. That skill owns source selection, retrieval, source authority, conflict handling, and compact context notes. Use this workflow to decide how the gathered context changes the analysis and recommendation.

Keep the context pass proportional to the task. For self-contained prompts or cases where the user already provided enough context, the pass can be brief: confirm the decision frame, definitions, source assumptions, and any obvious gaps before moving on. Do not turn mandatory context gathering into a broad background scan.

Relevant context should clarify:

- intent: what the work was meant to accomplish and why
- definitions: how the work, metric, or source is defined and measured
- timing: what changed around the analysis period that could affect interpretation
- constraints: decisions, caveats, or limitations that affect what action is realistic

### 3. Frame The Analysis

Turn the question into a focused analytical framework.

Define a framework for answering the question with data:

- the specific data questions that would support or change the recommendation
- the comparisons and dimensions to inspect
- the unit of analysis that matches the decision
- the metric definitions and caveats needed to interpret the result

Use the framework to surface plausible hypotheses or interpretations, then turn them into focused data questions. Keep the framework specific enough to avoid broad exploration and support a recommendation.

Use $design-kpis when the success metric, driver metrics, guardrails, or measurement plan need to be defined before the analysis can proceed.

Start by defining what the answer needs to show in plain language. Then choose the data that matches that meaning as closely as possible, including who is counted and what comparison makes the number meaningful. If a field or event captures only part of what the decision cares about, say what it captures and what it leaves out.

### 4. Run Focused Quantitative Analysis

Run enough quantitative analysis to support or reject the framed hypotheses and inform the decision:

- **Follow the framework.** Run the analyses that could change the recommendation first. Track additional data questions that emerge, answer the ones that matter for the decision, and leave lower-impact cuts as follow-up instead of expanding into broad exploration.

- **Use the right comparison.** Interpret results against the relevant baseline, denominator, or comparison point before turning them into a recommendation. For example, do not conclude that one group is the best opportunity just because it has the most total usage. Check whether usage is high because the group is larger, whether the pattern still holds after normalizing by the active base, whether the group is growing or declining, whether the usage reflects the behavior or outcome that matters, and whether business context changes the interpretation.

- **Size the opportunities.** Estimate the magnitude of impact each important opportunity could have. State what is being compared, which metric represents impact, what denominator or population it uses, and whether the data is complete enough to trust. Keep material unknown or unclassified groups visible when they could change the interpretation.

- **Keep quantitative work inspectable.** Use $jupyter-notebooks to record queries and analysis. Use $analyze-data-quality when source freshness, grain, joins, missingness, schema drift, or unexpected distributions could affect trust.

- **Validate before concluding.** Use $validate-data before sharing stakeholder-facing recommendations, high-impact claims, or surprising results. When dashboards and direct queries both exist, reconcile them or explain why they differ.

### 5. Translate Evidence Into Decision Implications

Frame the findings within the broader business context. Do not present quantitative evidence and business context as two unrelated streams.

Interpret the evidence through the decision lenses that best fit the question. Choose lenses that would actually change the recommendation, and skip ones that would add noise or false precision. Common lenses include:

- **Current scale:** Is the opportunity or problem large enough today to matter for the decision?
- **Momentum:** Is the signal growing, shrinking, accelerating, or newly emerging?
- **Breadth:** Is the pattern broad-based, or does it only appear in a narrow corner of the business?
- **Concentration:** Does the conclusion depend on a few large entities, events, or outliers?
- **Intensity:** Is the behavior deep enough per unit to suggest real need, value, or risk?
- **Efficiency:** Does the option create better output, margin, conversion, productivity, or quality for the input required?
- **Addressability:** Can the team realistically act on this option with available product, GTM, operational, policy, or technical levers?
- **Differentiation:** Does this group or use case require a distinct motion, product experience, support model, or message?
- **Substitution:** Is there evidence that behavior, spend, time, or workload could shift from another path?
- **Risk or dependency:** Are there quality, trust, compliance, technical, operational, or data constraints that change the recommendation?
- **Coverage:** Are unknown, missing, or sparsely tagged records large enough to change the answer?

Use these as thinking tools, not a checklist. Explain why the chosen lenses matter for this decision, and mention omitted cuts only when they would plausibly change the interpretation or help explain the result.

Use the measured opportunities to explain which differences matter for the decision and which ones call for different actions. If the business context shows that the initial sizing misses the actionable part of the opportunity, add the focused sizing cut needed to make the recommendation useful.

If evidence conflicts, say so directly and explain which interpretation is better supported. Do not smooth over disagreement between sources.

### 6. Hand Off The Recommendation

End by handing the decision-ready recommendation to $build-report unless the user explicitly requests an inline, chat-only, brief/no-artifact answer, asks not to create a report/file/artifact, or selects another primary artifact. This handoff is mandatory when no explicit human waiver was given; do not infer a waiver because the user asked a direct question or did not use the word "report". This workflow owns the analytical conclusion; $build-report owns the reader-facing structure, visuals, evidence placement, and delivery surface.

Before handoff, make the recommendation explicit:

- what they should believe or do next
- why the evidence supports that recommendation
- which caveats or dependencies matter
- what follow-up analysis would most improve confidence

If evidence is incomplete, label the recommendation as provisional and state what would change confidence. Do not overstate the conclusion just to make the answer feel decisive.

Use $validate-data when methodology, calculations, caveats, or the evidentiary support for the conclusion need review before sharing.

Pass narrative ingredients to the report surface, not only result tables:

- direct answer and recommendation
- key evidence and how to interpret it
- implication for the decision
- unresolved uncertainty and caveats
- recommended follow-up
