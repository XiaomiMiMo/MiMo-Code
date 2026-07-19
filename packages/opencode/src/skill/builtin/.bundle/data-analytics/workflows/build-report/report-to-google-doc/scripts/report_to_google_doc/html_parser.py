from __future__ import annotations

import re
from pathlib import Path
from typing import Any

try:
    from bs4 import BeautifulSoup, NavigableString, Tag
except ImportError as exc:  # pragma: no cover - dependency check path
    BeautifulSoup = NavigableString = Tag = None  # type: ignore[assignment,misc]
    BS4_IMPORT_ERROR = exc
else:
    BS4_IMPORT_ERROR = None

from .constants import DOC_CONTENT_WIDTH_PT, SVG_REPORT_STYLE_DEFAULTS
from .model import Builder
from .utils import collapse_ws

FONT_WEIGHT_BOLD_RE = re.compile(r"font-weight\s*:\s*([^;}\s]+)", re.IGNORECASE)
CSS_RULE_RE = re.compile(r"([^{}]+)\{([^{}]*)\}", re.DOTALL)


def require_bs4() -> None:
    if BS4_IMPORT_ERROR is not None:
        raise SystemExit(
            "This helper requires beautifulsoup4. Install it in the active Python "
            "environment before running this helper."
        ) from BS4_IMPORT_ERROR


def append_text(builder: Builder, text: str) -> None:
    text = collapse_ws(text)
    if not text:
        return
    if text.isspace():
        if builder.offset and not builder.text().endswith((" ", "\n")):
            builder.add(" ")
        return
    if builder.offset and not builder.text().endswith((" ", "\n")) and text[0] not in " .,;:!?)%]":
        builder.add(" ")
    builder.add(text)


def classes(node: Tag) -> set[str]:
    raw = node.get("class") or []
    return set(raw if isinstance(raw, list) else str(raw).split())


def direct_tag_children(node: Tag) -> list[Tag]:
    return [child for child in node.children if isinstance(child, Tag)]


def direct_children_with_class(node: Tag, class_name: str) -> list[Tag]:
    return [child for child in direct_tag_children(node) if class_name in classes(child)]


def font_weight_is_bold(value: str) -> bool:
    value = value.strip().lower()
    if value in {"bold", "bolder"}:
        return True
    try:
        return int(value) >= 600
    except ValueError:
        return False


def inline_style_is_bold(style: str | None) -> bool:
    if not style:
        return False
    match = FONT_WEIGHT_BOLD_RE.search(style)
    return bool(match and font_weight_is_bold(match.group(1)))


def table_first_column_is_bold(raw_html: str) -> bool:
    accepted_selectors = {
        "td:first-child",
        "td:nth-child(1)",
        "tbody td:first-child",
        "tbody td:nth-child(1)",
        "table td:first-child",
        "table td:nth-child(1)",
        "table tbody td:first-child",
        "table tbody td:nth-child(1)",
    }
    for selectors, body in CSS_RULE_RE.findall(raw_html):
        weight = FONT_WEIGHT_BOLD_RE.search(body)
        if not weight or not font_weight_is_bold(weight.group(1)):
            continue
        normalized_selectors = {
            re.sub(r"\s+", " ", selector.strip().lower()) for selector in selectors.split(",")
        }
        if normalized_selectors & accepted_selectors:
            return True
    return False


def append_inline(builder: Builder, node: Tag | NavigableString) -> None:
    if isinstance(node, NavigableString):
        append_text(builder, str(node))
        return
    if not isinstance(node, Tag):
        return

    before = builder.offset
    for child in node.children:
        append_inline(builder, child)
    after = builder.offset
    if after <= before:
        return

    tag_classes = classes(node)
    styles: list[str] = []
    if node.name in {"strong", "b"}:
        styles.append("bold")
    if node.name in {"em", "i"}:
        styles.append("italic")
    if node.name == "code":
        styles.append("code")
    if "positive" in tag_classes:
        styles.append("positive")
    if "negative" in tag_classes:
        styles.append("negative")
    if node.name == "a" and node.get("href"):
        styles.append("link")

    for style in styles:
        entry: dict[str, Any] = {
            "start": before,
            "end": after,
            "style": style,
            "text": builder.text()[before:after],
        }
        if style == "link":
            entry["url"] = node["href"]
        builder.inline_styles.append(entry)


