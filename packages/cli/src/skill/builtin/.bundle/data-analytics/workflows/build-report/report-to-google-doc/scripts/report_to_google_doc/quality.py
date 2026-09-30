from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .constants import BAR_CHART_HEX_COLORS, DOC_CONTENT_WIDTH_PT, NEUTRAL_SVG_COLORS
from .table_utils import table_column_widths


def add_preflight_check(
    checks: list[dict[str, Any]],
    *,
    name: str,
    passed: bool,
    severity: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> None:
    checks.append(
        {
            "name": name,
            "status": "passed" if passed else "failed",
            "severity": severity,
            "message": message,
            "details": details or {},
        }
    )


def hex_to_rgb_tuple(value: str) -> tuple[int, int, int]:
    raw = value.strip().lstrip("#")
    return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16))


def is_expected_svg_mark_color(color: str) -> bool:
    normalized = color.lower()
    if normalized in BAR_CHART_HEX_COLORS:
        return True
    if normalized in NEUTRAL_SVG_COLORS:
        return False
    red, green, blue = hex_to_rgb_tuple(normalized)
    return max(red, green, blue) - min(red, green, blue) >= 45 and max(red, green, blue) < 245


def expected_chart_colors(chart: dict[str, Any]) -> list[tuple[int, int, int]]:
    """Return colors that prove the rendered PNG kept the source visual marks.

    This is intentionally conservative: it checks report-specific bar and
    positive/negative table colors, plus saturated SVG colors, but ignores text,
    gridline, and background colors that would let a broken chart pass.
    """
    kind = chart.get("kind")
    if kind == "bar_chart":
        return [hex_to_rgb_tuple("#1d4ed8" if chart.get("bar_color") == "blue" else "#0f766e")]
    if kind == "two_col_table_grid":
        has_positive = any(
            "positive" in cell_styles
            for panel in chart.get("panels", [])
            for row_styles in panel.get("cell_styles", [])
            for cell_styles in row_styles
        )
        has_negative = any(
            "negative" in cell_styles
            for panel in chart.get("panels", [])
            for row_styles in panel.get("cell_styles", [])
            for cell_styles in row_styles
        )
        colors: list[str] = []
        if has_positive:
            colors.append("#26845f")
        if has_negative:
            colors.append("#c75146")
        return [hex_to_rgb_tuple(color) for color in colors]
    if kind == "svg":
        markup = str(chart.get("svg_markup", "")).lower()
        return [
            hex_to_rgb_tuple(color)
            for color in sorted(set(re.findall(r"#[0-9a-f]{6}", markup)))
            if is_expected_svg_mark_color(color)
        ]
    return []


def image_pixels(image: Any) -> list[tuple[int, int, int]]:
    if hasattr(image, "get_flattened_data"):
        return list(image.get_flattened_data())
    return list(image.getdata())


def count_expected_color_hits(
    image: Any,
    expected_colors: list[tuple[int, int, int]],
    tolerance: int = 40,
) -> dict[str, int]:
    if not expected_colors:
        return {}

    color_hits = {"#%02x%02x%02x" % color: 0 for color in expected_colors}
    color_table = image.getcolors(maxcolors=image.size[0] * image.size[1])
    if color_table is None:
        pixel_iter = (
            image.get_flattened_data() if hasattr(image, "get_flattened_data") else image.getdata()
        )
        color_table = [(1, pixel) for pixel in pixel_iter]
    for count, pixel in color_table:
        for expected in expected_colors:
            if sum(abs(pixel[channel] - expected[channel]) for channel in range(3)) <= tolerance:
                color_hits["#%02x%02x%02x" % expected] += count
    return color_hits


