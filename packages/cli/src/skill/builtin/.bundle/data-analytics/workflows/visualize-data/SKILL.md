---
name: visualize-data
description: "Design, create, revise, or QA quantitative charts and figures for reports, dashboards, notebooks, slides, files, or inline analytical answers."
---

# Visualize Data

Create quantitative visuals that are analytically sound, immediately readable, and appropriate for their destination. Treat a chart as evidence for a takeaway, not decoration.

## Workflow

1. State the analytical question and intended takeaway.
2. Verify the data grain, measures, dimensions, units, missing values, filters, time window, sample size, and source.
3. Choose the chart family from the analytical relationship:
   - Change over ordered time: line or area chart.
   - Category comparison: bar chart.
   - Distribution: histogram, box plot, or density plot.
   - Relationship between numeric measures: scatter plot.
   - Composition: stacked bar/area; use pie only for a small set of meaningful parts.
   - Funnel progression: funnel or ordered bars with stage conversion.
   - Contribution to change: waterfall.
   - Exact lookup values: table, optionally with small bars or sparklines.
4. Define explicit encodings, sorting, aggregation, grouping, scales, labels, units, colors, annotations, and uncertainty treatment.
5. Render with the destination's native system when one is selected. Otherwise prefer reproducible Python/Matplotlib or SVG for files and inline artifacts. Notebook-native plotting is appropriate for notebooks.
6. Inspect the final output in context when the host provides image, browser, document, or notebook inspection.

Do not install or require React, Recharts, Vite, MCP widgets, or proprietary UI renderers. For self-contained HTML, use inline SVG/canvas or a static image plus semantic fallback data. Avoid remote scripts unless the user explicitly accepts the dependency.

## Visual quality

- Use an answer-oriented title and a subtitle only when it adds a distinct takeaway.
- Label axes and units; show legends or direct labels for every visible group.
- Use consistent scales for comparisons and avoid misleading truncated axes unless clearly justified.
- Prefer direct labeling and restrained color. Reserve semantic colors for meaning such as positive, warning, or negative states.
- Keep annotations selective and evidence-backed.
- Make dense charts readable through aggregation, faceting, filtering, or a table rather than shrinking text.
- Provide accessible contrast, text alternatives, and a data table when the destination supports them.
- Put provenance in a source note rather than cluttering the title.

## QA

- Recompute plotted values from the reviewed rows.
- Confirm the visual answers the stated question and does not imply unsupported causality.
- Check ordering, scales, labels, clipping, overlap, empty states, and small-screen behavior where relevant.
- Confirm the exported file opens and contains the expected marks and text.
- Preserve the code or notebook needed to reproduce the chart when the user needs an auditable artifact.

