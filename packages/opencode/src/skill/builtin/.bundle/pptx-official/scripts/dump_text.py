#!/usr/bin/env python3
"""Dump slide text from a .pptx as plain text or markdown.

Walks the deck in presentation order (following `<p:sldIdLst>` in
`ppt/presentation.xml`) and collects every `<a:t>` run. Speaker notes are
optional and come from the paired `notesSlide{N}.xml` parts.

Uses `lxml` when available for XPath queries; falls back to the stdlib
`xml.etree.ElementTree` if lxml is not installed, so the script works in
sandboxes with only the standard library available.

Usage:
    python dump_text.py deck.pptx                 # plain, to stdout
    python dump_text.py deck.pptx --out deck.txt
    python dump_text.py deck.pptx --notes         # include speaker notes
    python dump_text.py deck.pptx --tables        # include table cells
    python dump_text.py deck.pptx --numbered      # prefix each slide with "N: "
    python dump_text.py deck.pptx --format md     # markdown output

Output formats:
    plain (default)  — one paragraph per line, blank line between slides
    md               — top-level heading per slide, bullets preserved,
                       notes emitted as a "> " block, tables as pipes
"""
from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path
from typing import Callable, Iterable

# Namespaces used throughout PresentationML slide markup.
NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pkg": "http://schemas.openxmlformats.org/package/2006/relationships",
}

_PRESENTATION = "ppt/presentation.xml"
_PRESENTATION_RELS = "ppt/_rels/presentation.xml.rels"


# ------------------------------------------------------------------ XML shim

try:
    from lxml import etree  # type: ignore

    def _parse(blob: bytes):
        return etree.fromstring(blob)

    def _findall(node, xpath: str):
        return node.xpath(xpath, namespaces=NS)

    def _findone(node, xpath: str):
        result = node.xpath(xpath, namespaces=NS)
        return result[0] if result else None

    def _tag(node) -> str:
        # lxml elements expose .tag as Clark notation; return the local name
        # with a leading namespace prefix drawn from NS for readability.
        raw = node.tag
        for prefix, uri in NS.items():
            marker = "{" + uri + "}"
            if raw.startswith(marker):
                return f"{prefix}:{raw[len(marker):]}"
        return raw

except ImportError:
    from xml.etree import ElementTree as etree  # type: ignore

    def _parse(blob: bytes):
        return etree.fromstring(blob)

    def _findall(node, xpath: str):
        # A minimal XPath subset works with ElementTree when the namespaces
        # are given explicitly. The queries used below fit that subset.
        return node.findall(xpath, NS)

    def _findone(node, xpath: str):
        return node.find(xpath, NS)

    def _tag(node) -> str:
        raw = node.tag
        for prefix, uri in NS.items():
            marker = "{" + uri + "}"
            if raw.startswith(marker):
                return f"{prefix}:{raw[len(marker):]}"
        return raw


# ---------------------------------------------------------- archive helpers

def _resolve(base: str, target: str) -> str:
    """Resolve a rels-file `Target` (which may include `../`) against a
    base directory, producing a canonical archive path."""
    if target.startswith("/"):
        return target.lstrip("/")
    stack: list[str] = []
    combined = f"{base}/{target}" if base else target
    for segment in combined.split("/"):
        if segment == "..":
            if stack:
                stack.pop()
        elif segment and segment != ".":
            stack.append(segment)
    return "/".join(stack)


def _read_rels(zf: zipfile.ZipFile, rels_path: str) -> dict[str, str]:
    """Return {relationship-id → archive-relative-target}."""
    if rels_path not in zf.namelist():
        return {}
    root = _parse(zf.read(rels_path))
    base = str(Path(rels_path).parent.parent.as_posix())  # `_rels/foo.rels` → `..`
    base = base if base != "." else ""
    resolved: dict[str, str] = {}
    for rel in _findall(root, "./pkg:Relationship"):
        rid = rel.get("Id")
        target = rel.get("Target") or ""
        mode = (rel.get("TargetMode") or "Internal").lower()
        if rid is None or mode != "internal":
            continue
        resolved[rid] = _resolve(base, target)
    return resolved