def add_paragraph(builder: Builder, node: Tag, block_type: str | None = None) -> None:
    start = builder.offset
    append_inline(builder, node)
    end = builder.offset
    if end > start:
        builder.add("\n")
        if block_type:
            builder.blocks.append({"start": start, "end": end + 1, "type": block_type})


def add_heading(builder: Builder, node: Tag) -> None:
    start = builder.offset
    append_inline(builder, node)
    end = builder.offset
    level = int(node.name[1]) if node.name and node.name[1:].isdigit() else 2
    builder.add("\n")
    builder.headings.append(
        {"start": start, "end": end, "level": level, "text": builder.text()[start:end]}
    )


def cell_text_styles_and_links(
    cell: Tag, first_column_bold: bool = False
) -> tuple[str, list[str], list[dict[str, Any]]]:
    local_builder = Builder()
    append_inline(local_builder, cell)
    raw_text = local_builder.text()
    leading_trim = len(raw_text) - len(raw_text.lstrip())
    text = raw_text.strip()
    styles = []
    if cell.find(["strong", "b"]) or cell.name == "th" or inline_style_is_bold(cell.get("style")):
        styles.append("bold")
    if first_column_bold and cell.name == "td" and "bold" not in styles:
        styles.append("bold")
    if cell.find("code"):
        styles.append("code")
    cell_classes = classes(cell)
    if "positive" in cell_classes or "pos" in cell_classes or "strong" in cell_classes:
        styles.append("positive")
    if "negative" in cell_classes or "neg" in cell_classes or "weak" in cell_classes:
        styles.append("negative")
    if "neutral" in cell_classes:
        styles.append("neutral")
    links = []
    for style in local_builder.inline_styles:
        if style.get("style") != "link":
            continue
        start = max(0, style["start"] - leading_trim)
        end = min(len(text), style["end"] - leading_trim)
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        if start >= end:
            continue
        links.append(
            {
                "start": start,
                "end": end,
                "url": style["url"],
                "text": text[start:end],
            }
        )
    return text, styles, links


def table_from_html(
    node: Tag,
    first_column_bold: bool = False,
) -> tuple[list[list[str]], list[list[list[str]]], list[list[list[dict[str, Any]]]]]:
    rows: list[list[str]] = []
    styles: list[list[list[str]]] = []
    links: list[list[list[dict[str, Any]]]] = []
    for tr in node.find_all("tr"):
        row: list[str] = []
        style_row: list[list[str]] = []
        link_row: list[list[dict[str, Any]]] = []
        for cell_index, cell in enumerate(tr.find_all(["th", "td"], recursive=False)):
            text, cell_styles, cell_links = cell_text_styles_and_links(
                cell, first_column_bold=first_column_bold and cell_index == 0
            )
            row.append(text)
            style_row.append(cell_styles)
            link_row.append(cell_links)
        if row:
            rows.append(row)
            styles.append(style_row)
            links.append(link_row)
    return rows, styles, links


def panel_has_only_heading_and_table(panel: Tag) -> bool:
    """Return true when a two-col panel can be safely replaced by a table image."""

    table = panel.find("table")
    if not isinstance(table, Tag):
        return False

    table_text = collapse_ws(table.get_text(" ", strip=True)).strip()
    for child in direct_tag_children(panel):
        if child.name in {"h2", "h3", "h4", "h5", "h6"}:
            continue
        if child is table:
            continue
        if child.find("table"):
            child_text = collapse_ws(child.get_text(" ", strip=True)).strip()
            if child_text == table_text:
                continue
        if collapse_ws(child.get_text(" ", strip=True)).strip():
            return False
    return True


