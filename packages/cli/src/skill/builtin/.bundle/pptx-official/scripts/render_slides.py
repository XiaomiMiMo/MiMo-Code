#!/usr/bin/env python3
"""Render every slide of a .pptx as an individual raster image.

Two-stage pipeline behind the scenes: `soffice --convert-to pdf` then
`pdftoppm` to rasterise. This is significantly cheaper than invoking
soffice once per slide.

Outputs are named `slide-1.<ext>`, `slide-2.<ext>`, ... in the destination
directory (`--out`, default: alongside the source).

Usage:
    python render_slides.py deck.pptx --out slides/
    python render_slides.py deck.pptx --out slides/ --format jpg --dpi 200
    python render_slides.py deck.pptx --out slides/ --first 3 --last 5
    python render_slides.py deck.pptx --keep-pdf     # keep the intermediate PDF
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from soffice_bridge import BridgeError, translate  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("source", type=Path)
    ap.add_argument("--out", type=Path, default=None,
                    help="destination directory (default: alongside source)")
    ap.add_argument("--format", dest="fmt", choices=("png", "jpg"), default="png",
                    help="output image format (default: png)")
    ap.add_argument("--dpi", type=int, default=150,
                    help="rasterisation DPI (default 150)")
    ap.add_argument("--first", type=int, default=None,
                    help="first slide (1-based) to render")
    ap.add_argument("--last", type=int, default=None,
                    help="last slide (1-based) to render")
    ap.add_argument("--keep-pdf", action="store_true",
                    help="preserve the intermediate PDF file")
    ns = ap.parse_args(argv)

    try:
        images = translate(ns.source, ns.fmt, out_dir=ns.out,
                           dpi=ns.dpi, first=ns.first, last=ns.last,
                           keep_intermediate_pdf=ns.keep_pdf)
    except BridgeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    for path in images:  # type: ignore[union-attr]
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
