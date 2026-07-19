#!/usr/bin/env python3
"""carve.py — carve a PDF into smaller PDFs.

Three carve modes (choose exactly one):

    --by-range 1-3 4-6 7-z    each range becomes one output file
    --every-page              one output per input page
    --chunk-size N            fixed N-page chunks

Common:
    input.pdf                 required, first positional
    --dest DIR/               required output directory

`z` in a range means "last page". Ranges are 1-based, inclusive.

Output naming embeds actual page numbers:
    by-range      -> <stem>__p001-p003.pdf
    every-page    -> <stem>__p001.pdf
    chunk-size N  -> <stem>__p001-p{N}.pdf

Exit codes: 0 ok / 1 runtime failure / 2 bad usage.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RangeSpec:
    start: int
    end: int

    def label(self) -> str:
        return f"p{self.start:03d}-p{self.end:03d}"


def _parse_one_range(token: str, total: int) -> RangeSpec:
    if "-" in token:
        left, right = token.split("-", 1)
        lo = int(left) if left else 1
        hi = total if right in ("", "z", "Z") else int(right)
    else:
        lo = hi = int(token)
    if not (1 <= lo <= hi <= total):
        raise ValueError(f"range {token!r} not within 1..{total}")
    return RangeSpec(lo, hi)


def _emit(pages, dest: Path) -> None:
    from pypdf import PdfWriter
    w = PdfWriter()
    for p in pages:
        w.add_page(p)
    with dest.open("wb") as fh:
        w.write(fh)
    print(f"wrote {dest}")


def _carve_by_range(reader, ranges: list[RangeSpec], dest: Path, stem: str) -> None:
    for r in ranges:
        pages = list(reader.pages[r.start - 1: r.end])
        _emit(pages, dest / f"{stem}__{r.label()}.pdf")


def _carve_every_page(reader, dest: Path, stem: str) -> None:
    for idx, page in enumerate(reader.pages, start=1):
        _emit([page], dest / f"{stem}__p{idx:03d}.pdf")


def _carve_by_chunk(reader, size: int, dest: Path, stem: str) -> None:
    total = len(reader.pages)
    for start in range(0, total, size):
        end = min(start + size, total)
        pages = list(reader.pages[start:end])
        label = f"p{start + 1:03d}-p{end:03d}"
        _emit(pages, dest / f"{stem}__{label}.pdf")


def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Carve a PDF into pieces.")
    ap.add_argument("path", type=Path)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--by-range", nargs="+", metavar="RANGE",
                      help='e.g. 1-3 4-6 7-z')
    mode.add_argument("--every-page", action="store_true")
    mode.add_argument("--chunk-size", type=int)
    ap.add_argument("--dest", type=Path, required=True)
    ns = ap.parse_args(argv)

    if not ns.path.exists():
        print(f"error: {ns.path} does not exist", file=sys.stderr)
        return 2

    try:
        from pypdf import PdfReader
    except ImportError:
        print("error: pypdf required (pip install pypdf)", file=sys.stderr)
        return 1

    reader = PdfReader(str(ns.path))
    if reader.is_encrypted:
        print("error: file is encrypted; unlock first", file=sys.stderr)
        return 1

    ns.dest.mkdir(parents=True, exist_ok=True)
    stem = ns.path.stem
    total = len(reader.pages)

    if ns.by_range:
        try:
            ranges = [_parse_one_range(t, total) for t in ns.by_range]
        except ValueError as err:
            print(f"error: {err}", file=sys.stderr)
            return 2
        _carve_by_range(reader, ranges, ns.dest, stem)

    elif ns.every_page:
        _carve_every_page(reader, ns.dest, stem)

    else:  # chunk-size
        if ns.chunk_size < 1:
            print("error: --chunk-size must be >= 1", file=sys.stderr)
            return 2
        _carve_by_chunk(reader, ns.chunk_size, ns.dest, stem)

    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
