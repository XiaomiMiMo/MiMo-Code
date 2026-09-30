#!/usr/bin/env python3
"""Render an xlsx as PDF via headless LibreOffice.

Usage:
    python pdf_out.py workbook.xlsx                # writes workbook.pdf beside input
    python pdf_out.py workbook.xlsx --dest reports/  # writes reports/workbook.pdf
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
from runtime.libreoffice import LibreOfficeNotFound, invoke, locate_libreoffice  # noqa: E402


class RenderFailed(RuntimeError):
    """LibreOffice could not produce a PDF."""


def render_pdf(source: Path, out_dir: Path, timeout_seconds: float) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="xlsx-pdf-") as scratch:
        result = invoke(
            [
                "--headless",
                "--calc",
                "--convert-to", "pdf",
                "--outdir", scratch,
                str(source.resolve()),
            ],
            timeout=timeout_seconds,
        )
        if not result.ok:
            raise RenderFailed(
                f"soffice returned {result.returncode}: "
                f"{result.stderr.strip() or '(no stderr)'}"
            )
        produced = next(Path(scratch).glob("*.pdf"), None)
        if produced is None:
            raise RenderFailed("no PDF produced by LibreOffice")
        final = out_dir / (source.stem + ".pdf")
        shutil.move(str(produced), str(final))
        return final


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Render an xlsx as PDF.")
    p.add_argument("workbook", type=Path)
    p.add_argument("--dest", type=Path, default=None,
                   help="output directory (default: same as input)")
    p.add_argument("--timeout", type=float, default=60.0,
                   help="LibreOffice timeout in seconds")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if not args.workbook.exists():
        print(f"no such workbook: {args.workbook}", file=sys.stderr)
        return 1

    try:
        locate_libreoffice()
    except LibreOfficeNotFound as exc:
        print(str(exc), file=sys.stderr)
        return 3

    out_dir = (args.dest or args.workbook.parent).resolve()

    try:
        final = render_pdf(args.workbook, out_dir, args.timeout)
    except subprocess.TimeoutExpired:
        print(f"LibreOffice exceeded {args.timeout}s timeout", file=sys.stderr)
        return 4
    except RenderFailed as exc:
        print(str(exc), file=sys.stderr)
        return 4

    print(str(final))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
