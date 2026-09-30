from __future__ import annotations

import base64
import re
import shutil
import subprocess
from io import BytesIO
from pathlib import Path
from typing import Any

from .constants import DEFAULT_RENDER_WORKERS, DOC_CONTENT_WIDTH_PT
from .html_parser import inline_svg_report_styles
from .quality import expected_chart_colors, inspect_image_object
from .utils import collapse_ws


def svg_float(value: Any, default: float = 0.0) -> float:
    if value is None:
        return default
    match = re.search(r"-?[0-9]+(?:\.[0-9]+)?", str(value))
    return float(match.group(0)) if match else default


def parse_hex_color(
    value: Any, default: tuple[int, int, int] = (17, 24, 39)
) -> tuple[int, int, int] | None:
    if value is None:
        return default
    color = str(value).strip()
    if color in {"none", "transparent"}:
        return None
    if color.startswith("#"):
        raw = color[1:]
        if len(raw) == 3:
            raw = "".join(ch * 2 for ch in raw)
        if len(raw) == 6:
            return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16))
    return default


def color_with_opacity(color: tuple[int, int, int], opacity: Any) -> tuple[int, int, int]:
    alpha = svg_float(opacity, 1.0)
    alpha = max(0.0, min(1.0, alpha))
    return (
        round(255 * (1 - alpha) + color[0] * alpha),
        round(255 * (1 - alpha) + color[1] * alpha),
        round(255 * (1 - alpha) + color[2] * alpha),
    )


def svg_path_points(path_data: str) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for match in re.finditer(
        r"[ML]\s*(-?[0-9]+(?:\.[0-9]+)?)\s*,?\s*(-?[0-9]+(?:\.[0-9]+)?)",
        path_data,
        flags=re.IGNORECASE,
    ):
        points.append((float(match.group(1)), float(match.group(2))))
    return points