def _ordered_slide_parts(zf: zipfile.ZipFile) -> list[str]:
    if _PRESENTATION not in zf.namelist():
        return sorted(name for name in zf.namelist()
                      if name.startswith("ppt/slides/slide") and name.endswith(".xml"))
    presentation = _parse(zf.read(_PRESENTATION))
    rels = _read_rels(zf, _PRESENTATION_RELS)
    order: list[str] = []
    for sld_id in _findall(presentation, ".//p:sldIdLst/p:sldId"):
        rid = sld_id.get("{" + NS["r"] + "}id") or sld_id.get("r:id")
        if rid is None:
            continue
        target = rels.get(rid)
        if target and target in zf.namelist():
            order.append(target)
    return order


def _notes_for(zf: zipfile.ZipFile, slide_part: str) -> str | None:
    slide_name = Path(slide_part).name
    rels_path = f"ppt/slides/_rels/{slide_name}.rels"
    for target in _read_rels(zf, rels_path).values():
        if "notesSlides/" in target and target.endswith(".xml") and target in zf.namelist():
            return target
    return None


# --------------------------------------------------------- content extractors

def _run_text(run) -> str:
    return "".join(t.text for t in _findall(run, "./a:t") if t.text)


def _paragraph_text(paragraph) -> str:
    # a:br (line break) and a:fld (slide number / date fields) are siblings
    # of a:r inside a:p, so walk the paragraph children in document order.
    parts: list[str] = []
    for child in paragraph:
        name = _tag(child)
        if name == "a:r":
            parts.append(_run_text(child))
        elif name == "a:br":
            parts.append("\n")
        elif name == "a:fld":
            parts.append(_run_text(child))
    return "".join(parts)


def _slide_title(slide) -> str:
    for sp in _findall(slide, ".//p:sp"):
        for ph in _findall(sp, ".//p:nvSpPr/p:nvPr/p:ph"):
            if ph.get("type") in {"title", "ctrTitle"}:
                text = "".join(_paragraph_text(p) for p in _findall(sp, ".//a:p"))
                if text.strip():
                    return text.strip()
    return ""


def _paragraphs_with_bullet_flag(slide,
                                 skip_title: bool = False
                                 ) -> Iterable[tuple[str, bool, int]]:
    """Yield (text, has_bullet, indent_level) for every non-empty paragraph."""
    for sp in _findall(slide, ".//p:sp"):
        if skip_title:
            is_title = False
            for ph in _findall(sp, ".//p:nvSpPr/p:nvPr/p:ph"):
                if ph.get("type") in {"title", "ctrTitle"}:
                    is_title = True
                    break
            if is_title:
                continue
        for paragraph in _findall(sp, ".//a:p"):
            text = _paragraph_text(paragraph).strip()
            if not text:
                continue
            pPr = _findone(paragraph, "./a:pPr")
            has_bullet = False
            level = 0
            if pPr is not None:
                try:
                    level = int(pPr.get("lvl") or "0")
                except ValueError:
                    level = 0
                if _findone(pPr, "./a:buNone") is None:
                    for child in pPr:
                        if _tag(child).startswith("a:bu"):
                            has_bullet = True
                            break
            yield text, has_bullet, level


def _slide_tables_markdown(slide) -> Iterable[str]:
    for tbl in _findall(slide, ".//a:tbl"):
        rows: list[list[str]] = []
        for tr in _findall(tbl, ".//a:tr"):
            row: list[str] = []
            for tc in _findall(tr, ".//a:tc"):
                cell = " ".join(_paragraph_text(p) for p in _findall(tc, ".//a:p")).strip()
                row.append(cell.replace("|", "\\|") or " ")
            rows.append(row)
        if not rows:
            continue
        width = max(len(r) for r in rows)
        rows = [r + [" "] * (width - len(r)) for r in rows]
        yield ""
        yield "| " + " | ".join(rows[0]) + " |"
        yield "| " + " | ".join("---" for _ in range(width)) + " |"
        for r in rows[1:]:
            yield "| " + " | ".join(r) + " |"