def two_col_can_render_as_table_grid(node: Tag) -> bool:
    panels = direct_tag_children(node)
    return bool(panels) and all(panel_has_only_heading_and_table(panel) for panel in panels)


def add_two_col_layout(builder: Builder, node: Tag) -> None:
    panels: list[dict[str, Any]] = []
    for child in node.find_all(recursive=False):
        if not isinstance(child, Tag):
            continue
        table = child.find("table")
        if not isinstance(table, Tag):
            continue
        title_node = child.find(["h2", "h3", "h4", "h5", "h6"])
        title = collapse_ws(title_node.get_text(" ", strip=True) if title_node else "").strip()
        rows, styles, _links = table_from_html(table, first_column_bold=False)
        if rows:
            panels.append({"title": title, "rows": rows, "cell_styles": styles})

    if not panels:
        return

    builder.chart_counter += 1
    chart_id = f"CHART_IMAGE_{builder.chart_counter:02d}"
    placeholder = f"[[{chart_id}]]"
    start, end = builder.add(placeholder)
    builder.add("\n\n")
    image_file = f"chart_images/{chart_id.lower()}.png"
    builder.chart_images.append(
        {
            "id": chart_id,
            "kind": "two_col_table_grid",
            "panels": panels,
            "placeholder": placeholder,
            "placeholder_start": start,
            "placeholder_end": end,
            "image_file": image_file,
            "docs_width_pt": DOC_CONTENT_WIDTH_PT,
        }
    )
    builder.placeholders.append(
        {
            "id": chart_id,
            "kind": "chart_image",
            "text_to_find": placeholder,
            "start": start,
            "end": end,
        }
    )


def add_table_placeholder(
    builder: Builder,
    kind: str,
    rows: list[list[str]],
    styles: list[list[list[str]]] | None = None,
    links: list[list[list[dict[str, Any]]]] | None = None,
    bar_color: str | None = None,
) -> None:
    if not rows:
        return
    builder.table_counter += 1
    table_id = f"{kind.upper()}_{builder.table_counter:02d}"
    placeholder = f"[[{table_id}]]"
    start, end = builder.add(placeholder)
    builder.add("\n\n")
    table = {
        "id": table_id,
        "kind": kind,
        "rows": rows,
        "cell_styles": styles or [[[] for _ in row] for row in rows],
        "cell_links": links or [[[] for _ in row] for row in rows],
        "placeholder": placeholder,
        "placeholder_start": start,
        "placeholder_end": end,
    }
    if bar_color:
        table["bar_color"] = bar_color
    builder.tables.append(table)
    builder.placeholders.append(
        {
            "id": table_id,
            "kind": kind,
            "text_to_find": placeholder,
            "start": start,
            "end": end,
        }
    )


def first_text_for_selectors(node: Tag, selectors: list[str]) -> str:
    for selector in selectors:
        found = node.select_one(selector)
        if isinstance(found, Tag):
            text = collapse_ws(found.get_text(" ", strip=True)).strip()
            if text:
                return text
    return ""


def metric_nodes(node: Tag) -> list[Tag]:
    direct_metrics = direct_children_with_class(node, "metric")
    if direct_metrics:
        return direct_metrics
    return [metric for metric in node.select(".metric") if isinstance(metric, Tag)]


def add_metric_row(builder: Builder, node: Tag) -> None:
    row: list[str] = []
    style_row: list[list[str]] = []
    for metric in metric_nodes(node):
        value = first_text_for_selectors(metric, [".value", ".metric-value", ".k", "strong", "b"])
        label = first_text_for_selectors(metric, [".label", ".metric-label", ".l", "span"])
        note = first_text_for_selectors(metric, [".note", ".metric-note", ".sub"])
        pieces = [piece for piece in (value, label, note) if piece]
        if not pieces:
            pieces = [collapse_ws(metric.get_text(" ", strip=True)).strip()]
        row.append("\n".join(piece for piece in pieces if piece))
        style_row.append(["metric"])
    if not row:
        return
    add_table_placeholder(builder, "metric_cards", [row], [style_row])


