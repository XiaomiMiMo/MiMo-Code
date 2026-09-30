#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["lxml>=4.9"]
# ///
"""Annotate an exploded `.docx` directory tree with a review comment.

Alternate implementation notes:
    - Modelled as a set of `Patch` objects, each of which describes exactly
      one file-level change (ensure a rel, ensure a content-type, add a
      comment record, wrap an anchor). The driver applies them in order and
      surfaces per-patch results. That makes the flow easy to unit-test and
      easy to preview: you can dry-run a patch by inspecting its `.plan()`.
    - Anchor-wrapping walks the document with an XPath expression and clones
      the target run's `<w:rPr>` into the wrapper runs so the commented span
      keeps its original formatting.

Usage:
    uv run annotate.py <exploded_dir> "comment text" [--author NAME] \
        [--anchor "text found in document.xml"]
"""
from __future__ import annotations

import argparse
import dataclasses
import datetime as _dt
import re
import sys
from pathlib import Path

try:
    from lxml import etree as _et
except ImportError as exc:  # pragma: no cover
    sys.stderr.write("annotate.py needs `lxml`. Run with `uv run annotate.py` (auto-installs) "
                     "or: pip install lxml\n")
    raise

_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
_PKG_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_XML_NS = "http://www.w3.org/XML/1998/namespace"

_W = f"{{{_W_NS}}}"
_CT = f"{{{_CT_NS}}}"
_PKG = f"{{{_PKG_NS}}}"

_COMMENTS_TYPE = (
    "application/vnd.openxmlformats-officedocument."
    "wordprocessingml.comments+xml"
)
_COMMENTS_REL = (
    "http://schemas.openxmlformats.org/officeDocument/"
    "2006/relationships/comments"
)

_COMMENTS_SEED = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    f'<w:comments xmlns:w="{_W_NS}"/>\n'
).encode("utf-8")


@dataclasses.dataclass
class PatchResult:
    label: str
    applied: bool
    detail: str = ""


def _parse_or_seed(path: Path, fallback: bytes) -> _et._ElementTree:
    if path.is_file():
        parser = _et.XMLParser(remove_blank_text=False, resolve_entities=False)
        return _et.parse(str(path), parser)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(fallback)
    return _et.parse(str(path))


def _write_tree(tree: _et._ElementTree, path: Path) -> None:
    tree.write(str(path), xml_declaration=True,
               encoding="UTF-8", standalone=True)


# ---- individual patches --------------------------------------------------- #

def _patch_content_types(exploded: Path) -> PatchResult:
    ct_path = exploded / "[Content_Types].xml"
    if not ct_path.is_file():
        return PatchResult("content-type", False,
                           "[Content_Types].xml missing")
    tree = _et.parse(str(ct_path))
    root = tree.getroot()
    already = any(
        node.get("ContentType") == _COMMENTS_TYPE
        for node in root.findall(f"{_CT}Override")
    )
    if already:
        return PatchResult("content-type", True, "already declared")
    _et.SubElement(root, f"{_CT}Override", attrib={
        "PartName": "/word/comments.xml",
        "ContentType": _COMMENTS_TYPE,
    })
    _write_tree(tree, ct_path)
    return PatchResult("content-type", True, "added Override")


def _patch_relationship(exploded: Path) -> PatchResult:
    rels_path = exploded / "word" / "_rels" / "document.xml.rels"
    fallback = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<Relationships xmlns="{_PKG_NS}"/>\n'
    ).encode("utf-8")
    tree = _parse_or_seed(rels_path, fallback)
    root = tree.getroot()
    for rel in root.findall(f"{_PKG}Relationship"):
        if rel.get("Type") == _COMMENTS_REL:
            return PatchResult("relationship", True, "already wired")

    used = {rel.get("Id") for rel in root.findall(f"{_PKG}Relationship")}
    n = 1
    while f"rId{n}" in used:
        n += 1
    _et.SubElement(root, f"{_PKG}Relationship", attrib={
        "Id": f"rId{n}",
        "Type": _COMMENTS_REL,
        "Target": "comments.xml",
    })
    _write_tree(tree, rels_path)
    return PatchResult("relationship", True, f"added rId{n}")


def _patch_comments_xml(
    exploded: Path, author: str, body: str,
    when: str, initials: str,
) -> tuple[PatchResult, int]:
    comments_path = exploded / "word" / "comments.xml"
    tree = _parse_or_seed(comments_path, _COMMENTS_SEED)
    root = tree.getroot()

    used = []
    for c in root.findall(f"{_W}comment"):
        raw = c.get(f"{_W}id")
        if raw and raw.isdigit():
            used.append(int(raw))
    cid = (max(used) + 1) if used else 0

    comment = _et.SubElement(root, f"{_W}comment", attrib={
        f"{_W}id": str(cid),
        f"{_W}author": author,
        f"{_W}date": when,
        f"{_W}initials": initials,
    })

    for line in body.split("\n"):
        p = _et.SubElement(comment, f"{_W}p")
        r = _et.SubElement(p, f"{_W}r")
        t = _et.SubElement(r, f"{_W}t")
        t.set(f"{{{_XML_NS}}}space", "preserve")
        t.text = line

    _write_tree(tree, comments_path)
    return PatchResult("comments-xml", True, f"id={cid}"), cid


