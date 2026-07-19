from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Builder:
    chart_mode: str = "image"
    parts: list[str] = field(default_factory=list)
    offset: int = 0
    inline_styles: list[dict[str, Any]] = field(default_factory=list)
    headings: list[dict[str, Any]] = field(default_factory=list)
    blocks: list[dict[str, Any]] = field(default_factory=list)
    lists: list[dict[str, Any]] = field(default_factory=list)
    placeholders: list[dict[str, Any]] = field(default_factory=list)
    tables: list[dict[str, Any]] = field(default_factory=list)
    chart_images: list[dict[str, Any]] = field(default_factory=list)
    two_col_text_blocks: int = 0
    table_counter: int = 0
    chart_counter: int = 0

    def add(self, text: str) -> tuple[int, int]:
        start = self.offset
        self.parts.append(text)
        self.offset += len(text)
        return start, self.offset

    def text(self) -> str:
        return "".join(self.parts)
