#!/usr/bin/env python3
"""Prune unreachable parts from an exploded .pptx tree.

Reachability algorithm:

  1. Start from `_rels/.rels` — the root manifest of the package.
  2. Walk every internal `<Relationship>` transitively (each part with a
     paired `_rels/<name>.rels` file has more relationships to follow).
  3. Whatever is reached is kept.
  4. From the reachable set, filter one step further:
       - a slide is only kept if its `rId` also appears in `<p:sldIdLst>`
         inside `ppt/presentation.xml` (a slide file can be "reachable"
         via a Relationship but hidden because its sldId was deleted).
       - a notesSlide is only kept if the slide it belongs to survived.

Anything under `ppt/slides/`, `ppt/notesSlides/`, `ppt/media/` that is not
in the surviving set is deleted, together with:
  - the corresponding entries in `presentation.xml.rels`, and
  - the corresponding `<Override>` entries in `[Content_Types].xml`.

Other categories of parts (themes, masters, layouts, docProps) are left
alone — pruning them requires far more context than this script has.

Usage:
    python prune.py unpacked/
    python prune.py unpacked/ --dry-run
"""
from __future__ import annotations

import argparse
import sys
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "pkg": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

_PRUNABLE_PREFIXES = ("ppt/slides/", "ppt/notesSlides/", "ppt/media/")


@dataclass
class PruneReport:
    slides: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    media: list[str] = field(default_factory=list)
    presentation_rels: list[str] = field(default_factory=list)
    content_type_overrides: list[str] = field(default_factory=list)

    @property
    def total_files(self) -> int:
        return len(self.slides) + len(self.notes) + len(self.media)


# ------------------------------------------------------------ path resolver

def _canonicalise(base: str, target: str) -> str:
    """Return an archive-relative path for a Relationship Target.

    `base` is the archive-relative directory of the containing rels file
    (e.g. for `ppt/slides/_rels/slide1.xml.rels`, base is `ppt/slides`).
    """
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


def _rels_targets(root, base: str) -> list[tuple[str, str, str]]:
    """Return (rId, type, canonical-target) for every internal relationship."""
    out: list[tuple[str, str, str]] = []
    for rel in root.findall(f".//{{{NS['pkg']}}}Relationship"):
        mode = (rel.get("TargetMode") or "Internal").lower()
        if mode != "internal":
            continue
        rid = rel.get("Id") or ""
        rtype = rel.get("Type") or ""
        target = rel.get("Target") or ""
        out.append((rid, rtype, _canonicalise(base, target)))
    return out


# ------------------------------------------------------------ graph walker

def _rels_path_for(part: str) -> str:
    parent = str(Path(part).parent.as_posix())
    return f"{parent}/_rels/{Path(part).name}.rels" if parent else f"_rels/{Path(part).name}.rels"


def _reachable_parts(root: Path) -> set[str]:
    """BFS from `_rels/.rels`, following every internal Relationship."""
    reachable: set[str] = set()
    queue: deque[str] = deque()

    root_rels = root / "_rels" / ".rels"
    if not root_rels.is_file():
        return reachable

    def enqueue_from(rels_file: Path, base: str) -> None:
        try:
            xml = ET.fromstring(rels_file.read_bytes())
        except ET.ParseError:
            return
        for _rid, _type, target in _rels_targets(xml, base):
            if target and target not in reachable:
                reachable.add(target)
                queue.append(target)

    enqueue_from(root_rels, "")
    while queue:
        part = queue.popleft()
        # Does this part have its own rels file?
        rels_path = root / _rels_path_for(part)
        if rels_path.is_file():
            enqueue_from(rels_path, str(Path(part).parent.as_posix()))
    return reachable


# ---------------------------------------------------- sldIdLst filter step

