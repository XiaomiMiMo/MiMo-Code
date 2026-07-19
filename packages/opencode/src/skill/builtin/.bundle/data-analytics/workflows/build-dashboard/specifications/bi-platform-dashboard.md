# BI Platform Dashboard Specification

Use this when the dashboard should live in a third-party or managed dashboard platform such as Tableau, Databricks dashboards, Looker, Power BI, Mode, or an managed BI surface. This surface is for long-lived, broadly shared dashboards with platform ownership, permissions, modeled data, refresh, and publishing.

Default to `~~presentation_surface` when the user is editing an existing BI platform dashboard or making a new dashboard that should be shared broadly in a BI platform.

Use `~~structured_data` before dashboard editing when you need to discover source tables, validate SQL, create query permalinks, or inspect sample rows through the relevant source connector when available.
Use `~~operations_logs` when you need to check partition freshness and lineage.

Preserve the user's requested audience, metrics, filters, data sources,
ownership, and publication target. Do not switch to MCP artifact or Streamlit unless the user explicitly wants an in-Codex artifact, prototype, local app, or surface that is unsuitable for the BI platform.

## BI Platform Defaults

- Keep the shared dashboard hierarchy: hero metrics first, then trend, then diagnosis, then detail.
- Use modeled production tables or views for dashboard queries. Do not finalize dashboards that depend on scratch or temporary tables.
- Use the BI platform's standard widgets by default. Let `~~presentation_surface` decide whether a classic dashboard tab, freeform tab, or platform specific layout is necessary.
- Report the dashboard, active draft or platform URL, and any unresolved permission, publishing, or sharing constraints in the handoff.
