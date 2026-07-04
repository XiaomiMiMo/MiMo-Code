#!/usr/bin/env python3
"""survey.py — summarise a PDF for quick routing.

    python survey.py FILE.pdf [--pretty]

Emits a single-line JSON object (or pretty-printed with --pretty):

    path, page_count, is_locked, form_field_count, looks_scanned,
    metadata (dict)

Exits 0 on success, 1 on unreadable input, 2 on bad usage.

Only depends on pypdf.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path


class PdfProbeError(Exception):
    """Raised when the file cannot be inspected."""


@dataclass
class Report:
    path: str
    page_count: int | None = None
    is_locked: bool = False
    form_field_count: int = 0
    looks_scanned: bool = False
    metadata: dict = field(default_factory=dict)


def _sniff_first_page(reader) -> bool:
    """Return True if the first page has (near-)no text but embeds an image."""
    if not reader.pages:
        return False
    first = reader.pages[0]
    body = (first.extract_text() or "").strip()
    if len(body) >= 40:
        return False
    try:
        return any(True for _ in first.images)
    except Exception:
        return False


def _scrub_metadata(reader) -> dict:
    raw = reader.metadata or {}
    scrubbed: dict = {}
    for key, val in raw.items():
        clean_key = key.lstrip("/") if isinstance(key, str) else str(key).lstrip("/")
        scrubbed[clean_key] = None if val is None else str(val)
    return scrubbed


def probe(path: Path) -> Report:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(str(path))
    except (PdfReadError, OSError) as err:
        raise PdfProbeError(f"cannot open {path}: {err}") from err

    r = Report(path=str(path.resolve()), is_locked=bool(reader.is_encrypted))
    if r.is_locked:
        return r  # nothing else is trustworthy without the password

    r.page_count = len(reader.pages)
    r.form_field_count = len(reader.get_fields() or {})
    r.looks_scanned = _sniff_first_page(reader)
    r.metadata = _scrub_metadata(reader)
    return r


def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Summarise a PDF as JSON.")
    ap.add_argument("path", type=Path)
    ap.add_argument("--pretty", action="store_true")
    ns = ap.parse_args(argv)

    if not ns.path.exists() or ns.path.suffix.lower() != ".pdf":
        print(f"error: {ns.path} is not a .pdf file", file=sys.stderr)
        return 2

    try:
        rep = probe(ns.path)
    except PdfProbeError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1

    payload = asdict(rep)
    kwargs = {"indent": 2} if ns.pretty else {"separators": (",", ":")}
    print(json.dumps(payload, ensure_ascii=False, **kwargs))
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
