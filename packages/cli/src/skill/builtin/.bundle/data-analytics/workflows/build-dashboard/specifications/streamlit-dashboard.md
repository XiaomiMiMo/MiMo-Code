# Streamlit Dashboard Specification

Build Streamlit dashboards as real apps: summary-first, interactive, and fast enough for repeated filter changes. Keep the result chart-led, simple to operate on first load, and clear about what the viewer should do next.

Use the shared `build-dashboard` brief first to lock the audience, KPI,
filters, and main questions the app should answer. This specification is for implementing the app once Streamlit is the chosen delivery mode.

## When To Use

- The user explicitly wants a Streamlit dashboard or app.
- The dashboard needs custom interactivity, stateful workflows, or reviewer-style controls.
- The solution needs Python-side transforms, file inputs, or multiple data sources.
- The user wants version-controlled app code rather than BI configuration.

Avoid Streamlit when the user explicitly wants an MCP artifact dashboard or a BI platform dashboard.

## Quick Start

1. Start from a clear dashboard brief: audience, primary KPI, default filters, and the key questions the app should answer.
2. Decide whether the deliverable is local-only code or a live shared app.
3. Default to one entrypoint and one page unless multiple pages clearly improve the workflow.
4. Run the app with `streamlit run ...` before treating the task as complete.

## Structure The App

Call `st.set_page_config(...)` near the top of the main entrypoint.

Keep the layout summary-first:

- Hero metrics or KPI cards first.
- Trend section next.
- Diagnostic breakdowns below that.
- Detailed tables or record-level views near the bottom or behind explicit drill-down actions.

Put global filters in the sidebar or a top control row. Keep one clear narrative per page before adding tabs or multipage navigation.

## Implement

Keep page code thin:

- Move data fetching, query code, and expensive transforms into helper functions or modules.
- Use `st.cache_data` only for deterministic reads or transforms.
- Keep `st.session_state` focused on UI state and user selections.
- Favor bounded default queries and lazy-load heavy detail views.
- Make loading, empty, and error states visible.
- Keep chart titles concise and labels explicit.

For charts and interactivity:

- Favor the simplest chart library that produces clear interactive charts.
- Choose chart and table renderers that match the runtime environment. Some Streamlit surfaces, such as Altair-backed charts and `st.dataframe(...)`, can pull in Arrow or `pyarrow` at render time. If the environment cannot reliably satisfy native Arrow dependencies, prefer Plotly for charts and simpler table surfaces such as `st.table(...)` or bounded HTML tables.
- Use KPI cards for headline values and charts below them for explanation.
- Keep number formatting consistent across axes, labels, legends, and tooltips.
- Prefer charts over text blocks, and prefer direct labels over long legends when practical.
- If the app adds new plotting or data-access dependencies, update the project's dependency declarations and confirm the app still installs and runs cleanly in the target environment before handoff.

## Making It Live

Do not assume deployment is part of the ask. Many Streamlit tasks only need local app code and a smoke-tested run command.

If the user wants a live shared app, identify all of the following before treating the app as done:

- Hosting target
- Auth model
- Network access to the data backend
- Secrets and environment variables
- Dependency installation path
- Start command

Keep local development commands and deployment assumptions explicit so another engineer can reproduce the app.

## Validate

Run the closest realistic smoke test:

1. Launch the app locally with `streamlit run path/to/app.py`.
2. Exercise the main filters, tabs, upload flows, or drill-down actions.
3. Confirm the default page state is useful before any clicks.
4. Confirm reruns do not raise runtime exceptions or trigger obviously wasteful reloads.
5. Check that the layout still reads clearly on desktop and narrower widths if the app will be shared broadly.
6. Verify loading, empty, and error states are understandable.

Do not stop at "the app booted." Validate at least one real chart render path and one detail or table render path, because renderer-specific dependency failures can appear only after the page starts drawing data-backed components.

When Streamlit UI behavior is hard to unit test, prefer validating extracted helper functions plus a local manual smoke test.
