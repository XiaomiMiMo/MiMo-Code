---
name: build-dashboard
description: "Build a source-backed dashboard or monitoring view with clear metrics, filters, visual hierarchy, definitions, refresh context, and QA."
---

# Build a Dashboard

Use this workflow when the user needs a reusable monitoring or exploration surface rather than a one-time report. Read the relevant analysis and KPI workflows first when metric definitions or decision logic are not already settled.

## Select a portable surface

Honor the user's destination. Otherwise choose the simplest surface supported by the harness:

- Existing BI/product analytics platform when the user wants a governed shared dashboard there.
- Streamlit when Python execution and local/server operation are appropriate; read `specifications/streamlit-dashboard.md`.
- Self-contained plain HTML/CSS/vanilla JavaScript for a portable local dashboard; read `specifications/html-dashboard.md`.

Do not require React, Vite, Recharts, MCP Apps, or widget runtimes.

## Workflow

1. Define the audience, operating decision, monitoring cadence, and questions the dashboard must answer.
2. Define each metric: formula, numerator/denominator, unit, grain, time window, filters, exclusions, owner, source, and freshness expectation.
3. Validate joins, completeness, duplicates, missingness, comparability, and refresh status before presenting metrics as trustworthy.
4. Design the information hierarchy:
   - Overview and primary outcomes.
   - Drivers and diagnostic cuts.
   - Guardrails and risks.
   - Detail tables or drill-down paths.
5. Add only decision-relevant filters. Make default date ranges, segments, comparison periods, and filter state visible.
6. Use `../visualize-data/SKILL.md` for each chart and keep exact lookup values accessible in tables.
7. Show data freshness, source context, definitions, and material caveats in the dashboard.
8. Implement and test the real artifact with representative, empty, partial, and error states when feasible.

## QA and handoff

- Reconcile displayed totals and KPIs against reviewed source results.
- Test filters, date boundaries, sorting, responsive layout, and refresh behavior.
- Check chart labels, units, legends, accessibility, and table readability.
- Ensure the artifact does not expose secrets, credentials, unnecessary personal data, or temporary local paths.
- Deliver the dashboard artifact or governed platform link plus metric definitions, source/query files, refresh instructions, and known limitations.

