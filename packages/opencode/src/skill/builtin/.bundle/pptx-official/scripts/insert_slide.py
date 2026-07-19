#!/usr/bin/env python3
"""Insert a slide into an exploded .pptx tree.

Two modes:

    --clone slide3.xml            deep-copy an existing slide part (shapes,
                                  its rels file, and any notes reference —
                                  charts and embedded objects survive when
                                  their target parts are shared)

    --blank-from slideLayout5.xml create a fresh slide bound to the given
                                  layout, with no shapes yet (only the
                                  group-shape sentinel required by the
                                  PresentationML schema)

Both modes:
  - write the new slide part into `ppt/slides/slideN.xml`
  - write its `_rels/slideN.xml.rels` referencing the target layout
  - allocate a fresh `<Relationship>` in `ppt/_rels/presentation.xml.rels`
  - add an `<Override>` in `[Content_Types].xml`
  - print the `<p:sldId>` element you must paste into `<p:sldIdLst>` at
    the position you want the slide to appear

The script deliberately stops short of inserting the `<p:sldId>` because
"where in the deck?" is a decision only the caller can make.

Usage:
    python insert_slide.py unpacked/ --clone slide3.xml
    python insert_slide.py unpacked/ --blank-from slideLayout5.xml
"""
from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

try:
    from lxml import etree
    _HAS_LXML = True
except ImportError:
    from xml.etree import ElementTree as etree  # type: ignore
    _HAS_LXML = False

