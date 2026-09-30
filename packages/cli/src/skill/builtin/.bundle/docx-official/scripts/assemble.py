#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["lxml>=4.9"]
# ///
"""Assemble an exploded `.docx` directory tree back into a `.docx`.

Alternate implementation notes:
    - Writing order is driven by `[Content_Types].xml`, not by lexical sort:
      overrides declared there are emitted in declaration order, then
      whatever remains (media, extra rels) is appended. This mirrors how
      Word itself lays out its archives — some naive OOXML consumers care
      about the position of `[Content_Types].xml` and the main document.
    - Every ZIP entry is written with a fixed modification time (2000-01-01
      00:00:00) so repeated assembly runs produce byte-identical archives.
      Useful for reproducible builds and content-addressed caches.

Usage:
    uv run assemble.py <source_dir> <destination.docx> [--sanity]
"""
from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path
from typing import Iterable

try:
    from lxml import etree as _et
except ImportError as exc:  # pragma: no cover
    sys.stderr.write("assemble.py needs `lxml`. Run with `uv run assemble.py` (auto-installs) "
                     "or: pip install lxml\n")
    raise

_CONTENT_TYPES_NAME = "[Content_Types].xml"
_CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
_FIXED_MTIME = (2000, 1, 1, 0, 0, 0)


def _read_manifest_order(root: Path) -> list[str]:
    """Return the archive-relative paths declared as Overrides in Content_Types."""
    ct_path = root / _CONTENT_TYPES_NAME
    if not ct_path.is_file():
        return []
    try:
        doc = _et.parse(str(ct_path))
    except _et.XMLSyntaxError:
        return []
    ns = {"ct": _CT_NS}
    ordered: list[str] = []
    for node in doc.findall("ct:Override", ns):
        pn = node.get("PartName") or ""
        pn = pn.lstrip("/")
        ordered.append(pn)
    return ordered


def _plan_order(root: Path) -> Iterable[tuple[str, Path]]:
    """Yield `(archive_name, disk_path)` pairs in the emit order."""
    on_disk: dict[str, Path] = {}
    for p in root.rglob("*"):
        if p.is_file():
            arc = p.relative_to(root).as_posix()
            on_disk[arc] = p

    if _CONTENT_TYPES_NAME in on_disk:
        yield _CONTENT_TYPES_NAME, on_disk.pop(_CONTENT_TYPES_NAME)

    # Overrides declared in [Content_Types].xml, in declared order.
    for arc in _read_manifest_order(root):
        if arc in on_disk:
            yield arc, on_disk.pop(arc)

    # Whatever's left (rels files, images, embedded fonts, custom XML) —
    # sort so the tail is deterministic even if the manifest was minimal.
    for arc in sorted(on_disk):
        yield arc, on_disk[arc]


def _fixed_zipinfo(name: str) -> zipfile.ZipInfo:
    zi = zipfile.ZipInfo(filename=name, date_time=_FIXED_MTIME)
    zi.compress_type = zipfile.ZIP_DEFLATED
    zi.create_system = 0  # DOS/Windows — Word writes this
    return zi


def _sanity_check(archive: Path) -> list[str]:
    """Quick post-write check: ZIP opens, required parts exist."""
    problems: list[str] = []
    try:
        with zipfile.ZipFile(archive) as zf:
            names = set(zf.namelist())
            corrupt = zf.testzip()
            if corrupt is not None:
                problems.append(f"CRC error on {corrupt}")
            for required in (
                _CONTENT_TYPES_NAME, "_rels/.rels", "word/document.xml"
            ):
                if required not in names:
                    problems.append(f"missing required part: {required}")
    except zipfile.BadZipFile as exc:
        problems.append(f"invalid ZIP: {exc}")
    return problems


def assemble(source: Path, destination: Path, *, sanity: bool = False) -> int:
    if not source.is_dir():
        sys.stderr.write(f"assemble: {source} is not a directory\n")
        return 2
    if not (source / _CONTENT_TYPES_NAME).is_file():
        sys.stderr.write(
            f"assemble: {_CONTENT_TYPES_NAME} is missing under {source}; "
            "the produced archive will not be a valid OOXML package\n"
        )

    destination.parent.mkdir(parents=True, exist_ok=True)

    count = 0
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for arc, disk in _plan_order(source):
            zf.writestr(_fixed_zipinfo(arc), disk.read_bytes())
            count += 1
    print(f"assemble: wrote {count} parts to {destination}")

    if sanity:
        problems = _sanity_check(destination)
        if problems:
            sys.stderr.write("assemble: sanity check failed:\n")
            for problem in problems:
                sys.stderr.write(f"  - {problem}\n")
            return 1
        print("assemble: sanity check ok")
    return 0


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Assemble an exploded directory tree into a .docx."
    )
    parser.add_argument("source", type=Path, help="Exploded source directory")
    parser.add_argument("destination", type=Path, help="Output .docx path")
    parser.add_argument(
        "--sanity", action="store_true",
        help="Verify the produced archive is a valid ZIP with the required parts.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    return assemble(args.source, args.destination, sanity=args.sanity)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
