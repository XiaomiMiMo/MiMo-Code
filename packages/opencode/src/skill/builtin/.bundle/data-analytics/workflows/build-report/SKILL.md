---
name: build-report
description: "Build a durable analytical report with an answer-first narrative, evidence-backed findings, charts or tables, caveats, recommendations, and source context."
---

# Build an Analytical Report

Use this workflow when the user needs a durable report rather than a transient answer. Run the appropriate analysis workflow first; this workflow owns the reader-facing structure, evidence placement, visual/table placement, caveats, sources, QA, and handoff.

## Choose one delivery format

Honor an explicit format. Otherwise use:

1. Markdown for the most portable code-agent deliverable.
2. Self-contained plain HTML when a polished browser-readable report is useful and the host can render or inspect it.
3. PDF, DOCX, slides, or another format only when requested or clearly required by the destination and the host exposes suitable creation and verification tools.

Do not install or require React, Recharts, Vite, MCP Apps, or widget runtimes. HTML must use semantic HTML/CSS and may use inline SVG or small vanilla JavaScript interactions. It must remain readable without JavaScript.

## Build the report

1. Confirm the audience, decision, scope, comparison window, and requested format from available context. Ask only when a missing choice would materially change the result.
2. Verify the analytical evidence. Keep metric definitions, grain, time range, filters, units, exclusions, and source freshness explicit.
3. Lead with the answer. State the most important conclusion and decision implication before methodology details.
4. Build a coherent narrative rather than a dump of charts or query results.
5. Include only visuals and tables that support a finding. Read `../visualize-data/SKILL.md` when creating charts.
6. Distinguish verified facts, likely explanations, assumptions, limitations, and unresolved questions.
7. Provide recommendations tied to evidence, expected impact, owner or next action, and measurable follow-up where appropriate.
8. Add a source section that identifies real source systems, tables/views, datasets, files, documents, queries, and access dates when known. Never invent provenance.

## Recommended structure

```markdown
# [Short reader-facing title]

## Executive summary
[Answer, magnitude, and decision implication]

## Key findings
[Evidence-backed findings with charts or tables]

## Recommendations
[Prioritized actions and expected outcomes]

## Risks and limitations
[Data gaps, assumptions, uncertainty, and interpretation limits]

## Sources and methodology
[Definitions, scope, source details, and reproducibility notes]
```

Adapt the headings to the audience, but retain the answer-first logic.

## QA and handoff

- Recalculate headline values and comparisons from the reviewed evidence.
- Check that every claim is supported and every chart matches its source data.
- Check titles, labels, units, denominators, date ranges, and sorting.
- For HTML/PDF/DOCX/slides, render or inspect the actual artifact when the host supports it; fix clipping, blank charts, overflow, low contrast, and unreadable tables.
- Ensure the report contains no credentials, local temporary paths, placeholder provenance, or internal implementation noise.
- Return the primary artifact path plus only the relevant supporting notebook, SQL, data, or chart files.

If the user asks only for an inline brief or explicitly says no file/artifact, deliver the same answer-first structure concisely in chat.

