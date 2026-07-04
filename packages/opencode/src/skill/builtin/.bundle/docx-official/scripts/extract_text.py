#!/usr/bin/env python3
"""Extract plain text from a `.docx` using XPath expressions.

Alternate implementation notes:
    - Uses `lxml.etree` and XPath (`.//w:p[not(...)] ...`) rather than
      hand-walking `.iter(tag)`. That collapses several passes into single
      XPath queries and makes the extraction rules read like the spec.
    - Falls back to `xml.etree.ElementTree` if lxml is unavailable — this
      script has no hard dependency beyond the standard library. The
      fallback path uses `iter()` since ElementTree's XPath support is a
      subset of lxml's.

Usage:
    python extract_text.py <input.docx>
    python extract_text.py <input.docx> --out out.txt
    python extract_text.py <input.docx> --include-notes --include-comments
"""
from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_W = f"{{{_W_NS}}}"
_MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006"
_MC_FALLBACK = f"{{{_MC_NS}}}Fallback"


try:  # Prefer lxml when available; otherwise fall back to stdlib.
    from lxml import etree as _et
    _HAVE_LXML = True
except ImportError:  # pragma: no cover
    from xml.etree import ElementTree as _et  # type: ignore
    _HAVE_LXML = False


def _paragraph_text_lxml(paragraph) -> str:
    """Concatenate text/tab/br children in document order via a single XPath.

    Skips mc:Fallback (duplicate of mc:Choice content) and w:tabs stop
    definitions (only run-level w:tab/w:br are literal characters)."""
    parts: list[str] = []
    xpath = _et.XPath(
        ".//*[(self::w:t or self::w:tab[parent::w:r] or self::w:br[parent::w:r])"
        " and not(ancestor::mc:Fallback)]",
        namespaces={"w": _W_NS, "mc": _MC_NS})
    for node in xpath(paragraph):
        if node.tag == f"{_W}t":
            if node.text:
                parts.append(node.text)
        elif node.tag == f"{_W}tab":
            parts.append("\t")
        elif node.tag == f"{_W}br":
            parts.append("\n")
    return "".join(parts)


def _paragraph_text_stdlib(paragraph) -> str:
    parts: list[str] = []

    def walk(node) -> None:
        for child in node:
            if child.tag in (_MC_FALLBACK, f"{_W}pPr"):
                continue
            if child.tag == f"{_W}t":
                if child.text:
                    parts.append(child.text)
            elif child.tag == f"{_W}tab":
                parts.append("\t")
            elif child.tag == f"{_W}br":
                parts.append("\n")
            else:
                walk(child)

    walk(paragraph)
    return "".join(parts)


_paragraph_text = _paragraph_text_lxml if _HAVE_LXML else _paragraph_text_stdlib


def _paragraphs_in(payload: bytes) -> list[str]:
    root = _et.fromstring(payload)
    if _HAVE_LXML:
        # Top-level paragraphs only — nested ones (text boxes) are already
        # covered by the outer paragraph's text walk. mc:Fallback duplicates
        # mc:Choice content, so skip it entirely.
        paragraphs = _et.XPath(
            "//w:p[not(ancestor::w:p) and not(ancestor::mc:Fallback)]",
            namespaces={"w": _W_NS, "mc": _MC_NS})(root)
    else:
        paragraphs = []

        def collect(node) -> None:
            for child in node:
                if child.tag == _MC_FALLBACK:
                    continue
                if child.tag == f"{_W}p":
                    paragraphs.append(child)
                else:
                    collect(child)

        collect(root)
    return [_paragraph_text(p) for p in paragraphs]


def _selected_parts(
    zf: zipfile.ZipFile,
    *,
    include_notes: bool,
    include_headers_footers: bool,
    include_comments: bool,
) -> list[str]:
    picked: list[str] = []
    names = zf.namelist()

    if "word/document.xml" in names:
        picked.append("word/document.xml")

    if include_headers_footers:
        for name in names:
            base = Path(name).name
            if name.startswith("word/") and (
                base.startswith("header") or base.startswith("footer")
            ) and name.endswith(".xml"):
                picked.append(name)

    if include_notes:
        for candidate in ("word/footnotes.xml", "word/endnotes.xml"):
            if candidate in names:
                picked.append(candidate)

    if include_comments and "word/comments.xml" in names:
        picked.append("word/comments.xml")

    return picked


def extract_text(
    source: Path,
    *,
    include_notes: bool = False,
    include_headers_footers: bool = False,
    include_comments: bool = False,
) -> str:
    lines: list[str] = []
    with zipfile.ZipFile(source) as zf:
        for name in _selected_parts(
            zf,
            include_notes=include_notes,
            include_headers_footers=include_headers_footers,
            include_comments=include_comments,
        ):
            try:
                lines.extend(_paragraphs_in(zf.read(name)))
            except Exception as exc:
                sys.stderr.write(f"extract_text: skipping {name}: {exc}\n")
    return "\n".join(line for line in lines if line)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract plain text from a .docx file."
    )
    parser.add_argument("source", type=Path, help="Input .docx file")
    parser.add_argument("--out", type=Path, default=None,
                        help="Write text to this file (default: stdout).")
    parser.add_argument("--include-headers-footers", action="store_true",
                        help="Also include text from headers and footers.")
    parser.add_argument("--include-notes", action="store_true",
                        help="Also include text from footnotes and endnotes.")
    parser.add_argument("--include-comments", action="store_true",
                        help="Also include text from review comments.")
    parser.add_argument("--all", action="store_true",
                        help="Shortcut for --include-headers-footers "
                             "--include-notes --include-comments.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    if not args.source.is_file():
        sys.stderr.write(f"extract_text: {args.source} is not a file\n")
        return 2

    hf = args.include_headers_footers or args.all
    notes = args.include_notes or args.all
    comments = args.include_comments or args.all

    try:
        text = extract_text(
            args.source,
            include_notes=notes,
            include_headers_footers=hf,
            include_comments=comments,
        )
    except zipfile.BadZipFile as exc:
        sys.stderr.write(f"extract_text: {args.source} is not a valid .docx: {exc}\n")
        return 2

    if args.out is None:
        sys.stdout.write(text)
        if text and not text.endswith("\n"):
            sys.stdout.write("\n")
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        payload = text + ("\n" if text and not text.endswith("\n") else "")
        args.out.write_text(payload, encoding="utf-8")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