def _slide_tables_tsv(slide) -> Iterable[str]:
    for tbl in _findall(slide, ".//a:tbl"):
        for tr in _findall(tbl, ".//a:tr"):
            cells: list[str] = []
            for tc in _findall(tr, ".//a:tc"):
                text = " ".join(_paragraph_text(p) for p in _findall(tc, ".//a:p")).strip()
                cells.append(text)
            yield "\t".join(cells)


def _notes_lines(zf: zipfile.ZipFile, notes_part: str) -> list[str]:
    try:
        notes = _parse(zf.read(notes_part))
    except Exception:
        return []
    out: list[str] = []
    for sp in _findall(notes, ".//p:sp"):
        skip = False
        for ph in _findall(sp, ".//p:nvSpPr/p:nvPr/p:ph"):
            if ph.get("type") in {"sldImg", "sldNum"}:
                skip = True
                break
        if skip:
            continue
        for paragraph in _findall(sp, ".//a:p"):
            text = _paragraph_text(paragraph).strip()
            if text:
                out.append(text)
    return out


# ------------------------------------------------------------- output modes

def _render_plain(slide, *, include_tables: bool) -> list[str]:
    out = [text for text, _bullet, _lvl in _paragraphs_with_bullet_flag(slide)]
    if include_tables:
        out.extend(_slide_tables_tsv(slide))
    return out


def _render_markdown(slide, slide_number: int) -> list[str]:
    title = _slide_title(slide)
    heading = f"# Slide {slide_number}" + (f": {title}" if title else "")
    out: list[str] = [heading, ""]
    for text, bullet, level in _paragraphs_with_bullet_flag(slide, skip_title=True):
        if bullet:
            out.append("  " * level + "- " + text)
        else:
            out.append(text)
    out.extend(_slide_tables_markdown(slide))
    return out


Renderer = Callable[..., list[str]]


def dump(path: Path, *,
         fmt: str = "plain",
         include_tables: bool = False,
         include_notes: bool = False,
         numbered: bool = False) -> str:
    if not path.is_file():
        raise SystemExit(f"{path} is not a file")

    chunks: list[str] = []
    with zipfile.ZipFile(path) as zf:
        for i, slide_part in enumerate(_ordered_slide_parts(zf), start=1):
            try:
                slide = _parse(zf.read(slide_part))
            except Exception as exc:
                print(f"warning: {slide_part}: {exc}", file=sys.stderr)
                continue

            if fmt == "md":
                lines = _render_markdown(slide, i)
            else:
                lines = _render_plain(slide, include_tables=include_tables)
                if numbered and lines:
                    lines = [f"{i}: {lines[0]}", *lines[1:]]

            if include_notes:
                notes_part = _notes_for(zf, slide_part)
                if notes_part:
                    notes = _notes_lines(zf, notes_part)
                    if notes:
                        if fmt == "md":
                            lines.append("")
                            lines.append("> **Speaker notes**")
                            lines.extend(f"> {ln}" for ln in notes)
                        else:
                            lines.append("--- notes ---")
                            lines.extend(notes)

            if lines:
                chunks.extend(lines)
                chunks.append("")

    return "\n".join(chunks).rstrip() + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("source", type=Path)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--format", dest="fmt", choices=("plain", "md"),
                    default="plain",
                    help="output format (default: plain)")
    ap.add_argument("--notes", action="store_true",
                    help="include speaker notes")
    ap.add_argument("--tables", action="store_true",
                    help="include table cells (tab-separated, plain mode only)")
    ap.add_argument("--numbered", action="store_true",
                    help="prefix each slide's first line with 'N: '")
    ns = ap.parse_args(argv)

    try:
        text = dump(ns.source,
                    fmt=ns.fmt,
                    include_tables=ns.tables,
                    include_notes=ns.notes,
                    numbered=ns.numbered)
    except zipfile.BadZipFile as exc:
        print(f"error: {ns.source} is not a valid .pptx: {exc}", file=sys.stderr)
        return 2

    if ns.out is None:
        sys.stdout.write(text)
    else:
        ns.out.parent.mkdir(parents=True, exist_ok=True)
        ns.out.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
