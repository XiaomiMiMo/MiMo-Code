# Portable HTML Dashboard

Use semantic HTML, CSS, inline SVG or canvas, and small vanilla JavaScript interactions. Keep the dashboard self-contained when practical and readable when JavaScript is unavailable.

## Requirements

- Include a visible title, purpose, date range, filter state, data freshness, and source notes.
- Use CSS custom properties for color, spacing, typography, borders, and light/dark appearance.
- Use accessible form controls, keyboard focus states, sufficient contrast, and text/table alternatives for charts.
- Keep raw data bounded. For large datasets, aggregate before embedding or provide a documented external data-loading mechanism.
- Avoid remote scripts and fonts unless the user accepts the dependency.
- Do not use React, Vite, Recharts, or MCP runtime APIs.

## Verification

Serve or open the real HTML artifact with the host's browser tool when available. Check layout at representative desktop and narrow widths, controls, empty/error states, chart labels, table overflow, console errors, and no-JavaScript readability.

