#!/usr/bin/env python3
"""reorient.py — rotate selected pages of a PDF.

    python reorient.py in.pdf --angle 90 --targets 1,2,5-8 --out rot.pdf
    python reorient.py in.pdf --angle 180 --targets all --out flipped.pdf

Only 90 / 180 / 270 are permitted (PDF standard). Rotation is ADDED to
whatever rotation the page already has.

Exit codes: 0 ok / 1 runtime failure / 2 bad usage.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _targets(spec: str, total: int) -> frozenset[int]:
    if spec.strip().lower() == "all":
        return frozenset(range(1, total + 1))
    picks: set[int] = set()
    for token in spec.split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token:
            lo_s, hi_s = token.split("-", 1)
            lo = int(lo_s) if lo_s else 1
            hi = int(hi_s) if hi_s else total
        else:
            lo = hi = int(token)
        if not (1 <= lo <= hi <= total):
            raise ValueError(f"token {token!r} out of 1..{total}")
        picks.update(range(lo, hi + 1))
    return frozenset(picks)


def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Rotate PDF pages.")
    ap.add_argument("path", type=Path)
    ap.add_argument("--angle", type=int, required=True,
                    choices=(90, 180, 270))
    ap.add_argument("--targets", required=True,
                    help="e.g. 1,3-5 or 'all'")
    ap.add_argument("--out", type=Path, required=True)
    ns = ap.parse_args(argv)

    if not ns.path.exists():
        print(f"error: {ns.path} does not exist", file=sys.stderr)
        return 2

    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        print("error: pypdf required (pip install pypdf)", file=sys.stderr)
        return 1

    reader = PdfReader(str(ns.path))
    if reader.is_encrypted:
        print("error: encrypted; unlock first", file=sys.stderr)
        return 1

    try:
        selection = _targets(ns.targets, len(reader.pages))
    except ValueError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2

    writer = PdfWriter()
    for idx, page in enumerate(reader.pages, start=1):
        if idx in selection:
            page.rotate(ns.angle)
        writer.add_page(page)

    ns.out.parent.mkdir(parents=True, exist_ok=True)
    with ns.out.open("wb") as fh:
        writer.write(fh)
    print(f"wrote {ns.out} ({len(selection)} pages rotated {ns.angle}°)")
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
