#!/usr/bin/env python3
"""Explode a `.docx` archive into a browsable folder of pretty-printed XML.

Alternate implementation notes:
    - XML pretty-printing uses `lxml.etree` with `pretty_print=True`. This
      preserves namespace declarations exactly (minidom rewrites them and
      can drop `xml:space="preserve"` in some builds).
    - Extraction happens in two phases: (1) dump every byte verbatim to the
      target directory; (2) rewrite XML parts in place. Splitting the two
      keeps the "raw bytes are on disk" invariant available for debugging.

Usage:
    python explode.py <input.docx> <destination_dir> [--verbatim]

Exit code 0 on success, 2 on argument or I/O errors.
"""
from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

try:
    from lxml import etree as _et
except ImportError as exc:  # pragma: no cover
    sys.stderr.write("explode.py needs `lxml`. Install with: pip install lxml\n")
    raise

XML_KINDS = frozenset({".xml", ".rels"})


def _phase_dump(archive: Path, target: Path) -> list[Path]:
    """Phase 1 — copy every archive member to disk, return the list of paths."""
    dropped: list[Path] = []
    resolved_target = target.resolve()
    with zipfile.ZipFile(archive) as zf:
        for member in zf.infolist():
            if member.is_dir():
                continue
            out = (target / member.filename).resolve()
            if not out.is_relative_to(resolved_target):
                sys.stderr.write(
                    f"explode: refusing to extract {member.filename!r}: "
                    "path escapes the target directory\n")
                raise SystemExit(2)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(zf.read(member))
            dropped.append(out)
    return dropped


def _phase_beautify(paths: list[Path]) -> int:
    """Phase 2 — rewrite XML parts with a stable indent. Returns count changed."""
    parser = _et.XMLParser(remove_blank_text=True, resolve_entities=False)
    changed = 0
    for path in paths:
        if path.suffix.lower() not in XML_KINDS:
            continue
        try:
            tree = _et.parse(str(path), parser)
        except _et.XMLSyntaxError:
            # Non-well-formed XML (rare); leave it verbatim so a human can look.
            continue
        formatted = _et.tostring(
            tree,
            pretty_print=True,
            xml_declaration=True,
            encoding="UTF-8",
            standalone=True,
        )
        path.write_bytes(formatted)
        changed += 1
    return changed


def _refuse_dirty_target(target: Path) -> str | None:
    """Return an error string if `target` cannot receive extraction, else None."""
    if target.exists():
        if not target.is_dir():
            return f"{target} exists and is not a directory"
        for _ in target.iterdir():
            return f"{target} is not empty; remove it or pick another path"
    return None


def explode(archive: Path, target: Path, *, verbatim: bool = False) -> int:
    if not archive.is_file():
        sys.stderr.write(f"explode: {archive} is not a file\n")
        return 2

    error = _refuse_dirty_target(target)
    if error is not None:
        sys.stderr.write(f"explode: {error}\n")
        return 2

    target.mkdir(parents=True, exist_ok=True)
    dropped = _phase_dump(archive, target)

    if not verbatim:
        reformatted = _phase_beautify(dropped)
        print(f"explode: {len(dropped)} parts, {reformatted} beautified")
    else:
        print(f"explode: {len(dropped)} parts (verbatim)")
    return 0


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Explode a .docx into a browsable folder of XML."
    )
    parser.add_argument("archive", type=Path, help="Source .docx archive")
    parser.add_argument("target", type=Path, help="Destination folder")
    parser.add_argument(
        "--verbatim", action="store_true",
        help="Skip pretty-printing (dump bytes exactly as stored).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    return explode(args.archive, args.target, verbatim=args.verbatim)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
