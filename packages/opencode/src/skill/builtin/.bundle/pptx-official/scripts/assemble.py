#!/usr/bin/env python3
"""Assemble an exploded .pptx directory tree into a .pptx archive.

Companion to explode.py. Every file under <source_dir> is written into the
output ZIP with its relative path preserved. Compression is DEFLATE (what
PowerPoint writes), and `[Content_Types].xml` is emitted first because
many naive OOXML consumers assume it is the archive's leading entry.

Two consecutive assemblies of the same unchanged tree produce
byte-identical archives, which keeps CI diffing and content-addressed
storage sane.

Usage:
    python assemble.py <source_dir> <target.pptx> [--strict]

Flags:
    --strict   fail (non-zero exit) if `[Content_Types].xml` is missing;
               without --strict, a warning is printed and the archive is
               still written (useful when debugging bad trees).
"""
from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path
from typing import Iterator

CONTENT_TYPES = "[Content_Types].xml"


def _yield_parts(root: Path) -> Iterator[tuple[str, Path]]:
    """Enumerate the files to include, emitting `[Content_Types].xml` first.

    All other files follow in POSIX-path order so repeated runs are stable.
    """
    everything = sorted(
        (p for p in root.rglob("*") if p.is_file()),
        key=lambda p: p.relative_to(root).as_posix(),
    )
    prelude: list[tuple[str, Path]] = []
    tail: list[tuple[str, Path]] = []
    for path in everything:
        rel = path.relative_to(root).as_posix()
        (prelude if rel == CONTENT_TYPES else tail).append((rel, path))
    yield from prelude
    yield from tail


def assemble(source_dir: Path, target: Path, *, strict: bool = False) -> int:
    if not source_dir.is_dir():
        raise SystemExit(f"{source_dir} is not a directory")

    has_content_types = (source_dir / CONTENT_TYPES).is_file()
    if not has_content_types:
        message = f"{CONTENT_TYPES} missing from {source_dir}"
        if strict:
            raise SystemExit(f"error: {message}")
        print(f"warning: {message}; output will not be valid OOXML",
              file=sys.stderr)

    target.parent.mkdir(parents=True, exist_ok=True)

    count = 0
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as out:
        for arcname, path in _yield_parts(source_dir):
            out.write(path, arcname=arcname)
            count += 1
    return count


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("source_dir", type=Path)
    ap.add_argument("target", type=Path)
    ap.add_argument("--strict", action="store_true",
                    help="fail if [Content_Types].xml is missing")
    ns = ap.parse_args(argv)

    count = assemble(ns.source_dir, ns.target, strict=ns.strict)
    print(f"assembled {count} parts into {ns.target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
