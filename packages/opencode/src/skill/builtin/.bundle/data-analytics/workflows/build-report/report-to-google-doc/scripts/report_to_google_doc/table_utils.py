from __future__ import annotations

import re
from typing import Any

from .constants import DOC_CONTENT_WIDTH_PT

NUMERIC_TABLE_CELL_RE = re.compile(r"^[\s$%+,\-()./:0-9xXkKmMbBtT]+$")


def table_column_widths(table: dict[str, Any], columns: int) -> list[float]:
    if columns <= 0:
        return []

    total_width = float(table.get("docs_width_pt", DOC_CONTENT_WIDTH_PT))
    kind = table.get("kind")
    if kind == "metric_cards" or columns <= 4:
        width = total_width / columns
        return [round(width, 1)] * columns

    if columns == 5:
        first = 120.0
    elif columns >= 6:
        first = 90.0
    else:
        first = total_width / columns

    first = min(first, total_width / columns * 1.15)
    remaining = (total_width - first) / (columns - 1)
    return [round(first, 1)] + [round(remaining, 1)] * (columns - 1)


def table_cell_is_numeric(text: str) -> bool:
    stripped = text.strip()
    return bool(
        stripped
        and any(char.isdigit() for char in stripped)
        and NUMERIC_TABLE_CELL_RE.match(stripped)
    )


def numeric_table_columns(rows: list[list[str]]) -> set[int]:
    if not rows:
        return set()
    numeric_columns: set[int] = set()
    for column_index in range(len(rows[0])):
        values = [
            row[column_index]
            for row in rows[1:]
            if column_index < len(row) and row[column_index].strip()
        ]
        if values and all(table_cell_is_numeric(value) for value in values):
            numeric_columns.add(column_index)
    return numeric_columns