def load_svg_font(size: int, bold: bool = False) -> Any:
    try:
        from PIL import ImageFont
    except ImportError:  # pragma: no cover - dependency check path
        return None

    paths = []
    if bold:
        paths.extend(
            [
                "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            ]
        )
    paths.extend(
        [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/SFNS.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    )
    for path in paths:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def render_simple_svg_with_pillow(
    svg_markup: str, path: Path, width_px: int, height_px: int
) -> None:
    """Render the SVG subset produced by the report builders.

    This intentionally covers the report-chart primitives we commonly emit
    (`rect`, `path`, `polyline`, `polygon`, `circle`, `line`, and `text`) so
    conversions do not depend on visible browser automation or system Cairo libraries.
    """

    try:
        from bs4 import BeautifulSoup
        from PIL import Image, ImageDraw
    except ImportError as exc:  # pragma: no cover - dependency check path
        raise RuntimeError("Pillow SVG fallback requires beautifulsoup4 and pillow") from exc

    scale = 2
    soup = BeautifulSoup(inline_svg_report_styles(svg_markup), "xml")
    svg = soup.find("svg") or soup
    image = Image.new("RGB", (width_px * scale, height_px * scale), (255, 255, 255))
    draw = ImageDraw.Draw(image)

    def scaled_points_from_attribute(points_value: str) -> list[tuple[float, float]]:
        values = [
            float(value)
            for value in re.findall(r"-?[0-9]+(?:\.[0-9]+)?", points_value)
        ]
        return [
            (values[index] * scale, values[index + 1] * scale)
            for index in range(0, len(values) - 1, 2)
        ]

    for el in svg.find_all(True):
        if el.name == "rect":
            fill = parse_hex_color(el.get("fill"), (255, 255, 255))
            if fill is None:
                continue
            fill = color_with_opacity(fill, el.get("opacity"))
            x = svg_float(el.get("x")) * scale
            y = svg_float(el.get("y")) * scale
            w = svg_float(el.get("width"), width_px) * scale
            h = svg_float(el.get("height"), height_px) * scale
            radius = max(svg_float(el.get("rx")), svg_float(el.get("ry"))) * scale
            box = [x, y, x + w, y + h]
            if radius:
                draw.rounded_rectangle(box, radius=radius, fill=fill)
            else:
                draw.rectangle(box, fill=fill)
        elif el.name == "path":
            points = [(x * scale, y * scale) for x, y in svg_path_points(str(el.get("d") or ""))]
            if len(points) < 2:
                continue
            fill = parse_hex_color(el.get("fill"), None)
            if fill is not None and str(el.get("fill")).strip().lower() != "none":
                draw.polygon(points, fill=color_with_opacity(fill, el.get("opacity")))
            stroke = parse_hex_color(el.get("stroke"), None)
            if stroke is not None:
                width = max(1, round(svg_float(el.get("stroke-width"), 1) * scale))
                draw.line(points, fill=stroke, width=width, joint="curve")
        elif el.name == "circle":
            cx = svg_float(el.get("cx")) * scale
            cy = svg_float(el.get("cy")) * scale
            radius = svg_float(el.get("r")) * scale
            box = [cx - radius, cy - radius, cx + radius, cy + radius]
            fill = parse_hex_color(el.get("fill"), None)
            stroke = parse_hex_color(el.get("stroke"), None)
            width = max(1, round(svg_float(el.get("stroke-width"), 1) * scale))
            if fill is not None:
                draw.ellipse(box, fill=color_with_opacity(fill, el.get("opacity")))
            if stroke is not None:
                draw.ellipse(box, outline=stroke, width=width)
        elif el.name == "line":
            stroke = parse_hex_color(el.get("stroke"))
            if stroke is None:
                continue
            x1 = svg_float(el.get("x1")) * scale
            y1 = svg_float(el.get("y1")) * scale
            x2 = svg_float(el.get("x2")) * scale
            y2 = svg_float(el.get("y2")) * scale
            width = max(1, round(svg_float(el.get("stroke-width"), 1) * scale))
            draw.line([x1, y1, x2, y2], fill=stroke, width=width)
            if el.get("stroke-linecap") == "round":
                radius = width / 2
                for x, y in [(x1, y1), (x2, y2)]:
                    draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=stroke)
        elif el.name in {"polyline", "polygon"}:
            points = scaled_points_from_attribute(str(el.get("points") or ""))
            if len(points) < 2:
                continue
            fill = parse_hex_color(el.get("fill"), None)
            if el.name == "polygon" and fill is not None:
                draw.polygon(points, fill=color_with_opacity(fill, el.get("opacity")))
            stroke = parse_hex_color(el.get("stroke"), None)
            if stroke is not None:
                width = max(1, round(svg_float(el.get("stroke-width"), 1) * scale))
                line_points = points + [points[0]] if el.name == "polygon" else points
                draw.line(line_points, fill=stroke, width=width, joint="curve")
        elif el.name == "text":
            text = collapse_ws(el.get_text("", strip=True)).strip()
            if not text:
                continue
            fill = parse_hex_color(el.get("fill"))
            if fill is None:
                continue
            size = max(1, round(svg_float(el.get("font-size"), 12) * scale))
            weight = svg_float(el.get("font-weight"), 400)
            font = load_svg_font(size, bold=weight >= 600)
            anchor = {"middle": "ms", "end": "rs"}.get(str(el.get("text-anchor", "")).strip(), "ls")
            draw.text(
                (svg_float(el.get("x")) * scale, svg_float(el.get("y")) * scale),
                text,
                fill=fill,
                font=font,
                anchor=anchor,
            )

    image.save(path, optimize=True)


def load_report_font(size: int, bold: bool = False) -> Any:
    try:
        from PIL import ImageFont
    except ImportError:  # pragma: no cover - dependency check path
        return None

    paths = []
    if bold:
        paths.extend(
            [
                "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            ]
        )
    paths.extend(
        [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/SFNS.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    )
    for path in paths:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_right_aligned_text(
    draw: Any, xy: tuple[int, int], text: str, font: Any, fill: Any
) -> None:
    bbox = draw.textbbox((0, 0), text, font=font)
    draw.text((xy[0] - (bbox[2] - bbox[0]), xy[1]), text, font=font, fill=fill)


def render_two_col_table_grid(chart: dict[str, Any], path: Path) -> None:
    try:
        from PIL import Image, ImageDraw
    except ImportError as exc:  # pragma: no cover - dependency check path
        raise RuntimeError("Two-column table rendering requires pillow") from exc

    scale = 2
    css_w = 920
    gap = 20
    pad_x = 18
    pad_y = 4
    panel_count = max(1, len(chart["panels"]))
    panel_w = (css_w - gap * (panel_count - 1) - pad_x * 2) / panel_count
    title_h = 28
    header_h = 32
    row_h = 34
    panel_heights = [
        title_h + header_h + max(0, len(panel["rows"]) - 1) * row_h for panel in chart["panels"]
    ]
    css_h = pad_y * 2 + max(panel_heights)
    image = Image.new("RGB", (css_w * scale, css_h * scale), (255, 255, 255))
    draw = ImageDraw.Draw(image)

    ink = (32, 37, 43)
    muted = (98, 109, 121)
    faint = (229, 234, 239)
    green = (38, 132, 95)
    red = (199, 81, 70)

    title_font = load_report_font(13 * scale, bold=True)
    header_font = load_report_font(13 * scale, bold=True)
    body_font = load_report_font(13 * scale)
    body_bold_font = load_report_font(13 * scale, bold=True)

    def sx(value: float) -> int:
        return round(value * scale)

    for panel_idx, panel in enumerate(chart["panels"]):
        x0 = pad_x + panel_idx * (panel_w + gap)
        y0 = pad_y
        rows = panel["rows"]
        styles = panel.get("cell_styles", [[[] for _ in row] for row in rows])
        title = str(panel.get("title") or "").upper()
        draw.text((sx(x0), sx(y0 + 2)), title, font=title_font, fill=muted)

        table_y = y0 + title_h
        col_widths = [panel_w * 0.40, panel_w * 0.20, panel_w * 0.20, panel_w * 0.20]
        col_lefts = [x0]
        for width in col_widths[:-1]:
            col_lefts.append(col_lefts[-1] + width)
        table_right = x0 + sum(col_widths)

        for r, row in enumerate(rows):
            row_top = table_y + (0 if r == 0 else header_h + (r - 1) * row_h)
            current_h = header_h if r == 0 else row_h
            line_y = row_top + current_h
            draw.line((sx(x0), sx(line_y), sx(table_right), sx(line_y)), fill=faint, width=scale)
            for c, text in enumerate(row):
                cell_styles = set(styles[r][c]) if r < len(styles) and c < len(styles[r]) else set()
                is_numeric = c > 0
                color = muted if r == 0 else ink
                if "positive" in cell_styles:
                    color = green
                elif "negative" in cell_styles:
                    color = red
                font = header_font if r == 0 or "bold" in cell_styles else body_font
                if "positive" in cell_styles or "negative" in cell_styles:
                    font = body_bold_font
                y_text = row_top + (8 if r == 0 else 9)
                if is_numeric:
                    draw_right_aligned_text(
                        draw,
                        (sx(col_lefts[c] + col_widths[c] - 7), sx(y_text)),
                        text,
                        font,
                        color,
                    )
                else:
                    draw.text((sx(col_lefts[c] + 7), sx(y_text)), text, font=font, fill=color)

    image.save(path, optimize=True)
    chart["image_width_px"] = css_w * scale
    chart["image_height_px"] = css_h * scale
    chart["docs_width_pt"] = DOC_CONTENT_WIDTH_PT
    chart["docs_height_pt"] = round(DOC_CONTENT_WIDTH_PT * css_h / css_w, 1)
    chart["render_preflight_stats"] = inspect_image_object(
        image,
        expected_chart_colors(chart),
        exact_color_scan=True,
    )


def load_bar_chart_font() -> Any:
    try:
        from PIL import ImageFont
    except ImportError as exc:  # pragma: no cover - dependency check path
        raise RuntimeError("Bar chart rendering requires pillow") from exc

    for font_path in [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]:
        if Path(font_path).exists():
            return ImageFont.truetype(font_path, 28)
    return ImageFont.load_default()


def png_is_blank_or_near_empty(candidate: Path) -> bool:
    try:
        from PIL import Image
    except ImportError:
        return False
    try:
        with Image.open(candidate) as image:
            rgb_image = image.convert("RGB")
            if hasattr(rgb_image, "get_flattened_data"):
                pixels = list(rgb_image.get_flattened_data())
            else:
                pixels = list(rgb_image.getdata())
    except Exception:
        return True
    if not pixels:
        return True
    sample = pixels[: min(len(pixels), 10000)]
    if len(set(sample)) <= 1 and len(set(pixels)) <= 1:
        return True
    non_white = sum(1 for red, green, blue in pixels if min(red, green, blue) < 245)
    return non_white / len(pixels) < 0.002


def render_svg_chart_image(chart: dict[str, Any], out_dir: Path) -> None:
    image_dir = out_dir / "chart_images"
    path = out_dir / chart["image_file"]
    svg_markup = chart["svg_markup"].encode("utf-8")
    try:
        import cairosvg  # type: ignore[import-not-found]

        cairosvg.svg2png(bytestring=svg_markup, write_to=str(path))
    except Exception:
        rsvg_convert = shutil.which("rsvg-convert")
        if rsvg_convert:
            subprocess.run(
                [rsvg_convert, "-f", "png", "-o", str(path)],
                input=svg_markup,
                check=True,
            )
        else:
            width_px = int(chart.get("source_width_px", 1000))
            height_px = int(chart.get("source_height_px", 600))
            try:
                render_simple_svg_with_pillow(chart["svg_markup"], path, width_px, height_px)
            except Exception:
                pass
    if path.exists() and png_is_blank_or_near_empty(path):
        path.unlink()
    if not path.exists():
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:  # pragma: no cover - dependency check path
            raise SystemExit(
                "SVG chart rendering requires cairosvg, rsvg-convert, or "
                "python playwright with an installed Chromium browser; the "
                "built-in Pillow fallback could not render this SVG."
            ) from exc
        width_px = int(chart.get("source_width_px", 1000))
        height_px = int(chart.get("source_height_px", 600))
        tmp_html = image_dir / f"{chart['id'].lower()}_render.html"
        tmp_html.write_text(
            "<!doctype html><meta charset='utf-8'>"
            "<style>body{margin:0;background:white}svg{display:block}</style>"
            + chart["svg_markup"],
            encoding="utf-8",
        )
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(
                viewport={"width": width_px, "height": height_px},
                device_scale_factor=2,
            )
            page.goto(tmp_html.resolve().as_uri())
            page.locator("svg").screenshot(path=str(path))
            browser.close()
        tmp_html.unlink(missing_ok=True)
    chart["image_width_px"] = chart.get("source_width_px", 1000)
    chart["image_height_px"] = chart.get("source_height_px", 600)


def render_bar_chart_image(chart: dict[str, Any], out_dir: Path) -> None:
    try:
        from PIL import Image, ImageDraw
    except ImportError as exc:  # pragma: no cover - dependency check path
        raise RuntimeError("Bar chart rendering requires pillow") from exc

    css_w = 760
    label_w = 92
    value_w = 84
    gap = 12
    track_w = css_w - label_w - value_w - 2 * gap
    row_h = 28
    chart_gap = 10
    pad_y = 6
    scale = 2
    ink = (23, 32, 38)
    track = (232, 238, 241)
    accent = (15, 118, 110)
    blue = (29, 78, 216)
    font = load_bar_chart_font()

    rows = chart["rows"]
    width = css_w * scale
    height = (pad_y * 2 + len(rows) * row_h + (len(rows) - 1) * chart_gap) * scale
    image = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    fill_color = blue if chart.get("bar_color") == "blue" else accent
    radius = 6 * scale

    for idx, row in enumerate(rows):
        y = (pad_y + idx * (row_h + chart_gap)) * scale
        draw.text((0, y - 2 * scale), row["label"], font=font, fill=ink)
        track_x = (label_w + gap) * scale
        track_y = y + 5 * scale
        track_width = track_w * scale
        track_height = 18 * scale
        draw.rounded_rectangle(
            [track_x, track_y, track_x + track_width, track_y + track_height],
            radius=radius,
            fill=track,
        )
        fill_width = max(0, min(track_width, track_width * float(row["pct"]) / 100.0))
        draw.rounded_rectangle(
            [track_x, track_y, track_x + fill_width, track_y + track_height],
            radius=radius,
            fill=fill_color,
        )
        bbox = draw.textbbox((0, 0), row["value"], font=font)
        value_width = bbox[2] - bbox[0]
        value_x = (label_w + gap + track_w + gap + value_w) * scale - value_width
        draw.text((value_x, y - 2 * scale), row["value"], font=font, fill=ink)

    path = out_dir / chart["image_file"]
    image.save(path, optimize=True)
    chart["image_width_px"] = width
    chart["image_height_px"] = height
    chart["docs_width_pt"] = DOC_CONTENT_WIDTH_PT
    chart["docs_height_pt"] = round(DOC_CONTENT_WIDTH_PT * height / width, 1)
    chart["render_preflight_stats"] = inspect_image_object(image, expected_chart_colors(chart))


def render_embedded_image(chart: dict[str, Any], out_dir: Path) -> None:
    try:
        from PIL import Image, ImageOps
    except ImportError as exc:  # pragma: no cover - dependency check path
        raise RuntimeError("Embedded image rendering requires pillow") from exc

    src = str(chart.get("src") or "")
    match = re.match(r"data:image/[^;]+;base64,(.+)", src, flags=re.DOTALL)
    if not match:
        raise RuntimeError("Only base64 data URI report images are supported")

    raw = base64.b64decode(re.sub(r"\s+", "", match.group(1)), validate=False)
    path = out_dir / chart["image_file"]
    with Image.open(BytesIO(raw)) as image:
        image = ImageOps.exif_transpose(image)
        if image.mode == "RGBA":
            background = Image.new("RGB", image.size, (255, 255, 255))
            background.paste(image, mask=image.getchannel("A"))
            image = background
        elif image.mode != "RGB":
            image = image.convert("RGB")
        width, height = image.size
        image.save(path, format="PNG", optimize=True)
        chart["image_width_px"] = width
        chart["image_height_px"] = height
        chart["docs_width_pt"] = DOC_CONTENT_WIDTH_PT
        chart["docs_height_pt"] = round(DOC_CONTENT_WIDTH_PT * height / width, 1) if width else 240
        chart["render_preflight_stats"] = inspect_image_object(image, expected_chart_colors(chart))


def render_single_chart_image(chart: dict[str, Any], out_dir: Path) -> None:
    kind = chart.get("kind")
    if kind == "two_col_table_grid":
        render_two_col_table_grid(chart, out_dir / chart["image_file"])
    elif kind == "svg":
        render_svg_chart_image(chart, out_dir)
    elif kind == "bar_chart":
        render_bar_chart_image(chart, out_dir)
    elif kind == "embedded_image":
        render_embedded_image(chart, out_dir)
    else:
        raise RuntimeError(f"Unsupported chart image kind: {kind}")


def choose_render_workers(charts: list[dict[str, Any]], requested_workers: int) -> int:
    """Pick a conservative local render worker count.

    The renderer mix matters more than CPU count. SVG-only reports spend most
    of their time inside external/native renderers, so modest concurrency is a
    meaningful speedup. Pillow-heavy reports stay serial by default because the
    extra thread overhead is less predictably useful for those small images.
    """
    if not charts:
        return 1
    requested = int(requested_workers)
    if requested > 0:
        return min(requested, len(charts))
    if all(chart.get("kind") == "svg" for chart in charts):
        return min(6, len(charts))
    return 1


def render_chart_images(
    manifest: dict[str, Any], out_dir: Path, render_workers: int = DEFAULT_RENDER_WORKERS
) -> None:
    """Render every visual block before any remote Docs write happens.

    The output PNGs are the quality boundary for charts and multi-column table
    groups. Rendering them in parallel is safe because each chart writes to a
    distinct filename and the manifest order is preserved for Docs insertion.
    """
    charts = manifest.get("chart_images", [])
    if not charts:
        return

    needs_pillow = any(
        chart.get("kind") in {"bar_chart", "embedded_image", "two_col_table_grid"}
        for chart in charts
    )
    if needs_pillow:
        try:
            __import__("PIL.Image")
        except ImportError as exc:  # pragma: no cover - dependency check path
            raise SystemExit(
                "Bar chart-image mode requires Pillow. Install pillow or rerun with "
                "`--chart-mode table` to use the old native-table approximation."
            ) from exc

    image_dir = out_dir / "chart_images"
    image_dir.mkdir(parents=True, exist_ok=True)

    workers = choose_render_workers(charts, render_workers)
    if workers == 1 or len(charts) == 1:
        for chart in charts:
            render_single_chart_image(chart, out_dir)
        return

    from concurrent.futures import ThreadPoolExecutor, as_completed

    with ThreadPoolExecutor(max_workers=min(workers, len(charts))) as executor:
        futures = {
            executor.submit(render_single_chart_image, chart, out_dir): chart for chart in charts
        }
        for future in as_completed(futures):
            chart = futures[future]
            try:
                future.result()
            except Exception as exc:
                raise RuntimeError(f"Failed to render {chart.get('id')}: {exc}") from exc
