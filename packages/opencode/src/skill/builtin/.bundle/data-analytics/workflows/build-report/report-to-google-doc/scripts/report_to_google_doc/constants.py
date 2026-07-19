from __future__ import annotations

INK = {"red": 0.0902, "green": 0.1255, "blue": 0.1490}
MUTED = {"red": 0.3216, "green": 0.3804, "blue": 0.4196}
SOFT_BG = {"red": 0.9529, "green": 0.9647, "blue": 0.9725}
HEADER_BG = {"red": 0.9686, "green": 0.9765, "blue": 0.9804}
ACCENT = {"red": 0.0588, "green": 0.4627, "blue": 0.4314}
BLUE = {"red": 0.1137, "green": 0.3059, "blue": 0.8471}
WARN = {"red": 0.6039, "green": 0.2039, "blue": 0.0706}
WARN_BG = {"red": 1.0, "green": 0.9686, "blue": 0.9294}
NEGATIVE = {"red": 0.8118, "green": 0.1333, "blue": 0.1804}
POSITIVE = {"red": 0.1020, "green": 0.4863, "blue": 0.2157}
DOCX_MARGIN_IN = 0.7
DOC_CONTENT_WIDTH_PT = 511.2
CHART_SPACE_ABOVE_PT = 8
CHART_SPACE_BELOW_PT = 10
DEFAULT_RENDER_WORKERS = 0
BAR_CHART_HEX_COLORS = {
    "#2f7276",
    "#a7b0ba",
    "#26845f",
    "#c75146",
    "#1d4ed8",
    "#0f766e",
}
NEUTRAL_SVG_COLORS = {
    "#111827",
    "#20252b",
    "#374151",
    "#455a64",
    "#4b5563",
    "#626d79",
    "#6b7280",
    "#d1d5db",
    "#d9dee5",
    "#e5e7eb",
    "#eef1f4",
    "#f3f4f6",
    "#f8fafc",
    "#f9fafb",
    "#ffffff",
}

SVG_REPORT_STYLE_DEFAULTS: dict[str, dict[str, str]] = {
    # These mirror the sanitized report CSS chart tokens. The helper stores SVG
    # markup separately from the page stylesheet, so class-based styles must be
    # materialized before rendering through Cairo, rsvg, Pillow, or Playwright.
    "grid": {"stroke": "#eef1f4", "stroke-width": "1"},
    "axis": {"stroke": "#d9dee5", "stroke-width": "1.2"},
    "connector": {"stroke": "#d9dee5", "stroke-width": "1.2", "stroke-dasharray": "4 4"},
    "axis-label": {"fill": "#626d79", "font-size": "13"},
    "x-label": {"fill": "#626d79", "font-size": "13"},
    "legend": {"fill": "#626d79", "font-size": "13"},
    "bar-label": {"fill": "#20252b", "font-size": "13", "font-weight": "650"},
    "reason-label": {"fill": "#20252b", "font-size": "12"},
    "bar-main": {"fill": "#2f7276"},
    "bar-muted": {"fill": "#a7b0ba"},
    "bar-total": {"fill": "#a7b0ba"},
    "bar-positive": {"fill": "#26845f"},
    "bar-negative": {"fill": "#c75146"},
}