def inspect_image_object(
    image: Any,
    expected_colors: list[tuple[int, int, int]],
    exact_color_scan: bool = False,
) -> dict[str, Any]:
    """Return cheap local evidence that a rendered image is usable in Docs."""
    from PIL import Image

    rgb_image = image.convert("RGB")
    width, height = rgb_image.size
    sample = rgb_image.resize((min(width, 160), min(height, 160)))
    pixels = image_pixels(sample)
    # Full-image color scans are expensive on large chart screenshots. Use
    # exact scans only for rendered table grids, where tiny red/green text is
    # easy to miss after downsampling.
    if exact_color_scan:
        color_image = rgb_image
    else:
        color_image = rgb_image.resize(
            (min(width, 160), min(height, 160)),
            getattr(Image, "Resampling", Image).NEAREST,
        )
    color_hits = count_expected_color_hits(color_image, expected_colors)

    total = max(1, len(pixels))
    extrema = sample.getextrema()
    uniform = all(channel_min == channel_max for channel_min, channel_max in extrema)
    non_white = sum(1 for r, g, b in pixels if min(r, g, b) < 245)
    non_white_ratio = non_white / total

    return {
        "width_px": width,
        "height_px": height,
        "uniform": uniform,
        "non_white_ratio": round(non_white_ratio, 4),
        "expected_color_hits": color_hits,
    }


def inspect_png(
    path: Path, expected_colors: list[tuple[int, int, int]], exact_color_scan: bool = False
) -> dict[str, Any]:
    try:
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - dependency check path
        raise RuntimeError("PNG preflight requires pillow") from exc

    with Image.open(path) as image:
        return inspect_image_object(image, expected_colors, exact_color_scan=exact_color_scan)


