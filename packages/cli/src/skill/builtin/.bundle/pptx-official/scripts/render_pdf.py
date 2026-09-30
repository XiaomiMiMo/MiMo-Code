#!/usr/bin/env python3
"""Render a .pptx as a single PDF file (via LibreOffice).

Thin wrapper on top of `soffice_bridge.translate(..., target="pdf")`. Kept
as its own entry point because the QA loop in SKILL.md invokes it by name.

Usage:
    python render_pdf.py deck.pptx                  # writes deck.pdf beside it
    python render_pdf.py deck.pptx --out ./out/     # writes ./out/deck.pdf
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
    ns = ap.parse_args(argv)

    try:
        pdf = translate(ns.source, "pdf", out_dir=ns.out)
    except BridgeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(pdf)
    return 0


if __name__ == "__main__":
    sys.exit(main())