def _visible_slide_targets(root: Path) -> set[str]:
    presentation = root / "ppt" / "presentation.xml"
    pres_rels = root / "ppt" / "_rels" / "presentation.xml.rels"
    if not presentation.is_file() or not pres_rels.is_file():
        return set()

    rels_root = ET.fromstring(pres_rels.read_bytes())
    rid_to_target: dict[str, str] = {}
    for rid, _rtype, target in _rels_targets(rels_root, "ppt"):
        rid_to_target[rid] = target

    pres_root = ET.fromstring(presentation.read_bytes())
    visible: set[str] = set()
    for sld in pres_root.findall(f".//{{{NS['p']}}}sldIdLst/{{{NS['p']}}}sldId"):
        rid = sld.get(f"{{{NS['r']}}}id")
        if rid and rid in rid_to_target:
            visible.add(rid_to_target[rid])
    return visible


def _notes_target_for(slide_part: str, root: Path) -> str | None:
    rels_path = root / _rels_path_for(slide_part)
    if not rels_path.is_file():
        return None
    xml = ET.fromstring(rels_path.read_bytes())
    for _rid, _rtype, target in _rels_targets(xml, str(Path(slide_part).parent.as_posix())):
        if target.startswith("ppt/notesSlides/") and target.endswith(".xml"):
            return target
    return None


# ------------------------------------------------------------ deletion step

def _delete_part(root: Path, part_archive_path: str) -> None:
    disk_path = root / part_archive_path
    if disk_path.is_file():
        disk_path.unlink()
    rels_path = root / _rels_path_for(part_archive_path)
    if rels_path.is_file():
        rels_path.unlink()


def _drop_presentation_rels(root: Path, doomed_slide_parts: set[str]) -> list[str]:
    pres_rels = root / "ppt" / "_rels" / "presentation.xml.rels"
    if not pres_rels.is_file():
        return []
    xml_root = ET.fromstring(pres_rels.read_bytes())
    removed_rids: list[str] = []
    for rel in list(xml_root.findall(f".//{{{NS['pkg']}}}Relationship")):
        target = rel.get("Target") or ""
        canonical = _canonicalise("ppt", target)
        if canonical in doomed_slide_parts:
            xml_root.remove(rel)
            removed_rids.append(rel.get("Id") or "")
    if removed_rids:
        pres_rels.write_bytes(_serialise(xml_root, NS["pkg"]))
    return removed_rids


def _drop_content_type_overrides(root: Path,
                                 doomed_parts: set[str]) -> list[str]:
    ct_path = root / "[Content_Types].xml"
    if not ct_path.is_file():
        return []
    ct_root = ET.fromstring(ct_path.read_bytes())
    removed: list[str] = []
    for override in list(ct_root.findall(f".//{{{NS['ct']}}}Override")):
        part_name = override.get("PartName") or ""
        canonical = part_name.lstrip("/")
        if canonical in doomed_parts:
            ct_root.remove(override)
            removed.append(part_name)
    if removed:
        ct_path.write_bytes(_serialise(ct_root))
    return removed


def _serialise(root_elem, default_ns: str = NS["ct"]) -> bytes:
    # Keep the file's default namespace default — ns0:-prefixed rels /
    # content-types files choke naive OPC consumers.
    ET.register_namespace("", default_ns)
    blob = ET.tostring(root_elem, encoding="UTF-8", xml_declaration=True)
    return blob if blob.endswith(b"\n") else blob + b"\n"


# ---------------------------------------------------------------- driver

