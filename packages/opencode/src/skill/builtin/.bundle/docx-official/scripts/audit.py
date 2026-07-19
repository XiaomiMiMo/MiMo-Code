#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["python-docx>=1.0", "lxml>=4.9"]
# ///
"""Report-style well-formedness inspection of a `.docx` file.

Alternate implementation notes:
    - Structured as a sequence of independent probes. Each probe returns a
      `Finding` (name + status + detail); the top-level runner prints them
      as a table so the caller sees exactly which class of check failed.
    - Probes short-circuit only for the archive-level failure — if the ZIP
      won't open, no per-part probe can run. Everything else fans out so a
      broken relationship doesn't hide a broken XML part.

Statuses:
    OK    — the check passed
    WARN  — the check found something suspicious but not fatal
    FAIL  — the check found a structural problem

Exit code is 0 if no FAIL findings, 1 otherwise. 2 for argument errors.

Usage:
    uv run audit.py <file.docx> [--json]
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Callable
from xml.etree import ElementTree as _stdet

_REQUIRED = ("[Content_Types].xml", "_rels/.rels", "word/document.xml")


@dataclass
class Finding:
    name: str
    status: str  # OK / WARN / FAIL
    detail: str = ""


def _probe_archive(path: Path) -> tuple[Finding, zipfile.ZipFile | None]:
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        return Finding("archive", "FAIL", str(exc)), None
    corrupt = zf.testzip()
    if corrupt is not None:
        zf.close()
        return Finding("archive", "FAIL", f"CRC error on {corrupt}"), None
    return Finding("archive", "OK"), zf


def _probe_required_parts(zf: zipfile.ZipFile) -> Finding:
    names = set(zf.namelist())
    missing = [name for name in _REQUIRED if name not in names]
    if missing:
        return Finding("required-parts", "FAIL",
                       "missing: " + ", ".join(missing))
    return Finding("required-parts", "OK")


def _probe_xml_wellformed(zf: zipfile.ZipFile) -> Finding:
    """Every .xml / .rels entry must parse as XML."""
    bad: list[str] = []
    for info in zf.infolist():
        suffix = Path(info.filename).suffix.lower()
        if suffix not in (".xml", ".rels"):
            continue
        try:
            _stdet.fromstring(zf.read(info))
        except _stdet.ParseError as exc:
            bad.append(f"{info.filename}: {exc}")
    if bad:
        return Finding("xml-wellformed", "FAIL",
                       f"{len(bad)} bad parts; first: " + bad[0])
    return Finding("xml-wellformed", "OK")


def _probe_python_docx(path: Path) -> Finding:
    try:
        import docx  # type: ignore
    except ImportError:
        return Finding("python-docx-load", "WARN", "python-docx not installed")
    try:
        docx.Document(str(path))
    except Exception as exc:
        return Finding("python-docx-load", "FAIL", str(exc))
    return Finding("python-docx-load", "OK")


def _probe_lxml_strict(zf: zipfile.ZipFile) -> Finding:
    try:
        from lxml import etree  # type: ignore
    except ImportError:
        return Finding("lxml-strict", "WARN", "lxml not installed")
    bad: list[str] = []
    for info in zf.infolist():
        suffix = Path(info.filename).suffix.lower()
        if suffix not in (".xml", ".rels"):
            continue
        try:
            etree.fromstring(zf.read(info))
        except etree.XMLSyntaxError as exc:
            bad.append(f"{info.filename}: {exc}")
    if bad:
        return Finding("lxml-strict", "FAIL",
                       f"{len(bad)} strict-parse failures; first: " + bad[0])
    return Finding("lxml-strict", "OK")


ProbeFn = Callable[[zipfile.ZipFile], Finding]
IN_ARCHIVE_PROBES: tuple[ProbeFn, ...] = (
    _probe_required_parts,
    _probe_xml_wellformed,
    _probe_lxml_strict,
)


def _collect(path: Path) -> list[Finding]:
    archive_finding, zf = _probe_archive(path)
    findings: list[Finding] = [archive_finding]
    if zf is None:
        return findings
    try:
        for probe in IN_ARCHIVE_PROBES:
            findings.append(probe(zf))
    finally:
        zf.close()
    findings.append(_probe_python_docx(path))
    return findings


def _render_table(findings: list[Finding]) -> str:
    lines = []
    width = max(len(f.name) for f in findings)
    for f in findings:
        marker = {"OK": "✓", "WARN": "!", "FAIL": "✗"}.get(f.status, "?")
        row = f"  [{marker}] {f.name:<{width}}  {f.status}"
        if f.detail:
            row += f"  — {f.detail}"
        lines.append(row)
    return "\n".join(lines)


def audit_file(path: Path, *, as_json: bool = False) -> int:
    if not path.is_file():
        sys.stderr.write(f"audit: {path} is not a file\n")
        return 2

    findings = _collect(path)

    if as_json:
        payload = {"file": str(path), "findings": [asdict(f) for f in findings]}
        json.dump(payload, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"auditing {path}")
        print(_render_table(findings))

    return 1 if any(f.status == "FAIL" for f in findings) else 0


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Report on the well-formedness of a .docx file."
    )
    parser.add_argument("file", type=Path, help="Target .docx file")
    parser.add_argument("--json", action="store_true",
                        help="Emit findings as JSON on stdout.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    return audit_file(args.file, as_json=args.json)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