def build_preflight_checks(
    manifest: dict[str, Any],
    out_dir: Path,
) -> dict[str, Any]:
    """Build the local quality gate that must pass before Google Docs writes."""
    checks: list[dict[str, Any]] = []
    doc_width = DOC_CONTENT_WIDTH_PT

    add_preflight_check(
        checks,
        name="source_is_report_html",
        passed=not manifest.get("source_flags", {}).get("auth_page_detected", False),
        severity="error",
        message="Source HTML must be the report, not an auth/login page.",
    )

    source_two_col = manifest["counts"].get("two_col_source_blocks", 0)
    rendered_two_col = manifest["counts"].get("two_col_image_blocks", 0)
    text_two_col = manifest["counts"].get("two_col_text_blocks", 0)
    add_preflight_check(
        checks,
        name="two_col_blocks_preserved",
        passed=source_two_col == rendered_two_col + text_two_col,
        severity="error",
        message="Every source .two-col block should map to either one rendered multi-column block or preserved native text blocks.",
        details={
            "source_two_col_blocks": source_two_col,
            "rendered_two_col_blocks": rendered_two_col,
            "native_text_two_col_blocks": text_two_col,
        },
    )

    source_svgs = manifest["counts"].get("svgs", 0)
    rendered_svgs = manifest["counts"].get("svg_image_blocks", 0)
    add_preflight_check(
        checks,
        name="svg_blocks_preserved",
        passed=source_svgs == rendered_svgs,
        severity="error",
        message="Every source SVG visual should map to one rendered DOCX image.",
        details={"source_svgs": source_svgs, "rendered_svg_images": rendered_svgs},
    )

    source_bars = manifest["counts"].get("bar_source_blocks", 0)
    rendered_bars = manifest["counts"].get("bar_image_blocks", 0)
    table_bars = manifest["counts"].get("bar_table_blocks", 0)
    add_preflight_check(
        checks,
        name="bar_chart_blocks_preserved",
        passed=source_bars == rendered_bars + table_bars,
        severity="error",
        message="Every source bar-chart block should map to one rendered DOCX image or native table fallback.",
        details={
            "source_bar_blocks": source_bars,
            "rendered_bar_images": rendered_bars,
            "native_bar_tables": table_bars,
        },
    )

    for chart in manifest.get("chart_images", []):
        width = float(chart.get("docs_width_pt", doc_width))
        add_preflight_check(
            checks,
            name=f"{chart['id']}_width_cap",
            passed=width <= doc_width,
            severity="error",
            message="Rendered image width is capped to the report text column.",
            details={"docs_width_pt": width, "doc_width_pt": doc_width},
        )
        if chart.get("kind") == "two_col_table_grid":
            missing_titles = [
                idx
                for idx, panel in enumerate(chart.get("panels", []), start=1)
                if not str(panel.get("title", "")).strip()
            ]
            add_preflight_check(
                checks,
                name=f"{chart['id']}_panel_titles",
                passed=not missing_titles,
                severity="error",
                message="Rendered multi-column table panels preserve visible source titles.",
                details={"missing_title_panel_indices": missing_titles},
            )

        image_path = out_dir / chart["image_file"]
        add_preflight_check(
            checks,
            name=f"{chart['id']}_png_exists",
            passed=image_path.exists(),
            severity="error",
            message="Every chart placeholder has a rendered local PNG.",
            details={"image_file": chart["image_file"]},
        )
        if image_path.exists():
            try:
                stats = chart.get("render_preflight_stats") or inspect_png(
                    image_path,
                    expected_chart_colors(chart),
                    exact_color_scan=chart.get("kind") in {"two_col_table_grid", "svg"},
                )
                color_hits = stats.get("expected_color_hits", {})
                expected_colors_present = not color_hits or any(
                    count > 0 for count in color_hits.values()
                )
                add_preflight_check(
                    checks,
                    name=f"{chart['id']}_png_not_blank",
                    passed=not stats["uniform"] and stats["non_white_ratio"] > 0.002,
                    severity="error",
                    message="Rendered image is not blank or near-empty.",
                    details=stats,
                )
                add_preflight_check(
                    checks,
                    name=f"{chart['id']}_expected_colors_visible",
                    passed=expected_colors_present,
                    severity="error",
                    message="Expected chart/table colors are visible in the rendered PNG.",
                    details=stats,
                )
            except Exception as exc:
                add_preflight_check(
                    checks,
                    name=f"{chart['id']}_png_inspection",
                    passed=False,
                    severity="error",
                    message=f"Could not inspect rendered PNG: {exc}",
                    details={"image_file": chart["image_file"]},
                )

    table_width_failures: list[dict[str, Any]] = []
    for table in manifest.get("tables", []):
        rows = table.get("rows", [])
        if not rows:
            continue
        widths = table_column_widths(table, len(rows[0]))
        total = round(sum(widths), 1)
        if total > doc_width:
            table_width_failures.append(
                {"id": table["id"], "total_width_pt": total, "column_widths_pt": widths}
            )
    add_preflight_check(
        checks,
        name="native_table_width_cap",
        passed=not table_width_failures,
        severity="error",
        message="Native table column widths do not exceed the report text column.",
        details={"failures": table_width_failures},
    )

    image_size_failures = []
    for chart in manifest.get("chart_images", []):
        width = chart.get("docs_width_pt")
        height = chart.get("docs_height_pt")
        if width is None or height is None or float(width) > doc_width:
            image_size_failures.append({"id": chart.get("id"), "width": width, "height": height})
    add_preflight_check(
        checks,
        name="docx_images_have_explicit_sizes",
        passed=not image_size_failures,
        severity="error",
        message="DOCX image entries carry explicit text-width object sizes.",
        details={"failures": image_size_failures},
    )

    chart_count = len(manifest.get("chart_images", []))
    add_preflight_check(
        checks,
        name="docx_image_count_matches_manifest",
        passed=chart_count
        == len(
            [
                chart
                for chart in manifest.get("chart_images", [])
                if chart.get("image_file") and chart.get("docs_width_pt")
            ]
        ),
        severity="error",
        message="Every rendered image has the metadata needed for one DOCX image.",
        details={
            "manifest_chart_images": chart_count,
            "docx_image_entries": len(
                [
                    chart
                    for chart in manifest.get("chart_images", [])
                    if chart.get("image_file") and chart.get("docs_width_pt")
                ]
            ),
        },
    )

    errors = [
        check for check in checks if check["severity"] == "error" and check["status"] == "failed"
    ]
    warnings = [
        check for check in checks if check["severity"] == "warning" and check["status"] == "failed"
    ]
    return {
        "status": "failed" if errors else "passed",
        "doc_content_width_pt": doc_width,
        "summary": {
            "checks": len(checks),
            "errors": len(errors),
            "warnings": len(warnings),
            "tables": len(manifest.get("tables", [])),
            "chart_images": chart_count,
        },
        "errors": errors,
        "warnings": warnings,
        "checks": checks,
    }
