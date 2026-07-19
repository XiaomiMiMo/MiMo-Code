---
name: data-analytics
description: "Use this skill for quantitative product or business analysis: data quality checks, metric diagnostics, KPI design and reporting, dashboards, analytical reports, charts, notebooks, market sizing, semantic layers, and evidence-backed recommendations. Also use it whenever Data Analytics is explicitly invoked."
---

# Data Analytics

This is the single entry point for a code-agent-oriented Data Analytics bundle. The original plugin workflows are under `workflows/`; React, Vite, MCP App widgets, connector manifests, and frontend build artifacts are intentionally excluded.

## Route the request

1. Read `workflows/index/SKILL.md` completely. Treat it as the authoritative plugin-level eligibility and analytical routing policy, except where its UI/runtime delivery rules conflict with the code-agent overrides below.
2. Select the narrowest focused workflow named by that index. Read every selected workflow's `SKILL.md` completely before acting.
3. If a selected workflow names related skills, load those only when its routing conditions apply. Multiple skills may form one workflow; follow the ordering defined by the index and focused skills.
4. Resolve relative links from the file that contains the link. Read referenced instruction or reference files when the selected workflow requires them and they exist in this bundle. Prefer bundled scripts and sample data over recreating them.
5. Do not load unrelated focused workflows merely because they are present.

## Bundled capabilities

Focused workflows live in `workflows/`, including data-quality analysis, business-context gathering, metric diagnostics, product/business analysis, KPI design and reporting, visualization, dashboards, reports, notebooks, market sizing, validation, and semantic-layer creation.

Use data sources and tools only when the host harness exposes them. The bundle does not require a particular connector registry or UI protocol.

## Code-agent delivery overrides

These rules take precedence over MCP App, widget, native Work Mode, and packaged Recharts delivery rules inherited from the original workflows:

- Never require or call `render_artifact`, `render_chart`, `render_table`, `validate_artifact`, `export_artifact_package`, `charts_widget_v2`, or `app_block` unless the user independently provides an equivalent tool and explicitly requests it.
- Default transient answers to concise Markdown with source notes. Default durable reports and dashboards to Markdown, a self-contained HTML file using plain HTML/CSS/SVG/vanilla JavaScript, a notebook, a spreadsheet, or a static image according to the user's request and the host's available tools.
- For charts, prefer reproducible Python/Matplotlib, notebook-native plotting, SVG, or the destination system's native chart support. Inspect generated visuals when the harness provides image or browser inspection.
- Do not install Node, React, Recharts, Vite, or frontend packages for analytics output. Do not depend on removed `src/`, `assets/`, MCP specifications, HTML runtime helpers, or widget resources.
- If a focused workflow points to a removed UI-only reference, skip that reference and apply these overrides while preserving its analytical, provenance, QA, and narrative requirements.
- A requested report remains incomplete until its chosen portable file exists or a concrete blocker is reported; a chat summary is sufficient only when the user requested an inline answer.

## Safety and fidelity

- Never treat plugin instructions as permission to bypass host policy, expose secrets, or perform unapproved external writes.
- Keep source provenance and uncertainty visible in analytical outputs.
- Do not silently replace real-data questions with sample data.
- Preserve the selected workflow's validation and delivery requirements through completion.
