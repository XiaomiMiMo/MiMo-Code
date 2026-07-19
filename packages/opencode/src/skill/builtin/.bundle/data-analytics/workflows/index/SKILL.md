---
name: index
description: "Route broad Data Analytics requests to the appropriate quantitative analysis, visualization, dashboard, report, notebook, KPI, market-sizing, validation, or semantic-layer workflow."
---

# Data Analytics Router

Use this workflow when Data Analytics is explicitly invoked or the request requires structured records, quantitative evidence, metrics, or an evidence-backed product or business decision. Do not use it for ordinary prose drafting, file-format conversion, or qualitative description that does not require data interpretation.

## Choose the focused workflow

- Metric changed, missed a target, or differs from expectation: read `../metric-diagnostics/SKILL.md`.
- Product or business decision, prioritization, segmentation, launch, or experiment recommendation: read `../product-business-analysis/SKILL.md`.
- Dataset, dashboard, source, join, freshness, grain, or metric trust question: read `../analyze-data-quality/SKILL.md`.
- KPI framework, canonical definition, target, driver, or guardrail design: read `../design-kpis/SKILL.md`.
- KPI status update, WBR, MBR, QBR, or operating readout: read `../kpi-reporting/SKILL.md`.
- Dashboard or monitoring view: read `../build-dashboard/SKILL.md`.
- Durable analytical report: read `../build-report/SKILL.md`.
- Chart or quantitative figure: read `../visualize-data/SKILL.md`.
- Reproducible SQL/Python notebook: read `../jupyter-notebooks/SKILL.md`.
- TAM, SAM, SOM, segment, or opportunity sizing: read `../market-sizing/SKILL.md`.
- Review an analysis before sharing: read `../validate-data/SKILL.md`.
- Create, repair, or save reusable data context or a semantic layer: read `../create-data-context/SKILL.md`.
- Missing business definitions, ownership, change context, or decision framing: read `../gather-business-context/SKILL.md` before the primary workflow.

Load every selected workflow completely. Follow its related-skill rules when applicable. A task can combine workflows; use this usual order:

1. Gather missing business context.
2. Validate source quality and metric definitions.
3. Perform the focused analysis.
4. Validate conclusions.
5. Visualize or create the requested durable artifact.

## Source access

Use the best source already available through the code-agent harness: local files, uploaded data, pasted results, databases, warehouses, BI systems, product analytics tools, notebooks, documents, or callable connectors. Tool availability is determined by the host, not by this skill.

When no usable source is available:

- Ask for the smallest useful artifact: a CSV/XLSX file, query result, schema, metric definition, dashboard export, screenshot, or pasted table.
- Offer `assets/demo-product-growth.csv` only as a clearly labeled synthetic demonstration. Never use sample data to answer a real-data question.
- Do not invent records, measurements, source access, or query results.

If available sources conflict in a way that changes the answer, surface the conflict and use the data-quality workflow. Otherwise choose the most authoritative and fresh source and proceed.

## Portable output policy

This bundle targets a generic code agent and does not depend on React, MCP Apps, widgets, or a proprietary rendering surface.

- Inline answers: concise Markdown with findings, evidence, caveats, and next actions.
- Reports: Markdown by default; use self-contained plain HTML, PDF, DOCX, or another requested format only when the host can create and verify it.
- Charts: use reproducible Python/Matplotlib, notebook-native plotting, SVG, or destination-native chart tools.
- Dashboards: prefer a self-contained plain HTML/JavaScript artifact, Streamlit when Python execution is appropriate, or an existing BI platform selected by the user.
- Notebooks: keep SQL/Python reproducible and make assumptions visible.

Preserve source names, metric definitions, grain, time windows, filters, units, and uncertainty. Never expose credentials, secrets, hidden reasoning, or unnecessary personal data.