NS = {
    "pkg": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
CT_SLIDE = ("application/vnd.openxmlformats-officedocument."
            "presentationml.slide+xml")
REL_TYPE_SLIDE = ("http://schemas.openxmlformats.org/officeDocument/2006/"
                  "relationships/slide")
REL_TYPE_LAYOUT = ("http://schemas.openxmlformats.org/officeDocument/2006/"
                   "relationships/slideLayout")

_EMPTY_SLIDE_XML = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"\
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"\
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sld>
"""


class InsertionError(RuntimeError):
    pass


# ---------- XML helpers -----------------------------------------------------

def _parse(path: Path):
    return etree.parse(str(path))


def _write(tree, path: Path) -> None:
    if _HAS_LXML:
        tree.write(str(path), xml_declaration=True, encoding="UTF-8",
                   standalone=True)
    else:
        # ElementTree doesn't emit standalone="yes" by itself
        blob = etree.tostring(tree.getroot(), encoding="UTF-8",
                              xml_declaration=True)
        if not blob.endswith(b"\n"):
            blob += b"\n"
        path.write_bytes(blob)


def _findall(root, path: str):
    if _HAS_LXML:
        return root.xpath(path, namespaces=NS)
    return root.findall(path, NS)


def _rels_element(id_: str, rel_type: str, target: str):
    qname = "{" + NS["pkg"] + "}Relationship"
    if _HAS_LXML:
        el = etree.Element(qname, nsmap={None: NS["pkg"]})
    else:
        el = etree.Element(qname)
    el.set("Id", id_)
    el.set("Type", rel_type)
    el.set("Target", target)
    return el


# ---------- ID allocation ---------------------------------------------------

def _next_slide_number(slides_dir: Path) -> int:
    highest = 0
    for entry in slides_dir.glob("slide*.xml"):
        match = re.fullmatch(r"slide(\d+)\.xml", entry.name)
        if match:
            highest = max(highest, int(match.group(1)))
    return highest + 1


def _next_rid(rels_root) -> str:
    used = {rel.get("Id") for rel in _findall(rels_root, ".//pkg:Relationship")}
    n = 1
    while f"rId{n}" in used:
        n += 1
    return f"rId{n}"


def _next_sld_id(presentation_root, hint: int) -> int:
    """Return an unused numeric id ≥ 256, biased toward `hint` so back-to-back
    invocations without an intervening `<p:sldIdLst>` edit stay unique."""
    used: set[int] = set()
    for sld in _findall(presentation_root, ".//p:sldIdLst/p:sldId"):
        try:
            used.add(int(sld.get("id") or 0))
        except ValueError:
            pass
    candidate = max(255 + hint, 255) + 1
    while candidate in used:
        candidate += 1
    return candidate


# ---------- Content_Types.xml maintenance -----------------------------------

def _register_content_type(ct_path: Path, part_name: str,
                           content_type: str) -> None:
    tree = _parse(ct_path)
    root = tree.getroot()
    for override in _findall(root, "./ct:Override"):
        if override.get("PartName") == part_name:
            return

    qname = "{" + NS["ct"] + "}Override"
    if _HAS_LXML:
        override = etree.SubElement(root, qname)
    else:
        override = etree.SubElement(root, qname)
    override.set("PartName", part_name)
    override.set("ContentType", content_type)
    _write(tree, ct_path)


# ---------- slide creation --------------------------------------------------

def _make_layout_rels(new_slide_rels: Path, layout_name: str) -> None:
    qname_root = "{" + NS["pkg"] + "}Relationships"
    root = etree.Element(qname_root) if not _HAS_LXML else etree.Element(
        qname_root, nsmap={None: NS["pkg"]})
    root.append(_rels_element("rId1", REL_TYPE_LAYOUT,
                              f"../slideLayouts/{layout_name}"))
    tree = etree.ElementTree(root) if not _HAS_LXML else etree.ElementTree(root)
    _write(tree, new_slide_rels)


def _create_clone(unpacked: Path, source_name: str) -> Path:
    slides_dir = unpacked / "ppt" / "slides"
    src = slides_dir / source_name
    if not src.is_file():
        raise InsertionError(f"source slide not found: {src}")

    new_number = _next_slide_number(slides_dir)
    dst = slides_dir / f"slide{new_number}.xml"
    shutil.copyfile(src, dst)

    src_rels = slides_dir / "_rels" / f"{source_name}.rels"
    dst_rels = slides_dir / "_rels" / f"{dst.name}.rels"
    dst_rels.parent.mkdir(exist_ok=True)
    if src_rels.is_file():
        shutil.copyfile(src_rels, dst_rels)
    return dst


def _create_blank(unpacked: Path, layout_name: str) -> Path:
    slides_dir = unpacked / "ppt" / "slides"
    slides_dir.mkdir(parents=True, exist_ok=True)
    (slides_dir / "_rels").mkdir(exist_ok=True)

    layout_path = unpacked / "ppt" / "slideLayouts" / layout_name
    if not layout_path.is_file():
        raise InsertionError(f"layout not found: {layout_path}")

    new_number = _next_slide_number(slides_dir)
    dst = slides_dir / f"slide{new_number}.xml"
    dst.write_bytes(_EMPTY_SLIDE_XML)

    _make_layout_rels(slides_dir / "_rels" / f"{dst.name}.rels", layout_name)
    return dst


# ---------- top-level -------------------------------------------------------

def insert(unpacked: Path, mode: str, name: str) -> tuple[Path, str, int]:
    """Insert a slide and return (new_slide_path, rId, numeric_id)."""
    if not unpacked.is_dir():
        raise InsertionError(f"{unpacked} is not a directory")

    if mode == "clone":
        slide_path = _create_clone(unpacked, name)
    elif mode == "blank":
        slide_path = _create_blank(unpacked, name)
    else:
        raise InsertionError(f"unknown mode: {mode}")

    # Register in presentation.xml.rels
    pres_rels_path = unpacked / "ppt" / "_rels" / "presentation.xml.rels"
    if not pres_rels_path.is_file():
        raise InsertionError(f"missing: {pres_rels_path}")
    pres_rels_tree = _parse(pres_rels_path)
    pres_rels_root = pres_rels_tree.getroot()
    new_rid = _next_rid(pres_rels_root)
    pres_rels_root.append(_rels_element(
        new_rid, REL_TYPE_SLIDE, f"slides/{slide_path.name}"))
    _write(pres_rels_tree, pres_rels_path)

    # Register in Content_Types.xml
    _register_content_type(
        unpacked / "[Content_Types].xml",
        f"/ppt/slides/{slide_path.name}",
        CT_SLIDE,
    )

    # Determine a numeric id for the caller-inserted <p:sldId>
    pres_path = unpacked / "ppt" / "presentation.xml"
    if not pres_path.is_file():
        raise InsertionError(f"missing: {pres_path}")
    pres_tree = _parse(pres_path)
    hint_match = re.fullmatch(r"slide(\d+)\.xml", slide_path.name)
    hint = int(hint_match.group(1)) if hint_match else 0
    numeric_id = _next_sld_id(pres_tree.getroot(), hint=hint)

    return slide_path, new_rid, numeric_id


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("unpacked", type=Path,
                    help="path to the exploded tree (as produced by explode.py)")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--clone", metavar="slideN.xml",
                       help="duplicate an existing slide by file name")
    group.add_argument("--blank-from", metavar="slideLayoutN.xml",
                       dest="blank_from",
                       help="create a blank slide bound to the given layout")
    ns = ap.parse_args(argv)

    mode = "clone" if ns.clone else "blank"
    name = ns.clone or ns.blank_from

    try:
        slide_path, rid, numeric_id = insert(ns.unpacked, mode, name)
    except InsertionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"created {slide_path.relative_to(ns.unpacked)}")
    print("paste this <p:sldId> into <p:sldIdLst> at the desired position:")
    print(f'  <p:sldId id="{numeric_id}" r:id="{rid}"/>')
    return 0


if __name__ == "__main__":
    sys.exit(main())
