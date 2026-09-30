from __future__ import annotations

import re
from typing import Any


def rgb(color: dict[str, float]) -> dict[str, Any]:
    return {"color": {"rgbColor": color}}


def docs_range(start: int, end: int) -> dict[str, int]:
    return {"startIndex": start + 1, "endIndex": end + 1}


def collapse_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text)
