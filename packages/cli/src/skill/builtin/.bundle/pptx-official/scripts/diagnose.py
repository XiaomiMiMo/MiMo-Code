#!/usr/bin/env python3
"""Diagnose well-formedness problems in a .pptx file.

Runs a chain of independent checks, each of which yields zero or more
`Issue` records. The tool prints every issue it finds (so one broken
part doesn't hide five others) and exits non-zero when the list is
non-empty.

Checks performed:

    zip           the archive is a real, non-truncated ZIP
    required      the three parts that every PresentationML package must
                  carry are present
    xml           every `.xml` / `.rels` part parses as XML
    pptx-lib      python-pptx can open the file end-to-end (skipped if
                  python-pptx is not installed)
    strict-xml    lxml re-parses every part (catches subtle namespace and
                  entity issues that minidom silently ignores; skipped if
                  lxml is not installed)

Usage:
    python diagnose.py <file.pptx>

Exit codes:
    0   no issues
    1   at least one issue reported
    2   usage error / target missing
"""
from __future__ import annotations

import argparse
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Iterator
from xml.etree import ElementTree as ET

MUST_HAVE = (
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
)


@dataclass(frozen=True)
class Issue:
    check: str
    detail: str

    def __str__(self) -> str:
        return f"[{self.check}] {self.detail}"


Check = Callable[[Path], Iterator[Issue]]


def check_zip(path: Path) -> Iterator[Issue]:
    try:
        with zipfile.ZipFile(path) as zf:
            corrupt = zf.testzip()
            if corrupt is not None:
                yield Issue("zip", f"corrupt entry: {corrupt}")
    except zipfile.BadZipFile as exc:
        yield Issue("zip", f"not a valid ZIP file: {exc}")


def check_required(path: Path) -> Iterator[Issue]:
    try:
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
    except zipfile.BadZipFile:
        return
    for required in MUST_HAVE:
        if required not in names:
            yield Issue("required", f"missing part: {required}")


def check_xml(path: Path) -> Iterator[Issue]:
    try:
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                if Path(info.filename).suffix.lower() not in {".xml", ".rels"}:
                    continue
                try:
                    ET.fromstring(zf.read(info))
                except ET.ParseError as exc:
                    yield Issue("xml", f"{info.filename}: {exc}")
    except zipfile.BadZipFile:
        return  # already reported by check_zip


def check_pptx_library(path: Path) -> Iterator[Issue]:
    try:
        from pptx import Presentation  # type: ignore
    except ImportError:
        return
    try:
        Presentation(str(path))
    except Exception as exc:
        yield Issue("pptx-lib", f"python-pptx could not open: {exc}")


def check_strict_xml(path: Path) -> Iterator[Issue]:
    try:
        from lxml import etree  # type: ignore
    except ImportError:
        return
    try:
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                if Path(info.filename).suffix.lower() not in {".xml", ".rels"}:
                    continue
                try:
                    etree.fromstring(zf.read(info))
                except etree.XMLSyntaxError as exc:
                    yield Issue("strict-xml", f"{info.filename}: {exc}")
    except zipfile.BadZipFile:
        return


CHECKS: tuple[Check, ...] = (
    check_zip,
    check_required,
    check_xml,
    check_pptx_library,
    check_strict_xml,
)


def collect(path: Path, checks: Iterable[Check] = CHECKS) -> list[Issue]:
    issues: list[Issue] = []
    for check in checks:
        issues.extend(check(path))
    return issues


def diagnose(path: Path) -> int:
    if not path.is_file():
        print(f"error: {path} is not a file", file=sys.stderr)
        return 2

    issues = collect(path)
    if issues:
        print(f"FAIL {path}", file=sys.stderr)
        for issue in issues:
            print(f"  {issue}", file=sys.stderr)
        return 1
    print(f"OK {path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("file", type=Path)
    ns = ap.parse_args(argv)
    return diagnose(ns.file)


if __name__ == "__main__":
    sys.exit(main())