def add_pill_row(builder: Builder, node: Tag) -> None:
    labels = [collapse_ws(pill.get_text(" ", strip=True)).strip() for pill in node.select(".pill")]
    labels = [label for label in labels if label]
    if not labels:
        return
    start, end = builder.add(" | ".join(labels))
    builder.add("\n")
    builder.blocks.append({"start": start, "end": end + 1, "type": "muted"})


def add_muted_text(builder: Builder, text: str) -> None:
    text = collapse_ws(text).strip()
    if not text:
        return
    start, end = builder.add(text)
    builder.add("\n")
    builder.blocks.append({"start": start, "end": end + 1, "type": "muted"})


def add_embedded_image(builder: Builder, img: Tag, caption: str = "") -> bool:
    src = str(img.get("src") or "").strip()
    if not src:
        return False

    builder.chart_counter += 1
    chart_id = f"CHART_IMAGE_{builder.chart_counter:02d}"
    placeholder = f"[[{chart_id}]]"
    start, end = builder.add(placeholder)
    builder.add("\n\n")
    image_file = f"chart_images/{chart_id.lower()}.png"
    builder.chart_images.append(
        {
            "id": chart_id,
            "kind": "embedded_image",
            "src": src,
            "alt": collapse_ws(str(img.get("alt") or "")).strip(),
            "caption": caption,
            "placeholder": placeholder,
            "placeholder_start": start,
            "placeholder_end": end,
            "image_file": image_file,
            "docs_width_pt": DOC_CONTENT_WIDTH_PT,
        }
    )
    builder.placeholders.append(
        {
            "id": chart_id,
            "kind": "chart_image",
            "text_to_find": placeholder,
            "start": start,
            "end": end,
        }
    )
    return True


def figure_caption_text(node: Tag) -> str:
    parts: list[str] = []
    for selector in ["figcaption", ".caption", ".spark-axis"]:
        for caption_node in node.select(selector):
            if isinstance(caption_node, Tag):
                text = collapse_ws(caption_node.get_text(" ", strip=True)).strip()
                if text and text not in parts:
                    parts.append(text)
    return " ".join(parts)


def add_figure(builder: Builder, node: Tag) -> bool:
    img = node.find("img")
    if isinstance(img, Tag):
        caption = figure_caption_text(node)
        added = add_embedded_image(builder, img, caption=caption)
        if added and caption:
            add_muted_text(builder, caption)
        return added

    svg = node.find("svg")
    if isinstance(svg, Tag):
        add_svg_chart(builder, svg)
        caption = figure_caption_text(node)
        if caption:
            add_muted_text(builder, caption)
        return True

    return False


def css_bar_widths(stylesheet_text: str) -> dict[str, float]:
    widths: dict[str, float] = {}
    for selectors, body in CSS_RULE_RE.findall(stylesheet_text):
        match = re.search(r"width\s*:\s*([0-9.]+)%", body)
        if not match:
            continue
        pct = float(match.group(1))
        for selector in selectors.split(","):
            class_names = re.findall(r"\.([A-Za-z0-9_-]+)", selector)
            if not class_names or not ({"bar", "fill", "bar-fill"} & set(class_names)):
                continue
            for class_name in class_names:
                if class_name not in {"bar", "fill", "bar-fill"}:
                    widths[class_name] = pct
    return widths


def bar_width_pct(fill: Tag | None, width_by_class: dict[str, float]) -> float:
    if not isinstance(fill, Tag):
        return 100.0
    match = re.search(r"width\s*:\s*([0-9.]+)", str(fill.get("style", "")))
    if match:
        return float(match.group(1))
    for class_name in classes(fill):
        if class_name in width_by_class:
            return width_by_class[class_name]
    return 100.0


