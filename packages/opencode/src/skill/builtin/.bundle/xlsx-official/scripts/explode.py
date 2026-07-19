#!/usr/bin/env python3
"""Explode an xlsx into its XML parts, on disk.

An xlsx is an Open Packaging Convention (OPC) ZIP. This tool extracts every
member into ``destination/`` so you can edit the XML by hand and then
re-package it with ``assemble.py``.

Usage:
    python explode.py workbook.xlsx unpacked/
    python explode.py workbook.xlsx unpacked/ --force
"""

from __future__ import annotations

import argparse
import shutil
import sys
import zipfile
from pathlib import Path


def _directory_is_dirty(target: Path) -> bool:
    return target.exists() and any(target.iterdir())


def explode_package(source: Path, target: Path, force: bool) -> int:
    if not zipfile.is_zipfile(source):
        raise ValueError(f"{source} is not a zip archive")

    if _directory_is_dirty(target):
        if not force:
            raise FileExistsError(
                f"{target} is non-empty; pass --force to overwrite"
            )
        shutil.rmtree(target)

    target.mkdir(parents=True, exist_ok=True)
    member_count = 0
    with zipfile.ZipFile(source) as archive:
        for member in archive.infolist():
            archive.extract(member, target)
            member_count += 1
    return member_count


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Explode an xlsx into XML parts.")
    p.add_argument("workbook", type=Path)
    p.add_argument("destination", type=Path)
    p.add_argument("--force", action="store_true",
                   help="overwrite the destination directory if it is non-empty")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if not args.workbook.exists():
        print(f"no such workbook: {args.workbook}", file=sys.stderr)
        return 1

    try:
        count = explode_package(args.workbook, args.destination, args.force)
    except (ValueError, FileExistsError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(f"exploded {args.workbook} → {args.destination} ({count} part(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