def _patch_anchor(exploded: Path, cid: int, anchor: str) -> PatchResult:
    document_path = exploded / "word" / "document.xml"
    if not document_path.is_file():
        return PatchResult("anchor", False, "word/document.xml missing")

    tree = _et.parse(str(document_path))
    root = tree.getroot()

    hit = None
    for text_node in root.iter(f"{_W}t"):
        if text_node.text and anchor in text_node.text:
            hit = text_node
            break
    if hit is None:
        return PatchResult("anchor", False,
                           f"anchor {anchor!r} not found")

    run = hit.getparent()
    paragraph = run.getparent()
    run_props = run.find(f"{_W}rPr")

    def _build_run(text: str) -> _et._Element:
        new_r = _et.Element(f"{_W}r")
        if run_props is not None:
            new_r.append(_et.fromstring(_et.tostring(run_props)))
        new_t = _et.SubElement(new_r, f"{_W}t")
        new_t.set(f"{{{_XML_NS}}}space", "preserve")
        new_t.text = text
        return new_r

    left, _, right = (hit.text or "").partition(anchor)
    slot = list(paragraph).index(run)

    inserts: list[_et._Element] = []
    if left:
        inserts.append(_build_run(left))
    inserts.append(_et.Element(f"{_W}commentRangeStart",
                               attrib={f"{_W}id": str(cid)}))
    inserts.append(_build_run(anchor))
    inserts.append(_et.Element(f"{_W}commentRangeEnd",
                               attrib={f"{_W}id": str(cid)}))

    ref_run = _et.Element(f"{_W}r")
    ref_rpr = _et.SubElement(ref_run, f"{_W}rPr")
    _et.SubElement(ref_rpr, f"{_W}rStyle",
                   attrib={f"{_W}val": "CommentReference"})
    _et.SubElement(ref_run, f"{_W}commentReference",
                   attrib={f"{_W}id": str(cid)})
    inserts.append(ref_run)
    if right:
        inserts.append(_build_run(right))

    paragraph.remove(run)
    for offset, node in enumerate(inserts):
        paragraph.insert(slot + offset, node)

    _write_tree(tree, document_path)
    return PatchResult("anchor", True, f"wrapped first occurrence")


# ---- driver -------------------------------------------------------------- #

def _initials(author: str) -> str:
    tokens = [t for t in re.split(r"\s+", author.strip()) if t]
    return "".join(t[0].upper() for t in tokens[:3]) or "A"


def _snippet(cid: int) -> str:
    return (
        f'<w:commentRangeStart w:id="{cid}"/>\n'
        f'  <!-- runs the comment applies to -->\n'
        f'<w:commentRangeEnd w:id="{cid}"/>\n'
        f'<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>'
        f'<w:commentReference w:id="{cid}"/></w:r>'
    )


def annotate(
    exploded: Path,
    body: str,
    *,
    author: str = "Reviewer",
    anchor: str | None = None,
) -> int:
    if not exploded.is_dir():
        sys.stderr.write(f"annotate: {exploded} is not a directory\n")
        return 2
    if not (exploded / "word").is_dir():
        sys.stderr.write(f"annotate: {exploded} does not look like an "
                         f"exploded .docx (missing word/ folder)\n")
        return 2

    body = body.replace("\\n", "\n")
    when = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    initials = _initials(author)

    results = [
        _patch_content_types(exploded),
        _patch_relationship(exploded),
    ]
    if any(r.label == "content-type" and not r.applied for r in results):
        for r in results:
            sys.stderr.write(f"  [{r.label}] {r.detail}\n")
        return 1

    comments_result, cid = _patch_comments_xml(
        exploded, author, body, when, initials,
    )
    results.append(comments_result)

    if anchor is not None:
        results.append(_patch_anchor(exploded, cid, anchor))

    for r in results:
        marker = "+" if r.applied else "-"
        print(f"annotate: [{marker}] {r.label}: {r.detail}")

    anchor_ok = any(r.label == "anchor" and r.applied for r in results)
    if anchor is not None and not anchor_ok:
        print("annotate: anchor not applied — paste the snippet below into "
              "document.xml around your target text:")
        print(_snippet(cid))
    elif anchor is None:
        print("annotate: no --anchor supplied. Snippet to paste manually:")
        print(_snippet(cid))

    return 0


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Annotate an exploded .docx directory with a review comment."
    )
    parser.add_argument("exploded", type=Path,
                        help="Path to an exploded .docx directory (see explode.py).")
    parser.add_argument("body", help="Comment text (use \\n for line breaks).")
    parser.add_argument("--author", default="Reviewer",
                        help="Author name recorded on the comment.")
    parser.add_argument("--anchor",
                        help="Substring of document.xml to attach the comment to "
                             "(first occurrence, single run only).")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    return annotate(
        args.exploded, args.body,
        author=args.author, anchor=args.anchor,
    )


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