def add_bar_chart(builder: Builder, node: Tag, width_by_class: dict[str, float]) -> None:
    chart_rows: list[dict[str, Any]] = []
    bar_color = "blue" if node.select_one(".fill.blue, .bar-fill.blue, .bar.blue") else "accent"
    for line in node.select(".bar-line, .bar-row"):
        spans = line.find_all("span")
        label_node = line.select_one(".bar-label, .label")
        value_node = line.select_one(".bar-value, .value")
        bar_head = line.select_one(".bar-head")
        if isinstance(bar_head, Tag):
            label_node = label_node or bar_head.find("span")
            value_node = value_node or bar_head.find("strong") or bar_head.find("b")
        direct_parts = [
            child
            for child in direct_tag_children(line)
            if "bar-track" not in classes(child)
            and not (classes(child) & {"bar", "fill", "bar-fill"})
            and collapse_ws(child.get_text(" ", strip=True)).strip()
        ]
        if not isinstance(label_node, Tag) and spans:
            label_node = spans[0]
        if not isinstance(label_node, Tag) and direct_parts:
            label_node = direct_parts[0]
        if not isinstance(value_node, Tag) and len(spans) >= 2:
            value_node = spans[-1]
        if not isinstance(value_node, Tag) and len(direct_parts) >= 2:
            value_node = direct_parts[-1]
        if not isinstance(label_node, Tag) or not isinstance(value_node, Tag):
            continue
        label = collapse_ws(label_node.get_text(" ", strip=True))
        value = collapse_ws(value_node.get_text(" ", strip=True))
        fill = line.select_one(".fill, .bar-fill, .bar")
        pct = bar_width_pct(fill, width_by_class)
        chart_rows.append({"label": label, "value": value, "pct": pct})
    if not chart_rows:
        return

    if builder.chart_mode == "table":
        rows: list[list[str]] = []
        style_rows: list[list[list[str]]] = []
        for row in chart_rows:
            blocks = max(1, round(row["pct"] / 5))
            rows.append([row["label"], "█" * blocks, row["value"]])
            style_rows.append([[], ["bar"], []])
        add_table_placeholder(builder, "bar_chart", rows, style_rows, bar_color=bar_color)
        return

    builder.chart_counter += 1
    chart_id = f"CHART_IMAGE_{builder.chart_counter:02d}"
    placeholder = f"[[{chart_id}]]"
    start, end = builder.add(placeholder)
    builder.add("\n\n")
    image_file = f"chart_images/{chart_id.lower()}.png"
    builder.chart_images.append(
        {
            "id": chart_id,
            "kind": "bar_chart",
            "aria_label": node.get("aria-label", ""),
            "rows": chart_rows,
            "bar_color": bar_color,
            "placeholder": placeholder,
            "placeholder_start": start,
            "placeholder_end": end,
            "image_file": image_file,
        }
    )
    builder.placeholders.append(
        {
            "id": chart_id,
            "kind": "chart_image",
            "text_to_find": placeholder,
            "start": start,
            "end": end,
        }
    )


def svg_dimensions(svg: Tag) -> tuple[int, int]:
    width = svg.get("width")
    height = svg.get("height")
    try:
        return int(float(str(width))), int(float(str(height)))
    except (TypeError, ValueError):
        pass
    view_box = svg.get("viewBox") or svg.get("viewbox")
    if view_box:
        parts = str(view_box).replace(",", " ").split()
        if len(parts) == 4:
            try:
                return int(float(parts[2])), int(float(parts[3]))
            except ValueError:
                pass
    return 1000, 600


def inline_svg_report_styles(svg_markup: str) -> str:
    """Apply report chart CSS classes as explicit SVG attributes.

    Sanitized reports commonly keep chart colors in the page stylesheet while
    SVG elements only carry classes. Once the SVG is extracted into the Docs
    conversion plan, renderers that do not have the original stylesheet can
    silently lose bars or labels. Inlining the known report chart classes keeps
    the generated PNG visually faithful and renderer-independent.
    """

    soup = BeautifulSoup(svg_markup, "xml")
    svg = soup.find("svg") or soup
    for el in svg.find_all(True):
        merged: dict[str, str] = {}
        for class_name in classes(el):
            merged.update(SVG_REPORT_STYLE_DEFAULTS.get(class_name, {}))
        for attr, value in merged.items():
            if el.get(attr) is None:
                el[attr] = value
    return str(svg)


