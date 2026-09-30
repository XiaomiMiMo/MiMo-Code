#!/usr/bin/env python3
"""combine.py — concatenate multiple PDFs into one.

    python combine.py A.pdf B.pdf C.pdf --out combined.pdf
                     [--preserve-metadata FIRST|NONE]

--preserve-metadata FIRST  copies title/author/etc from the first input.
--preserve-metadata NONE   strips all metadata from the output.

Exit codes: 0 ok / 1 runtime failure / 2 bad usage.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterator


def _stream_pages(sources: list[Path]) -> Iterator[tuple[Path, int, object]]:
    """Yield (source_path, one_based_page_number, page_object) tuples."""
    from pypdf import PdfReader

    for src in sources:
        reader = PdfReader(str(src))
        if reader.is_encrypted:
            raise RuntimeError(f"{src} is encrypted; unlock first")
        for idx, page in enumerate(reader.pages, start=1):
            yield src, idx, page


def _copy_metadata(target, source: Path) -> None:
    from pypdf import PdfReader
    reader = PdfReader(str(source))
    md = reader.metadata or {}
    if md:
        target.add_metadata({k: str(v) for k, v in md.items() if v is not None})


def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Combine PDFs.")
    ap.add_argument("sources", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--preserve-metadata", choices=("FIRST", "NONE"),
                    default="NONE")
    ns = ap.parse_args(argv)

    missing = [p for p in ns.sources if not p.exists()]
    if missing:
        for p in missing:
            print(f"error: {p} does not exist", file=sys.stderr)
        return 2

    try:
        from pypdf import PdfWriter
    except ImportError:
        print("error: pypdf required (pip install pypdf)", file=sys.stderr)
        return 1

    writer = PdfWriter()
    try:
        for _src, _n, page in _stream_pages(ns.sources):
            writer.add_page(page)
    except RuntimeError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1

    if ns.preserve_metadata == "FIRST":
        _copy_metadata(writer, ns.sources[0])

    ns.out.parent.mkdir(parents=True, exist_ok=True)
    with ns.out.open("wb") as fh:
        writer.write(fh)
    print(f"wrote {ns.out} ({len(writer.pages)} pages)")
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
