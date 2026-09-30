#!/usr/bin/env python3
"""Assemble a directory of xlsx XML parts back into an xlsx.

Restores the OPC invariant: ``[Content_Types].xml`` MUST be the first
member of the archive and stored uncompressed. Everything else is deflated.

Usage:
    python assemble.py unpacked/ workbook.xlsx
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path
from typing import Iterator


CONTENT_TYPES_ENTRY = "[Content_Types].xml"


def packaging_order(root: Path) -> Iterator[Path]:
    """Yield member paths in OPC-friendly order.

    The first yielded path is ``[Content_Types].xml``. The rest are sorted
    lexically so archives are reproducible.
    """
    special = root / CONTENT_TYPES_ENTRY
    if not special.is_file():
        raise FileNotFoundError(
            f"{special} not found — {root} does not look like an exploded xlsx"
        )
    yield special

    remaining = sorted(
        (p for p in root.rglob("*") if p.is_file() and p != special)
    )
    yield from remaining


def _relative(member: Path, root: Path) -> str:
    return member.relative_to(root).as_posix()


def assemble_package(source_dir: Path, target: Path) -> int:
    if not source_dir.is_dir():
        raise NotADirectoryError(f"{source_dir} is not a directory")
    target.parent.mkdir(parents=True, exist_ok=True)

    written = 0
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        for member in packaging_order(source_dir):
            arcname = _relative(member, source_dir)
            info = zipfile.ZipInfo(arcname)
            info.compress_type = (
                zipfile.ZIP_STORED
                if arcname == CONTENT_TYPES_ENTRY
                else zipfile.ZIP_DEFLATED
            )
            archive.writestr(info, member.read_bytes())
            written += 1
    return written


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Assemble XML parts into an xlsx.")
    p.add_argument("source", type=Path,
                   help="directory previously produced by explode.py")
    p.add_argument("target", type=Path, help="output .xlsx path")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        count = assemble_package(args.source, args.target)
    except (NotADirectoryError, FileNotFoundError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(f"assembled {args.source} → {args.target} ({count} part(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