def add_svg_chart(builder: Builder, node: Tag) -> None:
    svg = node if node.name == "svg" else node.find("svg")
    if not isinstance(svg, Tag):
        return

    builder.chart_counter += 1
    chart_id = f"CHART_IMAGE_{builder.chart_counter:02d}"
    placeholder = f"[[{chart_id}]]"
    start, end = builder.add(placeholder)
    builder.add("\n\n")

    width_px, height_px = svg_dimensions(svg)
    docs_height = round(DOC_CONTENT_WIDTH_PT * height_px / width_px, 1) if width_px else 240
    image_file = f"chart_images/{chart_id.lower()}.png"
    builder.chart_images.append(
        {
            "id": chart_id,
            "kind": "svg",
            "aria_label": svg.get("aria-label", node.get("aria-label", "")),
            "svg_markup": inline_svg_report_styles(str(svg)),
            "source_width_px": width_px,
            "source_height_px": height_px,
            "placeholder": placeholder,
            "placeholder_start": start,
            "placeholder_end": end,
            "image_file": image_file,
            "docs_width_pt": DOC_CONTENT_WIDTH_PT,
            "docs_height_pt": docs_height,
        }
    )
    builder.placeholders.append(
        {
            "id": chart_id,
            "kind": "chart_image",
            "text_to_find": placeholder,
            "start": start,
            "end": end,
        }
    )