def prune_tree(root: Path, *, dry_run: bool = False) -> PruneReport:
    if not root.is_dir():
        raise SystemExit(f"{root} is not a directory")

    reachable = _reachable_parts(root)
    visible_slides = _visible_slide_targets(root)

    reachable_slides = {p for p in reachable
                        if p.startswith("ppt/slides/") and p.endswith(".xml")}
    if reachable_slides and not visible_slides:
        # An empty visible set on a deck that clearly has slides means
        # presentation.xml (or its rels) is missing/unreadable — deleting
        # every slide would destroy the deck, so refuse instead.
        raise RuntimeError(
            "could not read any slide ids from ppt/presentation.xml "
            "<p:sldIdLst>; refusing to prune — inspect the tree first")

    # Slides reachable but not visible -> doomed. Also all their notes.
    doomed_slides: set[str] = set()
    for part in reachable_slides:
        if part not in visible_slides:
            doomed_slides.add(part)

    # Any file on disk under ppt/slides/ that's not reachable is also doomed.
    for slide_file in (root / "ppt" / "slides").glob("slide*.xml") \
            if (root / "ppt" / "slides").is_dir() else []:
        archive = f"ppt/slides/{slide_file.name}"
        if archive not in reachable:
            doomed_slides.add(archive)

    doomed_notes: set[str] = set()
    surviving_notes: set[str] = set()
    for part in reachable:
        if not (part.startswith("ppt/slides/") and part.endswith(".xml")):
            continue
        target = _notes_target_for(part, root)
        if not target:
            continue
        if part in doomed_slides:
            doomed_notes.add(target)
        else:
            surviving_notes.add(target)
    # A notes file that any surviving slide still references must NOT be pruned.
    doomed_notes -= surviving_notes

    # Media reachable from a doomed slide *only* is also doomed. Media
    # referenced by anything else survives.
    reachable_media_from_survivors: set[str] = set()

    def collect_media_from(part: str) -> None:
        rels_path = root / _rels_path_for(part)
        if not rels_path.is_file():
            return
        try:
            xml_root = ET.fromstring(rels_path.read_bytes())
        except ET.ParseError:
            return
        base = str(Path(part).parent.as_posix())
        for _rid, _rtype, target in _rels_targets(xml_root, base):
            if target.startswith("ppt/media/"):
                reachable_media_from_survivors.add(target)

    # Media is kept if any surviving (reachable, non-doomed) part references
    # it — slides, layouts, masters, themes, notes, charts, anything.
    for part in reachable:
        if part in doomed_slides or part in doomed_notes:
            continue
        collect_media_from(part)

    doomed_media: set[str] = set()
    media_dir = root / "ppt" / "media"
    if media_dir.is_dir():
        for media_file in media_dir.iterdir():
            archive = f"ppt/media/{media_file.name}"
            if archive not in reachable_media_from_survivors:
                doomed_media.add(archive)

    report = PruneReport(
        slides=sorted(doomed_slides),
        notes=sorted(doomed_notes),
        media=sorted(doomed_media),
    )

    if dry_run:
        return report

    for part in doomed_slides:
        _delete_part(root, part)
    for part in doomed_notes:
        _delete_part(root, part)
    for part in doomed_media:
        (root / part).unlink(missing_ok=True)

    report.presentation_rels = _drop_presentation_rels(root, doomed_slides)
    report.content_type_overrides = _drop_content_type_overrides(
        root,
        doomed_slides | doomed_notes | doomed_media,
    )
    return report


def _print_report(report: PruneReport, verb: str) -> None:
    print(f"{verb} {report.total_files} orphan file(s):")
    for group_name, entries in (
        ("slides", report.slides),
        ("notes", report.notes),
        ("media", report.media),
    ):
        for path in entries:
            print(f"  ({group_name}) {path}")
    if report.presentation_rels:
        print(f"{verb} {len(report.presentation_rels)} presentation rel(s):",
              ", ".join(report.presentation_rels))
    if report.content_type_overrides:
        print(f"{verb} {len(report.content_type_overrides)} content-type override(s):",
              ", ".join(report.content_type_overrides))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("root", type=Path,
                    help="path to the exploded tree (as produced by explode.py)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be removed without changing anything")
    ns = ap.parse_args(argv)

    try:
        report = prune_tree(ns.root, dry_run=ns.dry_run)
    except SystemExit:
        raise
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    _print_report(report, "would remove" if ns.dry_run else "removed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
