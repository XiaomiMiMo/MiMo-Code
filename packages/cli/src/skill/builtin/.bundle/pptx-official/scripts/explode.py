#!/usr/bin/env python3
"""Explode a .pptx archive into a directory of readable XML files.

Every entry in the ZIP is written to <target>/<archive-path>. XML parts
(`.xml`, `.rels`) are re-emitted with a stable indent via lxml so that
subsequent diffs stay tight; everything else is copied byte-for-byte.

The archive layout is preserved exactly: running `assemble.py` on the
resulting tree produces a functionally equivalent .pptx. Two consecutive
explodes of the same file yield byte-identical trees.

Usage:
    python explode.py <source.pptx> <target_dir> [--verbatim]

Flags:
    --verbatim   skip indent normalisation; write every part byte-for-byte
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from zipfile import BadZipFile, ZipFile

INDENTED = {".xml", ".rels"}


def _reformat(raw: bytes) -> bytes:
    """Return a pretty-indented copy of an XML blob, or the raw bytes on
    parse failure (rare for real OOXML parts, but possible for hand-edited
    junk that we shouldn't silently discard)."""
    try:
        from lxml import etree  # local import: keep the tool usable if the
                                # caller only wants --verbatim mode.
    except ImportError:
        return raw
    try:
        parser = etree.XMLParser(remove_blank_text=True)
        tree = etree.fromstring(raw, parser)
    except etree.XMLSyntaxError:
        return raw
    return etree.tostring(tree, pretty_print=True,
                          xml_declaration=True, encoding="UTF-8")


def _ensure_target(target: Path) -> None:
    if target.exists():
        if not target.is_dir():
            raise SystemExit(f"{target} exists and is not a directory")
        if any(target.iterdir()):
            raise SystemExit(
                f"{target} is not empty; remove it or choose another path")
    else:
        target.mkdir(parents=True)


def explode(source: Path, target: Path, *, indent: bool = True) -> int:
    if not source.is_file():
        raise SystemExit(f"{source} is not a file")
    _ensure_target(target)

    written = 0
    try:
        archive = ZipFile(source)
    except BadZipFile as exc:
        raise SystemExit(f"{source} is not a valid ZIP archive: {exc}")

    with archive as zf:
        resolved_target = target.resolve()
        for info in zf.infolist():
            if info.is_dir():
                continue
            out_path = (target / info.filename).resolve()
            if not out_path.is_relative_to(resolved_target):
                raise SystemExit(
                    f"refusing to extract {info.filename!r}: "
                    "path escapes the target directory")
            out_path.parent.mkdir(parents=True, exist_ok=True)
            data = zf.read(info)
            if indent and out_path.suffix.lower() in INDENTED:
                data = _reformat(data)
            out_path.write_bytes(data)
            written += 1
    return written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("source", type=Path)
    ap.add_argument("target", type=Path)
    ap.add_argument("--verbatim", action="store_true",
                    help="write XML parts unmodified (no indent normalisation)")
    ns = ap.parse_args(argv)

    written = explode(ns.source, ns.target, indent=not ns.verbatim)
    print(f"wrote {written} parts to {ns.target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