def parse_html(path: Path, chart_mode: str = "image") -> dict[str, Any]:
    require_bs4()
    raw_html = path.read_text(encoding="utf-8")
    soup = BeautifulSoup(raw_html, "html.parser")
    root = soup.find("main") or soup.body or soup
    builder = Builder(chart_mode=chart_mode)
    stylesheet_text = "\n".join(style.get_text("\n") for style in soup.find_all("style"))
    first_column_bold = table_first_column_is_bold(stylesheet_text)
    bar_width_by_class = css_bar_widths(stylesheet_text)

    blockish_tags = {"h1", "h2", "h3", "h4", "p", "table", "ul", "ol", "figure", "img", "svg"}
    blockish_classes = {
        "bar-chart",
        "charts",
        "callout",
        "chart",
        "figure",
        "implication",
        "bars",
        "metric-grid",
        "metrics",
        "pillrow",
        "summary",
        "spark",
        "two-col",
    }

    def has_blockish_child(node: Tag) -> bool:
        for child in direct_tag_children(node):
            if child.name in blockish_tags or classes(child) & blockish_classes:
                return True
        if node.find(list(blockish_tags)):
            return True
        return any(node.find(class_=class_name) for class_name in blockish_classes)

    def process_children(node: Tag) -> None:
        for child in node.children:
            if isinstance(child, Tag):
                process_node(child)

    def add_summary_callout(builder: Builder, node: Tag) -> None:
        start = builder.offset
        append_inline(builder, node)
        end = builder.offset
        if end > start:
            builder.add("\n")
            builder.blocks.append({"start": start, "end": end + 1, "type": "summary_callout"})

    def process_node(node: Tag) -> None:
        node_classes = classes(node)
        if "two-col" in node_classes:
            if two_col_can_render_as_table_grid(node):
                add_two_col_layout(builder, node)
            else:
                builder.two_col_text_blocks += 1
                process_children(node)
            return
        if node.name in {"h1", "h2", "h3", "h4"}:
            add_heading(builder, node)
            return
        if node.name == "figure" or "figure" in node_classes:
            if add_figure(builder, node):
                return
            process_children(node)
            return
        if node.name == "img":
            add_embedded_image(builder, node)
            return
        if node.name == "p":
            if "note" in node_classes:
                block_type = "note"
            elif "source" in node_classes or "source-list" in node_classes:
                block_type = "source_list"
            elif "sub" in node_classes:
                block_type = "muted"
            else:
                block_type = None
            add_paragraph(builder, node, block_type)
            return
        if (
            "metric-grid" in node_classes
            or "metrics" in node_classes
            or direct_children_with_class(node, "metric")
        ):
            add_metric_row(builder, node)
            return
        if node.name == "table":
            rows, styles, links = table_from_html(node, first_column_bold=first_column_bold)
            add_table_placeholder(builder, "table", rows, styles, links)
            return
        if node.name in {"ul", "ol"}:
            start = builder.offset
            for li in node.find_all("li", recursive=False):
                li_start = builder.offset
                append_inline(builder, li)
                if builder.offset > li_start:
                    builder.add("\n")
            end = builder.offset
            builder.add("\n")
            if end > start:
                builder.lists.append({"start": start, "end": end, "ordered": node.name == "ol"})
            return
        child_tags = direct_tag_children(node)
        if "pillrow" in node_classes or (
            child_tags and all("pill" in classes(child) for child in child_tags)
        ):
            add_pill_row(builder, node)
            return
        if "callout" in node_classes or "implication" in node_classes:
            add_summary_callout(builder, node)
            return
        if "bar-chart" in node_classes or "bars" in node_classes:
            add_bar_chart(builder, node, bar_width_by_class)
            return
        if "chart" in node_classes and node.find("svg"):
            add_svg_chart(builder, node)
            return
        if node.name == "svg":
            add_svg_chart(builder, node)
            return

        if not has_blockish_child(node) and collapse_ws(node.get_text(" ", strip=True)).strip():
            add_paragraph(builder, node)
            return
        process_children(node)

    for child in root.children:
        if isinstance(child, Tag):
            process_node(child)

    title = (soup.title.get_text(" ", strip=True) if soup.title else "").strip()
    h1 = root.find("h1")
    if h1:
        title = collapse_ws(h1.get_text(" ", strip=True)).strip() or title
    two_col_blocks = root.select(".two-col")
    bar_blocks = [block for block in root.select(".bar-chart, .bars") if block.name != "svg"]

    return {
        "source_html": str(path),
        "title": title,
        "skeleton_text": builder.text().rstrip() + "\n",
        "headings": builder.headings,
        "inline_styles": builder.inline_styles,
        "blocks": builder.blocks,
        "lists": builder.lists,
        "placeholders": builder.placeholders,
        "tables": builder.tables,
        "chart_images": builder.chart_images,
        "counts": {
            "headings": len(builder.headings),
            "inline_styles": len(builder.inline_styles),
            "blocks": len(builder.blocks),
            "lists": len(builder.lists),
            "tables": len(builder.tables),
            "chart_images": len(builder.chart_images),
            "two_col_source_blocks": len(two_col_blocks),
            "two_col_image_blocks": sum(
                1 for chart in builder.chart_images if chart.get("kind") == "two_col_table_grid"
            ),
            "two_col_text_blocks": builder.two_col_text_blocks,
            "embedded_image_blocks": sum(
                1 for chart in builder.chart_images if chart.get("kind") == "embedded_image"
            ),
            "svg_image_blocks": sum(
                1 for chart in builder.chart_images if chart.get("kind") == "svg"
            ),
            "bar_source_blocks": len(bar_blocks),
            "bar_image_blocks": sum(
                1 for chart in builder.chart_images if chart.get("kind") == "bar_chart"
            ),
            "bar_table_blocks": sum(
                1 for table in builder.tables if table.get("kind") == "bar_chart"
            ),
            "images": len(root.find_all("img")),
            "svgs": len(root.find_all("svg")),
            "canvas": len(root.find_all("canvas")),
        },
        "source_flags": {
            "auth_page_detected": "login.microsoftonline.com" in raw_html
            or title.strip().lower() == "sign in to your account"
        },
    }
