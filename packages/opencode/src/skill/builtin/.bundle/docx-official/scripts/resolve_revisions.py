#!/usr/bin/env python3
"""Resolve every tracked revision in a `.docx` (accept-all semantics).

Alternate implementation notes:
    - Instead of hand-writing per-element replace loops, this version leans
      on `lxml.etree.strip_tags` (unwraps elements, keeps content) and
      `lxml.etree.strip_elements` (removes elements and their subtrees).
      Those two primitives cover all the resolution semantics needed here.
    - Paragraph-mark deletion is handled last, as its own explicit pass,
      because it changes document topology (merges two <w:p>s) and can't be
      expressed as a strip_* call.
    - Runs across every OOXML part that may host revisions (document body,
      headers/footers, foot/end-notes, comment bodies). Each is a small
      XSLT-shaped transform.

Usage:
    python resolve_revisions.py <input.docx> <output.docx>
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
    sys.stderr.write("resolve_revisions.py needs `lxml`. "
                     "Install with: pip install lxml\n")
    raise

_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_W = f"{{{_W_NS}}}"

# Elements that behave like "keep the content, drop the wrapper" on accept.
_KEEP_CONTENT = (f"{_W}ins", f"{_W}moveTo")
# Elements that behave like "drop the whole subtree" on accept.
_DROP_SUBTREE = (
    f"{_W}del", f"{_W}moveFrom",
    f"{_W}moveFromRangeStart", f"{_W}moveFromRangeEnd",
    f"{_W}moveToRangeStart", f"{_W}moveToRangeEnd",
    f"{_W}pPrChange", f"{_W}rPrChange", f"{_W}sectPrChange",
    f"{_W}tblPrChange", f"{_W}tblPrExChange",
    f"{_W}tcPrChange", f"{_W}trPrChange",
    f"{_W}tblGridChange", f"{_W}numberingChange",
    f"{_W}cellIns", f"{_W}cellDel", f"{_W}cellMerge",
)


def _retag_deltext_to_text(root: _et._Element) -> None:
    """Any <w:delText> that survived (inside a kept <w:ins>) becomes <w:t>,
    and <w:delInstrText> becomes <w:instrText>."""
    for elem in root.iter(f"{_W}delText"):
        elem.tag = f"{_W}t"
    for elem in root.iter(f"{_W}delInstrText"):
        elem.tag = f"{_W}instrText"


def _merge_paragraph_marks(root: _et._Element) -> None:
    """Accept `<w:pPr>/<w:rPr>/<w:del>` — merge this <w:p> with the next one."""
    marker_xpath = _et.XPath(
        ".//w:p[w:pPr/w:rPr/w:del]",
        namespaces={"w": _W_NS},
    )

    # Materialise the list — mutation invalidates lazy iteration.
    doomed = list(marker_xpath(root))
    for paragraph in doomed:
        pPr = paragraph.find(f"{_W}pPr")
        rPr = pPr.find(f"{_W}rPr")
        marker = rPr.find(f"{_W}del")
        rPr.remove(marker)

        parent = paragraph.getparent()
        if parent is None:
            continue
        # Find the next <w:p> sibling within the same container.
        follower = None
        for sib in paragraph.itersiblings():
            if sib.tag == f"{_W}p":
                follower = sib
                break
        content = [child for child in paragraph if child.tag != f"{_W}pPr"]

        if follower is None:
            # Nothing to merge into — keep the paragraph in place (just
            # without the deletion marker) so we don't lose its runs.
            continue

        follower_pPr = follower.find(f"{_W}pPr")
        anchor = 0 if follower_pPr is None else list(follower).index(follower_pPr) + 1
        for offset, child in enumerate(content):
            follower.insert(anchor + offset, child)
        parent.remove(paragraph)


def _resolve(root: _et._Element) -> None:
    """Apply all resolution passes to `root` in-place."""
    # Order matters:
    #   1. Unwrap "insert-like" first so we don't accidentally strip content
    #      that later needs re-tagging.
    _et.strip_tags(root, *_KEEP_CONTENT)
    #   2. Retag any leftover delText that ended up inside a kept insert.
    _retag_deltext_to_text(root)
    #   3. Drop delete-like subtrees.
    _et.strip_elements(root, *_DROP_SUBTREE, with_tail=False)
    #   4. Finally, merge paragraphs whose pilcrow was deleted.
    _merge_paragraph_marks(root)


def _parts_to_touch(zf: zipfile.ZipFile) -> Iterable[str]:
    """Every .xml inside word/ that might contain revision marks."""
    for info in zf.infolist():
        name = info.filename
        if not name.startswith("word/"):
            continue
        if not name.endswith(".xml"):
            continue
        base = Path(name).name
        if (
            base in {"document.xml", "footnotes.xml", "endnotes.xml", "comments.xml"}
            or base.startswith(("header", "footer"))
        ):
            yield name


def _transform_bytes(payload: bytes) -> bytes:
    parser = _et.XMLParser(remove_blank_text=False, resolve_entities=False)
    root = _et.fromstring(payload, parser)
    _resolve(root)
    return _et.tostring(
        root, xml_declaration=True, encoding="UTF-8", standalone=True
    )


def resolve_revisions(source: Path, destination: Path) -> int:
    if not source.is_file():
        sys.stderr.write(f"resolve_revisions: {source} is not a file\n")
        return 2
    destination.parent.mkdir(parents=True, exist_ok=True)

    touched = 0
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(
        destination, "w", compression=zipfile.ZIP_DEFLATED,
    ) as zout:
        candidates = set(_parts_to_touch(zin))
        for info in zin.infolist():
            data = zin.read(info)
            if info.filename in candidates:
                try:
                    updated = _transform_bytes(data)
                    if updated != data:
                        touched += 1
                    data = updated
                except _et.XMLSyntaxError as exc:
                    sys.stderr.write(
                        f"resolve_revisions: skipping {info.filename}: {exc}\n"
                    )
            zout.writestr(info, data)

    print(f"resolve_revisions: {touched} part(s) rewritten → {destination}")
    return 0


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Accept every tracked change in a .docx and write a clean copy."
    )
    parser.add_argument("source", type=Path, help="Source .docx")
    parser.add_argument("destination", type=Path, help="Destination .docx")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    return resolve_revisions(args.source, args.destination)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
